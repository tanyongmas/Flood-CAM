/**
 * ======================================================================================
 * ระบบกล้องตรวจวัดอุทกภัย เทศบาลตำบลตันหยงมัส (ESP32-CAM)
 * โหมดกรณีที่ 1: วงแลนเดียวกัน (Local LAN Direct High-FPS RTSP & MJPEG Streamer)
 * --------------------------------------------------------------------------------------
 * จุดตรวจ: ถนนประชาสามัคคี ชุมชนตลาดกลางผลไม้ (CAM-TYM-01)
 * เครือข่ายเริ่มต้น (วงใน): SSID: "TMSTDUIO" | รหัสผ่าน: "026830TM"
 * --------------------------------------------------------------------------------------
 * คุณสมบัติ:
 * 1. สตรีมภาพสดระดับ High-FPS (20-25 FPS) ลื่นไหล ไร้ความหน่วงในวงแลนเดียวกัน
 * 2. พอร์ต 8554: RTSP Server (rtsp://<IP>:8554/mjpeg/1) สำหรับ NVR / VLC / OBS
 * 3. พอร์ต 81: Dedicated HTTP MJPEG Stream (http://<IP>:81/stream)
 * สำหรับดูบนเบราว์เซอร์
 * 4. พอร์ต 80: Web API ควบคุมไฟแฟลช, เซนเซอร์, และ "ตั้งค่าเปลี่ยน Wi-Fi ผ่านหน้าเว็บ"
 * 5. รองรับการบันทึก Wi-Fi ลงใน Flash Memory (Preferences) ไม่หายแม้ไฟดับ
 * ======================================================================================
 */

#include "soc/rtc_cntl_reg.h"
#include "soc/soc.h"
#include <HTTPClient.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <base64.h>

// Micro-RTSP Libraries
#include "CRtspSession.h"
#include "OV2640.h"
#include "OV2640Streamer.h"

// ======================= [ค่าเริ่มต้นเครือข่าย Wi-Fi วงเดียวกัน]
// =======================
const char *DEFAULT_WIFI_SSID = "TMSTUDIO";
const char *DEFAULT_WIFI_PASSWORD = "026830TM";

// ข้อมูล Wi-Fi ที่ใช้งานจริง (ดึงจาก Flash Memory หรือใช้ค่าเริ่มต้น)
String currentSSID = DEFAULT_WIFI_SSID;
String currentPASS = DEFAULT_WIFI_PASSWORD;

// รหัสประจำตัวกล้อง
const char *CAMERA_ID = "CAM-TYM-01";
const char *LOCATION_NAME = "ถนนประชาสามัคคี ชุมชนตลาดกลางผลไม้ (วงใน TMSTDUIO)";

// Google Apps Script สำหรับรายงานระดับน้ำขึ้น Cloud
const char *GAS_EXEC_URL = "https://script.google.com/macros/s/"
                           "AKfycbwiE9fu8R9GRQ9LJoD4UXnz3K7PKV6Nip3JGMzVVOznZR0"
                           "wvq5f7oHEwEfuIuh_F6in/exec";

// ฮาร์ดแวร์เซนเซอร์
#define ULTRASONIC_TRIG_PIN 13
#define ULTRASONIC_ECHO_PIN 12
#define BATTERY_ADC_PIN 33
#define LED_FLASH_PIN 4

// อินสแตนซ์โมดูล
OV2640 cam;
WebServer controlServer(80);
WiFiServer mjpegServer(81);
WiFiServer rtspServer(8554);
CStreamer *streamer = NULL;
Preferences preferences;
SemaphoreHandle_t camMutex = NULL;

// โทรมาตร
float currentWaterLevelCm = 0.0;
float currentBatteryVolt = 4.12;

// ประกาศฟังก์ชัน
void loadWiFiPreferences();
void saveWiFiPreferences(String ssid, String pass);
void setupWiFi();
void handleRTSP();
void handleMJPEGStream();
void setupControlRoutes();
float readWaterLevel();
float readBatteryVoltage();
void setFlashLED(int brightness);
void telemetryTask(void *pvParameters);

void setup() {
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0); // ปิด Brownout Detector ป้องกันไฟตก

  Serial.begin(115200);
  delay(500);
  Serial.println(
      "\n\n========================================================");
  Serial.printf("เทศบาลตำบลตันหยงมัส - ESP32-CAM [วงใน Local LAN]\n");
  Serial.printf("จุดติดตั้ง: %s\n", LOCATION_NAME);
  Serial.println("========================================================");

  // ตั้งค่า Flash LED
  ledcSetup(0, 5000, 8);
  ledcAttachPin(LED_FLASH_PIN, 0);
  setFlashLED(0);

  // เซนเซอร์วัดระดับน้ำ
  pinMode(ULTRASONIC_TRIG_PIN, OUTPUT);
  pinMode(ULTRASONIC_ECHO_PIN, INPUT);

  camMutex = xSemaphoreCreateMutex();

  // 1. เริ่มต้นกล้อง OV2640
  esp_err_t err = cam.init(esp32cam_aithinker_config);
  if (err != ESP_OK) {
    Serial.printf("[Error] Camera init failed: 0x%x\n", err);
    delay(2000);
    ESP.restart();
  }
  Serial.println("[OK] Camera Initialized.");

  // 2. โหลดและเชื่อมต่อ Wi-Fi
  loadWiFiPreferences();
  setupWiFi();

  // 3. เริ่มต้นพอร์ต 80 (Control & Web Settings)
  setupControlRoutes();
  controlServer.begin();
  Serial.printf(">> Control Server Ready : http://%s/\n",
                WiFi.localIP().toString().c_str());

  // 4. เริ่มต้นพอร์ต 81 (HTTP MJPEG Direct Stream)
  mjpegServer.begin();
  Serial.printf(">> HTTP MJPEG Stream    : http://%s:81/stream (25 FPS)\n",
                WiFi.localIP().toString().c_str());

  // 5. เริ่มต้นพอร์ต 8554 (RTSP Stream Server)
  rtspServer.begin();
  streamer = new OV2640Streamer(&cam);
  Serial.printf(">> RTSP Video Stream    : rtsp://%s:8554/mjpeg/1\n",
                WiFi.localIP().toString().c_str());

  // 6. รัน Telemetry Task บน Core 0 รายงานระดับน้ำ
  xTaskCreatePinnedToCore(telemetryTask, "TelemetrySync", 8192, NULL, 1, NULL,
                          0);
}

void loop() {
  controlServer.handleClient();
  handleMJPEGStream();
  handleRTSP();
}

// -------------------------------------------------------------
// โหลดและบันทึกการตั้งค่า Wi-Fi ลงใน Flash Memory (Preferences)
// -------------------------------------------------------------
void loadWiFiPreferences() {
  preferences.begin("cam_wifi", false);
  String savedSSID = preferences.getString("ssid", "");
  String savedPASS = preferences.getString("pass", "");
  preferences.end();

  if (savedSSID.length() > 0) {
    currentSSID = savedSSID;
    currentPASS = savedPASS;
    Serial.printf("[Storage] Loaded custom Wi-Fi from Flash: %s\n",
                  currentSSID.c_str());
  } else {
    currentSSID = DEFAULT_WIFI_SSID;
    currentPASS = DEFAULT_WIFI_PASSWORD;
    Serial.printf("[Storage] Using default LAN Wi-Fi: %s\n",
                  currentSSID.c_str());
  }
}

void saveWiFiPreferences(String ssid, String pass) {
  preferences.begin("cam_wifi", false);
  preferences.putString("ssid", ssid);
  preferences.putString("pass", pass);
  preferences.end();
  currentSSID = ssid;
  currentPASS = pass;
  Serial.printf("[Storage] Saved new Wi-Fi to Flash: %s\n", ssid.c_str());
}

// -------------------------------------------------------------
// จัดการคำสั่งบนพอร์ต 80 (ควบคุมและเปลี่ยน Wi-Fi ผ่านหน้าเว็บ)
// -------------------------------------------------------------
void setupControlRoutes() {
  // ตั้งค่าเปลี่ยน Wi-Fi ของกล้องผ่านหน้าเว็บ Admin (/setwifi?ssid=...&pass=...)
  controlServer.on("/setwifi", HTTP_GET, []() {
    controlServer.sendHeader("Access-Control-Allow-Origin", "*");
    if (controlServer.hasArg("ssid")) {
      String newSsid = controlServer.arg("ssid");
      String newPass =
          controlServer.hasArg("pass") ? controlServer.arg("pass") : "";

      saveWiFiPreferences(newSsid, newPass);

      String json = "{\"status\":\"ok\",\"message\":\"บันทึก Wi-Fi ใหม่สำเร็จ "
                    "กำลังเชื่อมต่อใหม่\",\"ssid\":\"" +
                    newSsid + "\"}";
      controlServer.send(200, "application/json", json);

      delay(1000);
      setupWiFi(); // ทำการ Reconnect ไปยังเครือข่ายใหม่ทันที
    } else {
      controlServer.send(400, "application/json",
                         "{\"error\":\"Missing ssid parameter\"}");
    }
  });

  // คืนค่า Wi-Fi กลับเป็นค่าเริ่มต้นโรงงาน (TMSTUDIO)
  controlServer.on("/resetwifi", HTTP_GET, []() {
    controlServer.sendHeader("Access-Control-Allow-Origin", "*");
    preferences.begin("cam_wifi", false);
    preferences.clear();
    preferences.end();
    currentSSID = DEFAULT_WIFI_SSID;
    currentPASS = DEFAULT_WIFI_PASSWORD;
    controlServer.send(200, "application/json",
                       "{\"status\":\"ok\",\"message\":\"รีเซ็ต Wi-Fi เป็นค่าเริ่มต้น "
                       "(TMSTUDIO) เรียบร้อย\"}");
    delay(1000);
    setupWiFi();
  });

  // ปรับความสว่าง Flash LED (Instant 5ms Response)
  controlServer.on("/flash", HTTP_GET, []() {
    controlServer.sendHeader("Access-Control-Allow-Origin", "*");
    if (controlServer.hasArg("val")) {
      int val = controlServer.arg("val").toInt();
      setFlashLED(val);
      controlServer.send(200, "application/json",
                         "{\"flash\":" + String(val) + "}");
    } else {
      controlServer.send(400, "text/plain", "Missing val");
    }
  });

  // ถ่ายภาพ 1 เฟรม
  controlServer.on("/capture", HTTP_GET, []() {
    if (camMutex != NULL &&
        xSemaphoreTake(camMutex, pdMS_TO_TICKS(150)) == pdTRUE) {
      cam.run();
      WiFiClient client = controlServer.client();
      String response = "HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: "
                        "*\r\nContent-Type: image/jpeg\r\n\r\n";
      controlServer.sendContent(response);
      client.write((char *)cam.getfb(), cam.getSize());
      xSemaphoreGive(camMutex);
    } else {
      controlServer.send(503, "text/plain", "Camera busy");
    }
  });

  // ตรวจสอบสถานะกล้อง
  controlServer.on("/status", HTTP_GET, []() {
    float water = readWaterLevel();
    float batt = readBatteryVoltage();
    String json = "{\"camera_id\":\"" + String(CAMERA_ID) + "\",";
    json += "\"mode\":\"local_lan\",";
    json += "\"ssid\":\"" + currentSSID + "\",";
    json += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
    json += "\"rtsp_url\":\"rtsp://" + WiFi.localIP().toString() +
            ":8554/mjpeg/1\",";
    json +=
        "\"mjpeg_url\":\"http://" + WiFi.localIP().toString() + ":81/stream\",";
    json += "\"water_level\":" + String(water, 1) + ",";
    json += "\"battery\":" + String(batt, 2) + ",";
    json += "\"rssi\":" + String(WiFi.RSSI()) + "}";
    controlServer.sendHeader("Access-Control-Allow-Origin", "*");
    controlServer.send(200, "application/json", json);
  });

  // รีบูตกล้อง
  controlServer.on("/reboot", HTTP_GET, []() {
    controlServer.sendHeader("Access-Control-Allow-Origin", "*");
    controlServer.send(200, "application/json", "{\"status\":\"rebooting\"}");
    delay(1000);
    ESP.restart();
  });

  controlServer.on("/", HTTP_GET, []() {
    controlServer.sendHeader("Access-Control-Allow-Origin", "*");
    String html = "<h2>ESP32-CAM Flood Watch (Local LAN)</h2>";
    html += "<p><b>Connected SSID:</b> " + currentSSID + " (" +
            WiFi.localIP().toString() + ")</p>";
    html += "<p><b>RTSP Stream:</b> rtsp://" + WiFi.localIP().toString() +
            ":8554/mjpeg/1</p>";
    html +=
        "<p><b>MJPEG Stream:</b> <a href='/stream' target='_blank'>http://" +
        WiFi.localIP().toString() + ":81/stream</a></p>";
    controlServer.send(200, "text/html", html);
  });
}

// -------------------------------------------------------------
// สตรีมภาพสด MJPEG บนพอร์ต 81 (25 FPS ลื่นไหลในวงแลน)
// -------------------------------------------------------------
void handleMJPEGStream() {
  WiFiClient client = mjpegServer.available();
  if (!client)
    return;

  client.println("HTTP/1.1 200 OK");
  client.println("Access-Control-Allow-Origin: *");
  client.println("Content-Type: multipart/x-mixed-replace; boundary=--frame");
  client.println();

  while (client.connected()) {
    if (camMutex != NULL &&
        xSemaphoreTake(camMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
      cam.run();
      client.println("--frame");
      client.println("Content-Type: image/jpeg");
      client.printf("Content-Length: %u\r\n\r\n", cam.getSize());
      client.write((char *)cam.getfb(), cam.getSize());
      client.println();
      xSemaphoreGive(camMutex);
    }
    delay(40); // ~25 FPS
  }
  client.stop();
}

// -------------------------------------------------------------
// สตรีม RTSP บนพอร์ต 8554
// -------------------------------------------------------------
void handleRTSP() {
  uint32_t msecPerFrame = 100; // ~10 FPS
  static uint32_t lastimage = 0;
  uint32_t now = millis();

  WiFiClient rtspClient = rtspServer.accept();
  if (rtspClient) {
    streamer->addSession(new WiFiClient(rtspClient));
  }

  streamer->handleRequests(0);
  if (streamer->anySessions()) {
    if (now > lastimage + msecPerFrame || now < lastimage) {
      streamer->streamImage(now);
      lastimage = now;
    }
  }
}

// -------------------------------------------------------------
// Background Telemetry Task บน Core 0 (รายงานระดับน้ำขึ้น Cloud)
// -------------------------------------------------------------
void telemetryTask(void *pvParameters) {
  for (;;) {
    vTaskDelay(30000 / portTICK_PERIOD_MS); // ซิงค์ทุก 30 วินาที

    if (WiFi.status() == WL_CONNECTED &&
        String(GAS_EXEC_URL).indexOf("http") == 0) {
      float water = readWaterLevel();
      float batt = readBatteryVoltage();

      WiFiClientSecure client;
      client.setInsecure();
      client.setTimeout(4);

      HTTPClient http;
      http.setTimeout(5000);
      http.setReuse(false);

      String url =
          String(GAS_EXEC_URL) + "?action=reportStatus" +
          "&camId=" + String(CAMERA_ID) + "&waterLevel=" + String(water, 1) +
          "&battery=" + String(batt, 2) + "&ip=" + WiFi.localIP().toString() +
          "&rssi=" + String(WiFi.RSSI());

      if (http.begin(client, url)) {
        http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
        http.GET();
        http.end();
      }
      client.stop();
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
    if (waterCm < 0)
      waterCm = 0;
    currentWaterLevelCm = waterCm;
  }
  return currentWaterLevelCm;
}

float readBatteryVoltage() {
  int raw = analogRead(BATTERY_ADC_PIN);
  float volt = (raw / 4095.0) * 3.3 * 2.0;
  if (volt > 0.5)
    currentBatteryVolt = volt;
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
    Serial.printf("RTSP URL   : rtsp://%s:8554/mjpeg/1\n",
                  WiFi.localIP().toString().c_str());
    Serial.printf("MJPEG URL  : http://%s:81/stream\n",
                  WiFi.localIP().toString().c_str());
  } else {
    Serial.println(
        "\n[Warning] Wi-Fi Connection failed. Please check SSID/Password.");
  }
}
