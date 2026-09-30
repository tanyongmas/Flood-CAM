# 🚀 Fast Node.js Relay Server (Flood-CAM)
เทศบาลตำบลตันหยงมัส อ.ระแงะ จ.นราธิวาส

เซิร์ฟเวอร์สตรีมภาพความเร็วสูงสำหรับ ESP32-CAM กระจายภาพสดไปยังมือถือ 4G/5G ด้วยความเร็ว 8-10 FPS (MJPEG Stream)

---

## วิธีติดตั้งฟรีใน 1 นาที (แนะนำ Glitch.com - ฟรี 100% ไม่ต้องผูกบัตร)

### ขั้นตอนการทำบน Glitch.com:
1. เข้าไปที่ [https://glitch.com](https://glitch.com) (ล็อกอินด้วย Google หรือ GitHub ฟรี)
2. คลิกปุ่ม **New Project** -> เลือก **glitch-hello-node**
3. ที่เมนูไฟล์ด้านซ้าย:
   - เปิดไฟล์ `package.json` -> ลบของเดิมแล้วนำโค้ดใน `package.json` ของโฟลเดอร์นี้ไปวางแทนที่
   - เปิดไฟล์ `server.js` -> ลบของเดิมแล้วนำโค้ดใน `server.js` ของโฟลเดอร์นี้ไปวางแทนที่
4. รอระบบติดตั้ง 5 วินาที
5. คลิกปุ่ม **Share** หรือดูที่ด้านล่าง จะได้โดเมนของเซิร์ฟเวอร์ เช่น:
   ```text
   https://floodcam-tym.glitch.me
   ```

---

## วิธีนำไปใช้งาน:

1. **ในหน้าเว็บแดชบอร์ด:**
   - เข้าหน้าเว็บแดชบอร์ด -> กดปุ่ม **⚙️ แอดมิน** (รหัส `admin1234`)
   - ในช่อง **Cloudflare / Node.js Relay URL** ให้ใส่ URL ของ Glitch เช่น:
     `https://floodcam-tym.glitch.me`
   - กด **💾 บันทึกการตั้งค่า**

2. **ใน Arduino IDE (ESP32-CAM):**
   - เปิดไฟล์ `ESP32CAM_Local_LAN.ino`
   - แก้ไขบรรทัดที่ 58:
     ```cpp
     const char* CF_WORKER_HOST = "floodcam-tym.glitch.me"; // ใส่เฉพาะชื่อโฮสต์ ไม่ต้องใส่ https://
     ```
   - กด **Upload** ลงกล้อง ESP32-CAM
