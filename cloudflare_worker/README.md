# ขั้นตอนการติดตั้ง Cloudflare Worker WebSocket Relay (วิธีที่ 2)
ระบบสตรีมสดข้ามเครือข่ายความเร็วสูง (10-15 FPS) ฟรี 100% ตลอดชีพ

---

### ทำไมวิธีที่ 2 จึงได้เปรียบวิธีที่ 1?
| หัวข้อ | วิธีที่ 1: Google Apps Script | วิธีที่ 2: Cloudflare WebSocket |
| :--- | :--- | :--- |
| **ความลื่นไหล** | ภาพ Snapshot รีเฟรชทุก 1.5 - 2.0 วินาที | **วิดีโอสด 10 - 15 FPS ลื่นไหลใกล้เคียงดูหน้ากล้อง** |
| **Latency (ความหน่วง)** | ~1.5 - 3 วินาที | **ต่ำมากเพียง 80 - 150 มิลลิวินาที (Cloudflare Edge BKK)** |
| **การใช้ Data 4G** | อัปโหลดเฉพาะภาพนิ่ง | ใช้ดาต้าเฉพาะช่วงที่มีคนเปิดดู (มีระบบ Auto-Standby) |
| **การควบคุมกล้อง** | หน่วงตามรอบ Polling | **ส่งคำสั่งหรี่ไฟ Flash / Wake ตอบสนองได้ใน 50ms** |

---

### ขั้นตอนการสร้าง Worker บน Cloudflare (ใช้เวลา 2 นาที):

1. **สมัคร/ล็อกอิน Cloudflare**:
   - เข้าเว็บ [https://dash.cloudflare.com](https://dash.cloudflare.com) (ฟรี ไม่ต้องผูกบัตรเครดิต)

2. **สร้าง Worker**:
   - ไปที่เมนูด้านซ้าย: **Workers & Pages** -> คลิก **Overview**
   - กดปุ่ม **Create application** -> เลือกแท็บ **Workers**
   - ตั้งชื่อ Worker เช่น `tanyongmat-camera` แล้วกด **Deploy**

3. **วางโค้ด**:
   - กดปุ่ม **Edit code**
   - ลบโค้ดเดิมทั้งหมดออก แล้วคัดลอกโค้ดจากไฟล์ `cloudflare_worker/worker.js` ไปวางแทน
   - กดปุ่ม **Deploy** (บันทึกและเผยแพร่)

4. **รับ URL ใช้งาน**:
   - คุณจะได้ URL เช่น: `https://tanyongmat-camera.<your-account>.workers.dev`
   - นำโดเมนนี้มาใส่ใน:
     - หน้าเว็บ Dashboard: ช่องตั้งค่า Cloudflare Worker URL
     - เฟิร์มแวร์ ESP32: ตัวแปร `CF_WORKER_HOST`
