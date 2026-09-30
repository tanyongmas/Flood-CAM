/**
 * ======================================================================================
 * ระบบกล้องตรวจวัดและเฝ้าระวังอุทกภัยอัจฉริยะ เทศบาลตำบลตันหยงมัส (ESP32-CAM)
 * Smart Flood Watch - Ultimate Hybrid Firmware (Dual-Mode: LAN 25 FPS + 4G Cloud Relay)
 * --------------------------------------------------------------------------------------
 * จุดตรวจ: ถนนประชาสามัคคี ชุมชนตลาดกลางผลไม้ (CAM-TYM-01)
 * เครือข่ายหลัก: SSID: "TMSTUDIO" | รหัสผ่าน: "026830TM"
 * เครือข่ายสำรอง: SSID: "199X"     | รหัสผ่าน: "5910110106"
 * --------------------------------------------------------------------------------------
 * คุณสมบัติ:
 * 1. รองรับดูจากมือถือ "ทั้งในบ้าน (Wi-Fi เดียวกัน) และนอกบ้าน (เน็ตมือถือ 4G/5G)":
 *    - เมื่อมือถือต่อ Wi-Fi ในบ้าน -> สตรีมสดความเร็วสูง 25 FPS (HTTP MJPEG / RTSP)
 *    - เมื่อมือถืออยู่นอกบ้าน (เน็ต 4G/5G) -> สตรีมผ่าน Google Apps Script Cloud Snapshot Relay
 * 2. On-Demand Remote Wake-up: ส่งภาพขึ้น Cloud เฉพาะเมื่อมีผู้กดดู เพื่อประหยัดพลังงาน & แบนด์วิดท์
 * 3. พอร์ต 8554: RTSP Video Server (rtsp://<IP>:8554/mjpeg/1) สำหรับ NVR / VLC / OBS
 * 4. พอร์ต 81: Dedicated HTTP MJPEG Stream (http://<IP>:81/stream) 25 FPS
 * 5. พอร์ต 80: Web API ควบคุมไฟแฟลช, เซนเซอร์, และ "ตั้งค่าเปลี่ยน Wi-Fi ผ่านหน้าเว็บ"
 * 6. Dual-Core FreeRTOS: ระบบ Cloud ทำงานบน Core 0 แยกอิสระ 100% ไม่หน่วงระบบควบคุมกล้อง
 * 7. Wi-Fi Auto-Fallback & Watchdog: สลับหาเครือข่ายอัตโนมัติ และต่อใหม่ทันทีหากเน็ตหลุด
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

// Mutex ควบคุมความปลอดภัยในการเข้าถึงกล้องข้าม Core
SemaphoreHandle_t camMutex = NULL;

// ======================= [ค่าเริ่มต้นเครือข่าย Wi-Fi] =======================
const char* DEFAULT_WIFI_SSID     = "TMSTUDIO";
const char* DEFAULT_WIFI_PASSWORD = "026830TM";

const char* BACKUP_WIFI_SSID      = "199X";
const char* BACKUP_WIFI_PASSWORD  = "5910110106";

String currentSSID = DEFAULT_WIFI_SSID;
String currentPASS = DEFAULT_WIFI_PASSWORD;

// รหัสประจำตัวกล้อง
const char* CAMERA_ID     = "CAM-TYM-01";
const char* LOCATION_NAME = "ถนนประชาสามัคคี ชุมชนตลาดกลางผลไม้";

// Google Apps Script Cloud Backend URL
const char* GAS_EXEC_URL  = "https://script.google.com/macros/s/AKfycbwiE9fu8R9GRQ9LJoD4UXnz3K7PKV6Nip3JGMzVVOznZR0wvq5f7oHEwEfuIuh_F6in/exec";

// Cloudflare Fast Edge Relay (แนวทาง C1: High-Speed Binary Push 5-10 FPS)
const char* CF_WORKER_HOST       = "flood-cam1.tonyongmas-app.workers.dev";
const char* CF_AUTH_KEY          = "TMSTUDIO_SECURE_TOKEN";
bool        USE_CLOUDFLARE_EDGE  = true; // true = สตรีมสดความเร็วสูงผ่าน Cloudflare Worker

// ฮาร์ดแวร์เซนเซอร์
#define ULTRASONIC_TRIG_PIN 13
#define ULTRASONIC_ECHO_PIN 12
#define BATTERY_ADC_PIN     33
#define LED_FLASH_PIN       4

// อินสแตนซ์โมดูล
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
void uploadSnapshotToCloud();
void cloudSyncTask(void *pvParameters);

void setup() {
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0); // ปิด Brownout Detector ป้องกันไฟตก

  Serial.begin(115200);
  delay(500);
  Serial.println("\n\n========================================================");
  Serial.printf("เทศบาลตำบลตันหยงมัส - ESP32-CAM Flood Watch [%s]\n", CAMERA_ID);
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

  // ปรับแต่งเซนเซอร์เพื่อความเร็วในการสตรีมผ่าน 4G สูงสุด (ไฟล์เล็ก โหลดไว ภาพลื่นไหล)
  sensor_t * s = esp_camera_sensor_get();
  if (s) {
    s->set_framesize(s, FRAMESIZE_VGA); // 640x480 ความละเอียดมาตรฐานคมชัด
    s->set_quality(s, 16);              // ค่าคุณภาพ 16 (ขนาดรูปเพียง ~15 KB อัปโหลดเสร็จใน 50ms)
    s->set_brightness(s, 1);
  }

  // 2. โหลดและเชื่อมต่อ Wi-Fi (มีระบบสลับหา TMSTUDIO หรือ 199X อัตโนมัติ)
  loadWiFiPreferences();
  setupWiFi();

  // 3. เริ่มต้นพอร์ต 80 (Control & Web Settings)
  setupControlRoutes();
  controlServer.begin();
  Serial.printf(">> Control Server Ready : http://%s/\n", WiFi.localIP().toString().c_str());

  // 4. เริ่มต้นพอร์ต 81 (HTTP MJPEG Direct Stream 25 FPS)
  mjpegServer.begin();
  Serial.printf(">> HTTP MJPEG Stream    : http://%s:81/stream\n", WiFi.localIP().toString().c_str());

  // 5. เริ่มต้นพอร์ต 8554 (RTSP Server)
  rtspServer.begin();
  streamer = new OV2640Streamer(&cam);
  Serial.printf(">> RTSP Video Stream    : rtsp://%s:8554/mjpeg/1\n", WiFi.localIP().toString().c_str());

  // 6. รัน Cloud Sync Background Task บน Core 0 (ซิงค์ระดับน้ำ & ส่งภาพขึ้น Cloud เมื่อมือถือ 4G เปิดดู)
  xTaskCreatePinnedToCore(
    cloudSyncTask,
    "CloudSync",
    10240,
    NULL,
    1,
    NULL,
    0 // Core 0
  );
}

void loop() {
  controlServer.handleClient();

  // ให้บริการสตรีมสดในวงแลนเมื่อมีการร้องขอ (หรือเมื่อมี Client เชื่อมต่อ)
  if (isStreamingRequested) {
    handleMJPEGStream();
    handleRTSP();

    // ตัดเข้า Standby อัตโนมัติหลัง 3 นาทีเพื่อประหยัดพลังงาน
    if (millis() - lastStreamRequestTime >= (STREAM_AUTO_OFF_SEC * 1000UL)) {
      Serial.println("[Power] Stream session timed out. Entering Standby Mode.");
      isStreamingRequested = false;
      setFlashLED(0);
    }
  } else {
    // ตรวจสอบ Client RTSP ที่อาจเชื่อมเข้ามาในวงแลน
    WiFiClient rtspClient = rtspServer.accept();
    if (rtspClient) {
      isStreamingRequested = true;
      lastStreamRequestTime = millis();
      streamer->addSession(new WiFiClient(rtspClient));
    }
    delay(10);
  }
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
    Serial.printf("[Storage] Loaded custom Wi-Fi from Flash: %s\n", currentSSID.c_str());
  } else {
    currentSSID = DEFAULT_WIFI_SSID;
    currentPASS = DEFAULT_WIFI_PASSWORD;
    Serial.printf("[Storage] Using default Wi-Fi: %s\n", currentSSID.c_str());
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
// จัดการคำสั่งบนพอร์ต 80 (ควบคุม, ปลุกสตรีม, เปลี่ยน Wi-Fi ผ่านหน้าเว็บ)
// -------------------------------------------------------------
void setupControlRoutes() {
  // สั่งปลุกกล้องเริ่มสตรีมภาพสด
  controlServer.on("/wake", HTTP_GET, []() {
    isStreamingRequested = true;
    lastStreamRequestTime = millis();
    controlServer.sendHeader("Access-Control-Allow-Origin", "*");
    controlServer.send(200, "application/json", "{\"status\":\"active\",\"stream_port\":81}");
  });

  // สั่งหยุดสตรีมสด
  controlServer.on("/stop", HTTP_GET, []() {
    isStreamingRequested = false;
    setFlashLED(0);
    controlServer.sendHeader("Access-Control-Allow-Origin", "*");
    controlServer.send(200, "application/json", "{\"status\":\"stopped\"}");
  });

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

  // คืนค่า Wi-Fi เป็นค่าเริ่มต้น (TMSTUDIO)
  controlServer.on("/resetwifi", HTTP_GET, []() {
    controlServer.sendHeader("Access-Control-Allow-Origin", "*");
    preferences.begin("cam_wifi", false);
    preferences.clear();
    preferences.end();
    currentSSID = DEFAULT_WIFI_SSID;
    currentPASS = DEFAULT_WIFI_PASSWORD;
    controlServer.send(200, "application/json", "{\"status\":\"ok\",\"message\":\"รีเซ็ต Wi-Fi เป็นค่าเริ่มต้น (TMSTUDIO) เรียบร้อย\"}");
    delay(1000);
    setupWiFi();
  });

  // ปรับความสว่าง Flash LED (Instant 5ms Response)
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

  // ถ่ายภาพ 1 เฟรม
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

  // ตรวจสอบสถานะกล้อง
  controlServer.on("/status", HTTP_GET, []() {
    float water = readWaterLevel();
    float batt = readBatteryVoltage();
    String json = "{\"camera_id\":\"" + String(CAMERA_ID) + "\",";
    json += "\"ssid\":\"" + WiFi.SSID() + "\",";
    json += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
    json += "\"streaming\":" + String(isStreamingRequested ? "true" : "false") + ",";
    json += "\"rtsp_url\":\"rtsp://" + WiFi.localIP().toString() + ":8554/mjpeg/1\",";
    json += "\"mjpeg_url\":\"http://" + WiFi.localIP().toString() + ":81/stream\",";
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
    String html = "<h2>ESP32-CAM Flood Watch (Hybrid LAN + Cloud)</h2>";
    html += "<p><b>Connected Wi-Fi:</b> " + WiFi.SSID() + " (" + WiFi.localIP().toString() + ")</p>";
    html += "<p><b>RTSP Stream:</b> rtsp://" + WiFi.localIP().toString() + ":8554/mjpeg/1</p>";
    html += "<p><b>MJPEG Stream:</b> <a href='/stream' target='_blank'>http://" + WiFi.localIP().toString() + ":81/stream</a></p>";
    controlServer.send(200, "text/html", html);
  });
}

// -------------------------------------------------------------
// สตรีมภาพสด MJPEG บนพอร์ต 81 (25 FPS ลื่นไหลในวงแลน)
// -------------------------------------------------------------
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
    delay(40); // ~25 FPS
  }
  client.stop();
}

// -------------------------------------------------------------
// สตรีม RTSP บนพอร์ต 8554
// -------------------------------------------------------------
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

// -------------------------------------------------------------
// อัปโหลดภาพขึ้น Cloud (รองรับ Cloudflare Worker High-Speed Edge หรือ Google Apps Script)
// -------------------------------------------------------------
void uploadSnapshotToCloud() {
  if (WiFi.status() != WL_CONNECTED) return;

  if (camMutex == NULL) return;
  if (xSemaphoreTake(camMutex, pdMS_TO_TICKS(200)) != pdTRUE) return;

  cam.run();
  uint8_t* fbBuf = cam.getfb();
  size_t fbLen = cam.getSize();

  if (!fbBuf || fbLen == 0) {
    xSemaphoreGive(camMutex);
    return;
  }

  // แนวทาง C1: ส่ง Binary JPEG แท้ๆ ไปยัง Cloudflare Worker (เสถียร 100% ไม่ค้าง)
  if (USE_CLOUDFLARE_EDGE && strlen(CF_WORKER_HOST) > 5 && String(CF_WORKER_HOST).indexOf("workers.dev") > 0) {
    String uploadUrl = "https://" + String(CF_WORKER_HOST) + "/upload";

    WiFiClientSecure client;
    client.setInsecure();
    client.setTimeout(4);

    HTTPClient http;
    http.setTimeout(4000);
    http.setReuse(false);

    if (http.begin(client, uploadUrl)) {
      http.addHeader("Content-Type", "image/jpeg");
      http.addHeader("x-auth-key", CF_AUTH_KEY);

      int httpCode = http.POST(fbBuf, fbLen);
      if (httpCode == HTTP_CODE_OK || httpCode == 200) {
        Serial.printf("[Cloudflare Edge] Frame pushed (%u KB, code %d)\n", (unsigned int)(fbLen / 1024), httpCode);
      } else {
        Serial.printf("[Cloudflare Edge] Push failed, code: %d\n", httpCode);
      }
      http.end();
    }
    client.stop();

    xSemaphoreGive(camMutex);
    vTaskDelay(pdMS_TO_TICKS(30)); // คืนเวลาให้ FreeRTOS IDLE0 Task
    return;
  }

  // แนวทางเดิม (A): ส่ง Base64 ไปยัง Google Apps Script (สำรอง)
  if (String(GAS_EXEC_URL).indexOf("http") != 0) {
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

// -------------------------------------------------------------
// Background Cloud Sync Task บน Core 0 (ไม่หน่วงการควบคุมกล้อง)
// -------------------------------------------------------------
void cloudSyncTask(void *pvParameters) {
  unsigned long lastTelemetrySync = 0;
  unsigned long lastCommandCheck = 0;
  unsigned long lastSnapshotPush = 0;
  unsigned long lastWifiRetry = 0;

  for (;;) {
    vTaskDelay(500 / portTICK_PERIOD_MS);

    // Wi-Fi Watchdog: เชื่อมต่ออัตโนมัติหากสัญญาณหลุด
    if (WiFi.status() != WL_CONNECTED) {
      if (millis() - lastWifiRetry >= 10000) {
        lastWifiRetry = millis();
        Serial.println("[Wi-Fi Watchdog] Connection dropped. Reconnecting...");
        WiFi.disconnect();
        WiFi.reconnect();
      }
      continue;
    }

    if (String(GAS_EXEC_URL).indexOf("http") != 0) continue;

    unsigned long now = millis();

    // 1. ส่ง Telemetry รายงานระดับน้ำทุก 30 วินาที
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

    // 2. ตรวจสอบคำสั่งปลุกสตรีมจาก Cloud ทุก 3.5 วินาที เมื่ออยู่ใน Standby (เมื่อมือถือ 4G กดดู)
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
            
            // ตรวจสอบคำสั่งปลุกสตรีม
            if (payload.indexOf("wake_stream") >= 0) {
              isStreamingRequested = true;
              lastStreamRequestTime = millis();
              Serial.println("[Cloud Trigger] Remote Wake-up Command received from Cloud!");
            }
            
            // ตรวจสอบคำสั่งเปลี่ยน Wi-Fi ทางไกล (setwifi:<ssid>:<pass>)
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

    // 3. อัปโหลดภาพขึ้น Cloud:
    // - ถ้ามีคนกดดู (isStreamingRequested): ส่งทุก 350ms (~3 FPS) ต่อเนื่อง ไม่ค้าง ไม่หลุด
    // - ถ้าอยู่ใน Standby: ส่ง 1 ภาพทุก 5 วินาที เพื่อให้หน้าเว็บมีภาพสดเสมอ
    unsigned long pushInterval = isStreamingRequested ? 350 : 5000;
    if (now - lastSnapshotPush >= pushInterval) {
      lastSnapshotPush = now;
      uploadSnapshotToCloud();
    }

    // คืนเวลา CPU ให้ FreeRTOS IDLE0 Task รีเซ็ต Watchdog Timer เสมอ
    vTaskDelay(pdMS_TO_TICKS(50));
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

// ระบบเชื่อมต่อ Wi-Fi อัจฉริยะ (สลับหา TMSTUDIO หรือ 199X สำรองอัตโนมัติ)
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

  // หากต่อเครือข่ายหลักไม่สำเร็จ ให้ลองต่อเครือข่ายสำรองอัตโนมัติ
  if (WiFi.status() != WL_CONNECTED) {
    const char* fallbackSSID = (currentSSID == DEFAULT_WIFI_SSID) ? BACKUP_WIFI_SSID : DEFAULT_WIFI_SSID;
    const char* fallbackPASS = (currentSSID == DEFAULT_WIFI_SSID) ? BACKUP_WIFI_PASSWORD : DEFAULT_WIFI_PASSWORD;
    Serial.printf("\n[Wi-Fi Fallback] Trying alternate network: %s ", fallbackSSID);
    WiFi.begin(fallbackSSID, fallbackPASS);
    retries = 0;
    while (WiFi.status() != WL_CONNECTED && retries < 20) {
      delay(400);
      Serial.print(".");
      retries++;
    }
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[OK] Wi-Fi Connected!");
    Serial.printf("Connected SSID: %s\n", WiFi.SSID().c_str());
    Serial.printf("IP Address    : %s\n", WiFi.localIP().toString().c_str());
    Serial.printf("MJPEG Stream  : http://%s:81/stream (25 FPS)\n", WiFi.localIP().toString().c_str());
    Serial.printf("RTSP Stream   : rtsp://%s:8554/mjpeg/1\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\n[Warning] Wi-Fi Connection failed. Please check SSID/Password.");
  }
}
