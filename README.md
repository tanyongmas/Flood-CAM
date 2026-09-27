# ระบบรายงานสถานการณ์อุทกภัยและกล้องสตรีมสด ESP32-CAM (Smart Flood Watch)
## เทศบาลตำบลตันหยงมัส อำเภอระแงะ จังหวัดนราธิวาส

โครงการประยุกต์ใช้กล้อง **ESP32-CAM (AI-Thinker)** ตรวจวัดระดับน้ำและเฝ้าระวังอุทกภัยในจุดเสี่ยงภัยน้ำท่วมของ **เทศบาลตำบลตันหยงมัส** รองรับการสตรีมสดทั้งแบบ **RTSP / HTTP MJPEG (25 FPS)** ภายในวงแลน และแบบ **Google Apps Script Cloud Snapshot Relay** ทะลุเน็ตคนละวง (4G CGNAT) พร้อมระบบสั่งปลุกกล้องทางไกล (Remote Wake-up) และระบบตั้งค่าเปลี่ยน Wi-Fi ของกล้องผ่านหน้าเว็บแอดมิน

🔗 **GitHub Repository:** [https://github.com/tanyongmas/Flood-CAM.git](https://github.com/tanyongmas/Flood-CAM.git)

---

## 📁 โครงสร้างโปรเจกต์ (Project Structure)

```text
ESP32CAM/
├── index.html                           # หน้าเว็บ Dashboard แผนที่ OpenStreetMap / ดาวเทียม และเครื่องเล่นสตรีมสด
├── style.css                            # ดีไซน์สไตล์ Modern Clean Light Theme สวยงาม คมชัด ใช้งานง่าย
├── app.js                               # ตรรกะควบคุมแผนที่, สตรีมสด, จัดการกล้อง และตั้งค่า Wi-Fi
├── firmware/
│   ├── ESP32CAM_Local_LAN/              # [กรณีที่ 1] ต่อ Wi-Fi วงเดียวกัน (TMSTUDIO)
│   │   ├── ESP32CAM_Local_LAN.ino       # โค้ดสตรีมสดความเร็วสูง RTSP (8554) และ MJPEG (81) 25 FPS
│   │   └── camera_pins.h                # ขาเชื่อมต่อกล้อง AI-Thinker OV2640 และ Flash LED
│   └── ESP32CAM_FloodWatch_4G/          # [กรณีที่ 2] ต่อ 4G Router วงนอก (199X)
│       ├── ESP32CAM_FloodWatch_4G.ino   # โค้ด Cloud Snapshot Relay ทะลุ 4G CGNAT ผ่าน Google Apps Script
│       └── camera_pins.h                # ขาเชื่อมต่อกล้อง AI-Thinker OV2640 และ Flash LED
├── google_apps_script/
│   └── Code.gs                          # โค้ด Google Apps Script Web App (คิวคำสั่ง, Snapshot Cache, บันทึกชีต)
└── README.md                            # คู่มือการติดตั้งและใช้งานระบบ
```

---

## 🌟 ฟีเจอร์เด่นของระบบ (Key Features)

1. **Dashboard แผนที่แบบ Dual-Layer (OSM & Satellite)**
   - สลับดูระหว่าง **OpenStreetMap (OSM)**, **ภาพถ่ายดาวเทียมความละเอียดสูง (Esri World Imagery)** และโหมดมืด (Dark Carto)
   - ปักหมุดกล้องจุดตรวจวัดพร้อมระดับการเตือนภัย: 🟢 ปกติ, 🟡 เฝ้าระวัง, 🔴 น้ำล้นตลิ่งวิกฤต
   - หน้าต่างดูภาพสด (Live Stream) เปิดแบบ Pop-up กลางจอภาพอย่างชัดเจน พร้อมแสดงเวลา Live Timestamp บนมุมซ้ายบนของภาพ

2. **รองรับการสตรีมภาพ 2 รูปแบบอย่างยืดหยุ่น:**
   - **🏠 วงเดียวกัน (Local LAN - TMSTUDIO):** สตรีมตรงความเร็วสูง 20-25 FPS ผ่านพอร์ต 81 (HTTP MJPEG) บนเว็บ และพอร์ต 8554 (RTSP Server: `rtsp://<IP>:8554/mjpeg/1`) สำหรับ VLC Player และกล่องบันทึก NVR
   - **☁️ วงนอก 4G (199X):** สตรีมภาพผ่าน Google Apps Script Cloud Snapshot Relay ดูได้จากทุกที่ทั่วโลกโดยไม่ต้องทำ Port Forwarding และไม่ติดข้อจำกัด 4G CGNAT

3. **ระบบตั้งค่า Wi-Fi ของกล้องผ่านหน้าเว็บ (Admin Mode):**
   - สามารถเลือกโปรไฟล์ Wi-Fi ด่วน (`TMSTUDIO` หรือ `199X`) หรือกรอกชื่อและรหัสผ่านใหม่
   - ส่งคำสั่งเปลี่ยน Wi-Fi ไปยัง ESP32-CAM ผ่านทั้ง Local LAN และ Cloud Command Queue บันทึกลง Flash Memory (Preferences) กล้องจะ Reconnect อัตโนมัติใน 3-5 วินาที

4. **ระบบตรวจวัดระดับน้ำและโทรมาตร (Telemetry):**
   - รองรับเซนเซอร์ Ultrasonic JSN-SR04T กันน้ำ วัดระดับน้ำและส่งข้อมูลเข้า Dashboard
   - รายงานแรงดันแบตเตอรี่โซลาร์เซลล์ และความแรงสัญญาณ Wi-Fi RSSI

---

## 🛠️ การติดตั้งและอัปโหลดเฟิร์มแวร์ ESP32-CAM

### 1. การตั้งค่าใน Arduino IDE
* **Board:** `AI Thinker ESP32-CAM`
* **Partition Scheme:** `Huge APP (3MB No OTA/1MB SPIFFS)`
* **PSRAM:** `Enabled`
* **CPU Frequency:** `240MHz (WiFi/BT)`
* **ไลบรารีที่จำเป็น:** ติดตั้ง `Micro-RTSP` โดย Kevin Hester ผ่าน Library Manager

### 2. เลือกเฟิร์มแวร์ตามการใช้งาน
* **กรณีใช้งานในสำนักงาน/วงแลนเดียวกัน (`TMSTUDIO`):**
  เปิดไฟล์ [`firmware/ESP32CAM_Local_LAN/ESP32CAM_Local_LAN.ino`](file:///f:/Municipality%202568/WebApp/BiGDATA/ESP32CAM/firmware/ESP32CAM_Local_LAN/ESP32CAM_Local_LAN.ino) แล้วกด Upload
* **กรณีนำไปติดตั้งหน้างานจริงกับ Pocket Wi-Fi 4G (`199X`):**
  เปิดไฟล์ [`firmware/ESP32CAM_FloodWatch_4G/ESP32CAM_FloodWatch_4G.ino`](file:///f:/Municipality%202568/WebApp/BiGDATA/ESP32CAM/firmware/ESP32CAM_FloodWatch_4G/ESP32CAM_FloodWatch_4G.ino) แล้วกด Upload

---

## ☁️ การติดตั้ง Google Apps Script (Cloud Backend)

1. เข้าไปที่ [Google Sheets](https://sheets.new) เพื่อสร้างสเปรดชีตใหม่
2. ไปที่เมนู **ส่วนขยาย (Extensions)** -> **Apps Script**
3. คัดลอกโค้ดจากไฟล์ [`google_apps_script/Code.gs`](file:///f:/Municipality%202568/WebApp/BiGDATA/ESP32CAM/google_apps_script/Code.gs) ไปวางทับไฟล์ `Code.gs`
4. คลิก **ทำให้ใช้งานได้ (Deploy)** -> **การทำให้ใช้งานได้รายการใหม่ (New deployment)**
   - ประเภท: **เว็บแอป (Web app)**
   - ดำเนินการในฐานะ: **ฉัน (Me)**
   - ผู้ที่มีสิทธิ์เข้าถึง: **ทุกคน (Anyone)** *(สำคัญมาก เพื่อให้ ESP32 และหน้าเว็บเข้าถึงได้)*
5. คัดลอก **URL ของเว็บแอป (Web App Exec URL)** นำมาใส่ในการตั้งค่าหน้า Dashboard และในโค้ด ESP32-CAM

---

## 🌐 การเปิดใช้งาน Dashboard หน้าเว็บ

เปิดไฟล์ [`index.html`](file:///f:/Municipality%202568/WebApp/BiGDATA/ESP32CAM/index.html) ผ่านเว็บเบราว์เซอร์ได้ทันที หรือโฮสต์ออนไลน์ผ่าน **GitHub Pages**:
1. ไปที่แท็บ **Settings** ของ Repository บน GitHub
2. ไปที่เมนู **Pages** (ซ้ายมือ)
3. ภายใต้ **Build and deployment** ให้เลือก Source: `Deploy from a branch` และเลือก Branch: `main` (หรือ `master`) โฟลเดอร์: `/ (root)` แล้วกด **Save**
4. หน้าเว็บแดชบอร์ดจะออนไลน์ผ่าน URL: `https://tanyongmas.github.io/Flood-CAM/`
