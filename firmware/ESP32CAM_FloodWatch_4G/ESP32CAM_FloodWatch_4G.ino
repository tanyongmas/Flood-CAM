/**
 * ======================================================================================
 * ระบบกล้องตรวจวัดอุทกภัย เทศบาลตำบลตันหยงมัส (ESP32-CAM)
 * โหมดกรณีที่ 2: เครือข่าย 4G วงนอก (4G Router Cloud Snapshot Relay & Remote Wake-up)
 * --------------------------------------------------------------------------------------
 * จุดตรวจ: ถนนประชาสามัคคี ชุมชนตลาดกลางผลไม้ (CAM-TYM-01)
 * เครือข่ายเริ่มต้น (วงนอก): SSID: "199X" | รหัสผ่าน: "5910110106"
 * --------------------------------------------------------------------------------------
 * คุณสมบัติ:
 * 1. On-Demand Cloud Snapshot Relay ผ่าน Google Apps Script (ทลายข้อจำกัด 4G CGNAT)
 * 2. Standby ประหยัดพลังงานแบตเตอรี่โซลาร์เซลล์ และไม่สิ้นเปลือง 4G Data
 * 3. รองรับการรับคำสั่งเปลี่ยน Wi-Fi ทางไกลผ่าน Google Apps Script และหน้าเว็บ Admin
 * 4. พอร์ต 80, 81, 8554 รองรับการดูในพื้นที่หน้างานพร้อมกัน
 * ======================================================================================
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <Preferences.h>
#include <base64.h>
#include "soc/soc.h"
#include "soc/rtc_cntl_reg.h"

// Micro-RTSP Libraries
#include "OV2640.h"
#include "OV2640Streamer.h"
#include "CRtspSession.h"

SemaphoreHandle_t camMutex = NULL;

// ======================= [ค่าเริ่มต้นเครือข่าย 4G วงนอก] =======================
const char* DEFAULT_WIFI_SSID     = "199X";
const char* DEFAULT_WIFI_PASSWORD = "5910110106";

String currentSSID = DEFAULT_WIFI_SSID;
String currentPASS = DEFAULT_WIFI_PASSWORD;

// รหัสประจำตัวกล้อง
const char* CAMERA_ID     = "CAM-TYM-01";
const char* LOCATION_NAME = "ถนนประชาสามัคคี ชุมชนตลาดกลางผลไม้ (4G วงนอก 199X)";

// Google Apps Script
const char* GAS_EXEC_URL  = "https://script.google.com/macros/s/AKfycbwiE9fu8R9GRQ9LJoD4UXnz3K7PKV6Nip3JGMzVVOznZR0wvq5f7oHEwEfuIuh_F6in/exec";

// ฮาร์ดแวร์เซนเซอร์
#define ULTRASONIC_TRIG_PIN 13
#define ULTRASONIC_ECHO_PIN 12
#define BATTERY_ADC_PIN     33
#define LED_FLASH_PIN       4

OV2640 cam;
WebServer controlServer(80);
WiFiServer mjpegServer(81);
WiFiServer rtspServer(8554);
CStreamer *streamer = NULL;
Preferences preferences;

// สถานะการสตรีมและพลังงาน
volatile bool isStreamingRequested = false;
unsigned long lastStreamRequestTime = 0;
#define STREAM_AUTO_OFF_SEC 180

float currentWaterLevelCm = 0.0;
float currentBatteryVolt = 4.12;

void loadWiFiPreferences();
void saveWiFiPreferences(String ssid, String pass);
void setupWiFi();
void handleRTSP();
void handleMJPEGStream();
void setupControlRoutes();
float readWaterLevel();
float readBatteryVoltage();
void setFlashLED(int brightness);
void uploadSnapshotToCloud();
void cloudSyncTask(void *pvParameters);

void setup() {
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);

  Serial.begin(115200);
  delay(500);
  Serial.println("\n\n========================================================");
  Serial.printf("เทศบาลตำบลตันหยงมัส - ESP32-CAM [4G Router วงนอก]\n");
  Serial.printf("จุดติดตั้ง: %s\n", LOCATION_NAME);
  Serial.println("========================================================");

  ledcSetup(0, 5000, 8);
  ledcAttachPin(LED_FLASH_PIN, 0);
  setFlashLED(0);

  pinMode(ULTRASONIC_TRIG_PIN, OUTPUT);
  pinMode(ULTRASONIC_ECHO_PIN, INPUT);

  camMutex = xSemaphoreCreateMutex();

  esp_err_t err = cam.init(esp32cam_aithinker_config);
  if (err != ESP_OK) {
    Serial.printf("[Error] Camera init failed: 0x%x\n", err);
    delay(2000);
    ESP.restart();
  }
  Serial.println("[OK] Camera Initialized.");

  loadWiFiPreferences();
  setupWiFi();

  setupControlRoutes();
  controlServer.begin();
  Serial.printf(">> Control Server Ready : http://%s/\n", WiFi.localIP().toString().c_str());

  mjpegServer.begin();
  Serial.printf(">> HTTP MJPEG Stream    : http://%s:81/stream\n", WiFi.localIP().toString().c_str());

  rtspServer.begin();
  streamer = new OV2640Streamer(&cam);
  Serial.printf(">> RTSP Video Stream    : rtsp://%s:8554/mjpeg/1\n", WiFi.localIP().toString().c_str());

  // Cloud Sync Task บน Core 0
  xTaskCreatePinnedToCore(cloudSyncTask, "CloudSync", 10240, NULL, 1, NULL, 0);
}

void loop() {
  controlServer.handleClient();

  if (isStreamingRequested) {
    handleMJPEGStream();
    handleRTSP();

    if (millis() - lastStreamRequestTime >= (STREAM_AUTO_OFF_SEC * 1000UL)) {
      Serial.println("[Power] Stream session timed out. Entering Standby Mode.");
      isStreamingRequested = false;
      setFlashLED(0);
    }
  } else {
    WiFiClient rtspClient = rtspServer.accept();
    if (rtspClient) {
      isStreamingRequested = true;
      lastStreamRequestTime = millis();
      streamer->addSession(new WiFiClient(rtspClient));
    }
    delay(10);
  }
}

void loadWiFiPreferences() {
  preferences.begin("cam_wifi", false);
  String savedSSID = preferences.getString("ssid", "");
  String savedPASS = preferences.getString("pass", "");
  preferences.end();

  if (savedSSID.length() > 0) {
    currentSSID = savedSSID;
    currentPASS = savedPASS;
    Serial.printf("[Storage] Loaded custom Wi-Fi: %s\n", currentSSID.c_str());
  } else {
    currentSSID = DEFAULT_WIFI_SSID;
    currentPASS = DEFAULT_WIFI_PASSWORD;
    Serial.printf("[Storage] Using default 4G Wi-Fi: %s\n", currentSSID.c_str());
  }
}

void saveWiFiPreferences(String ssid, String pass) {
  preferences.begin("cam_wifi", false);
  preferences.putString("ssid", ssid);
  preferences.putString("pass", pass);
  preferences.end();
  currentSSID = ssid;
  currentPASS = pass;
  Serial.printf("[Storage] Saved new Wi-Fi: %s\n", ssid.c_str());
}

void setupControlRoutes() {
  // ตั้งค่าเปลี่ยน Wi-Fi ของกล้อง (/setwifi?ssid=...&pass=...)
  controlServer.on("/setwifi", HTTP_GET, []() {
    controlServer.sendHeader("Access-Control-Allow-Origin", "*");
    if (controlServer.hasArg("ssid")) {
      String newSsid = controlServer.arg("ssid");
      String newPass = controlServer.hasArg("pass") ? controlServer.arg("pass") : "";
      saveWiFiPreferences(newSsid, newPass);
      
      String json = "{\"status\":\"ok\",\"message\":\"บันทึก Wi-Fi ใหม่สำเร็จ กำลังเชื่อมต่อ\",\"ssid\":\"" + newSsid + "\"}";
      controlServer.send(200, "application/json", json);
      delay(1000);
      setupWiFi();
    } else {
      controlServer.send(400, "application/json", "{\"error\":\"Missing ssid\"}");
    }
  });

  controlServer.on("/wake", HTTP_GET, []() {
    isStreamingRequested = true;
    lastStreamRequestTime = millis();
    controlServer.sendHeader("Access-Control-Allow-Origin", "*");
    controlServer.send(200, "application/json", "{\"status\":\"active\",\"stream_port\":81}");
  });

  controlServer.on("/stop", HTTP_GET, []() {
    isStreamingRequested = false;
    setFlashLED(0);
    controlServer.sendHeader("Access-Control-Allow-Origin", "*");
    controlServer.send(200, "application/json", "{\"status\":\"stopped\"}");
  });

  controlServer.on("/flash", HTTP_GET, []() {
    controlServer.sendHeader("Access-Control-Allow-Origin", "*");
    if (controlServer.hasArg("val")) {
      int val = controlServer.arg("val").toInt();
      setFlashLED(val);
      controlServer.send(200, "application/json", "{\"flash\":" + String(val) + "}");
    } else {
      controlServer.send(400, "text/plain", "Missing val");
    }
  });

  controlServer.on("/capture", HTTP_GET, []() {
    if (camMutex != NULL && xSemaphoreTake(camMutex, pdMS_TO_TICKS(150)) == pdTRUE) {
      cam.run();
      WiFiClient client = controlServer.client();
      String response = "HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: *\r\nContent-Type: image/jpeg\r\n\r\n";
      controlServer.sendContent(response);
      client.write((char *)cam.getfb(), cam.getSize());
      xSemaphoreGive(camMutex);
    } else {
      controlServer.send(503, "text/plain", "Camera busy");
    }
  });

  controlServer.on("/status", HTTP_GET, []() {
    float water = readWaterLevel();
    float batt = readBatteryVoltage();
    String json = "{\"camera_id\":\"" + String(CAMERA_ID) + "\",";
    json += "\"mode\":\"4g_cloud\",";
    json += "\"ssid\":\"" + currentSSID + "\",";
    json += "\"streaming\":" + String(isStreamingRequested ? "true" : "false") + ",";
    json += "\"water_level\":" + String(water, 1) + ",";
    json += "\"battery\":" + String(batt, 2) + ",";
    json += "\"rssi\":" + String(WiFi.RSSI()) + "}";
    controlServer.sendHeader("Access-Control-Allow-Origin", "*");
    controlServer.send(200, "application/json", json);
  });
}

void handleMJPEGStream() {
  WiFiClient client = mjpegServer.available();
  if (!client) return;

  isStreamingRequested = true;
  lastStreamRequestTime = millis();

  client.println("HTTP/1.1 200 OK");
  client.println("Access-Control-Allow-Origin: *");
  client.println("Content-Type: multipart/x-mixed-replace; boundary=--frame");
  client.println();

  while (client.connected() && isStreamingRequested) {
    lastStreamRequestTime = millis();
    if (camMutex != NULL && xSemaphoreTake(camMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
      cam.run();
      client.println("--frame");
      client.println("Content-Type: image/jpeg");
      client.printf("Content-Length: %u\r\n\r\n", cam.getSize());
      client.write((char *)cam.getfb(), cam.getSize());
      client.println();
      xSemaphoreGive(camMutex);
    }
    delay(40);
  }
  client.stop();
}

void handleRTSP() {
  uint32_t msecPerFrame = 100;
  static uint32_t lastimage = 0;
  uint32_t now = millis();

  WiFiClient rtspClient = rtspServer.accept();
  if (rtspClient) {
    isStreamingRequested = true;
    lastStreamRequestTime = millis();
    streamer->addSession(new WiFiClient(rtspClient));
  }

  streamer->handleRequests(0);
  if (streamer->anySessions()) {
    lastStreamRequestTime = millis();
    if (now > lastimage + msecPerFrame || now < lastimage) {
      streamer->streamImage(now);
      lastimage = now;
    }
  }
}

void uploadSnapshotToCloud() {
  if (WiFi.status() != WL_CONNECTED || String(GAS_EXEC_URL).indexOf("http") != 0) return;

  if (camMutex == NULL) return;
  if (xSemaphoreTake(camMutex, pdMS_TO_TICKS(200)) != pdTRUE) return;

  cam.run();
  uint8_t* fbBuf = cam.getfb();
  size_t fbLen = cam.getSize();

  if (!fbBuf || fbLen == 0) {
    xSemaphoreGive(camMutex);
    return;
  }

  String imgBase64 = base64::encode(fbBuf, fbLen);
  xSemaphoreGive(camMutex);

  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(6);

  HTTPClient http;
  http.setTimeout(8000);
  http.setReuse(false);

  if (http.begin(client, GAS_EXEC_URL)) {
    http.addHeader("Content-Type", "application/json");
    String payload = "{\"action\":\"uploadSnapshot\",\"camId\":\"" + String(CAMERA_ID) + "\",\"image\":\"" + imgBase64 + "\"}";
    int httpCode = http.POST(payload);
    if (httpCode == HTTP_CODE_OK || httpCode == 302) {
      Serial.printf("[Cloud Relay] Frame uploaded (%u KB, code %d)\n", (unsigned int)(fbLen / 1024), httpCode);
    }
    http.end();
  }
  client.stop();
}

void cloudSyncTask(void *pvParameters) {
  unsigned long lastTelemetrySync = 0;
  unsigned long lastCommandCheck = 0;
  unsigned long lastSnapshotPush = 0;
  unsigned long lastWifiRetry = 0;

  for (;;) {
    vTaskDelay(500 / portTICK_PERIOD_MS);

    if (WiFi.status() != WL_CONNECTED) {
      if (millis() - lastWifiRetry >= 10000) {
        lastWifiRetry = millis();
        Serial.println("[Wi-Fi Watchdog] Connection dropped. Reconnecting to 4G Wi-Fi...");
        WiFi.disconnect();
        WiFi.reconnect();
      }
      continue;
    }

    if (String(GAS_EXEC_URL).indexOf("http") != 0) continue;

    unsigned long now = millis();

    // 1. ส่ง Telemetry ทุก 30 วินาที
    if (now - lastTelemetrySync >= 30000 || lastTelemetrySync == 0) {
      lastTelemetrySync = now;
      float water = readWaterLevel();
      float batt = readBatteryVoltage();

      WiFiClientSecure client;
      client.setInsecure();
      client.setTimeout(4);

      HTTPClient http;
      http.setTimeout(5000);
      http.setReuse(false);

      String url = String(GAS_EXEC_URL)
                 + "?action=reportStatus"
                 + "&camId=" + String(CAMERA_ID)
                 + "&waterLevel=" + String(water, 1)
                 + "&battery=" + String(batt, 2)
                 + "&ip=" + WiFi.localIP().toString()
                 + "&rssi=" + String(WiFi.RSSI());

      if (http.begin(client, url)) {
        http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
        int res = http.GET();
        if (res == HTTP_CODE_OK || res == 302) {
          String payload = http.getString();
          if (payload.indexOf("wake_stream") >= 0) {
            isStreamingRequested = true;
            lastStreamRequestTime = millis();
            Serial.println("[Cloud Trigger] Wake stream command received via Telemetry!");
          }
        }
        http.end();
      }
      client.stop();
    }

    // 2. ตรวจสอบคำสั่ง (Wake หรือคำสั่งเปลี่ยน Wi-Fi ทางไกล) ทุก 3.5 วินาที
    if (!isStreamingRequested) {
      if (now - lastCommandCheck >= 3500) {
        lastCommandCheck = now;

        WiFiClientSecure client;
        client.setInsecure();
        client.setTimeout(4);

        HTTPClient http;
        http.setTimeout(5000);
        http.setReuse(false);

        String url = String(GAS_EXEC_URL) + "?action=checkCommand&camId=" + String(CAMERA_ID);
        if (http.begin(client, url)) {
          http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
          int res = http.GET();
          if (res == HTTP_CODE_OK || res == 302) {
            String payload = http.getString();
            
            // เช็คคำสั่งปลุกสตรีม
            if (payload.indexOf("wake_stream") >= 0) {
              isStreamingRequested = true;
              lastStreamRequestTime = millis();
              Serial.println("[Cloud Trigger] Remote Wake-up Command received!");
            }
            
            // เช็คคำสั่งเปลี่ยน Wi-Fi ทางไกล (setwifi:<ssid>:<pass>)
            int wifiIdx = payload.indexOf("setwifi:");
            if (wifiIdx >= 0) {
              String cmdPart = payload.substring(wifiIdx + 8);
              int colonIdx = cmdPart.indexOf(":");
              int quoteIdx = cmdPart.indexOf("\"");
              if (colonIdx > 0) {
                String newSsid = cmdPart.substring(0, colonIdx);
                String newPass = (quoteIdx > colonIdx) ? cmdPart.substring(colonIdx + 1, quoteIdx) : cmdPart.substring(colonIdx + 1);
                newPass.trim();
                newSsid.trim();
                Serial.printf("[Cloud Trigger] Received remote Wi-Fi change: SSID=%s\n", newSsid.c_str());
                saveWiFiPreferences(newSsid, newPass);
                delay(1000);
                setupWiFi();
              }
            }
          }
          http.end();
        }
        client.stop();
      }
    }

    // 3. เมื่ออยู่ในสถานะสตรีม -> อัปโหลดเฟรมภาพขึ้น Cloud ทุก 2.0 วินาที
    if (isStreamingRequested) {
      if (now - lastSnapshotPush >= 2000) {
        lastSnapshotPush = now;
        uploadSnapshotToCloud();
      }
    }
  }
}

void setFlashLED(int brightness) {
  int val = constrain(brightness, 0, 255);
  ledcWrite(0, val);
}

float readWaterLevel() {
  digitalWrite(ULTRASONIC_TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(ULTRASONIC_TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(ULTRASONIC_TRIG_PIN, LOW);

  long duration = pulseIn(ULTRASONIC_ECHO_PIN, HIGH, 20000);
  if (duration > 0) {
    float distanceCm = duration * 0.034 / 2.0;
    float waterCm = 300.0 - distanceCm;
    if (waterCm < 0) waterCm = 0;
    currentWaterLevelCm = waterCm;
  }
  return currentWaterLevelCm;
}

float readBatteryVoltage() {
  int raw = analogRead(BATTERY_ADC_PIN);
  float volt = (raw / 4095.0) * 3.3 * 2.0;
  if (volt > 0.5) currentBatteryVolt = volt;
  return currentBatteryVolt;
}

void setupWiFi() {
  Serial.printf("\n[Wi-Fi] Connecting to: %s ", currentSSID.c_str());
  WiFi.disconnect(true);
  delay(100);
  WiFi.mode(WIFI_STA);
  WiFi.begin(currentSSID.c_str(), currentPASS.c_str());

  int retries = 0;
  while (WiFi.status() != WL_CONNECTED && retries < 25) {
    delay(400);
    Serial.print(".");
    retries++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[OK] Wi-Fi Connected!");
    Serial.printf("IP Address : %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\n[Warning] Wi-Fi Connection failed. Please check SSID/Password.");
  }
}
