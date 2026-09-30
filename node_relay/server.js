/**
 * High-Speed Node.js Video & Image Relay Server for ESP32-CAM
 * เทศบาลตำบลตันหยงมัส (Tanyongmat Municipality Flood Monitoring)
 * 
 * คุณสมบัติ:
 * 1. รับภาพ Binary JPEG จาก ESP32-CAM (POST /upload) เก็บลง RAM กลาง
 * 2. กระจายภาพสดไปยังผู้ใช้ทุกคนผ่าน:
 *    - GET /stream     : MJPEG Stream ความเร็วสูง (วิดีโอต่อเนื่องลื่นไหล 8-10 FPS)
 *    - GET /latest.jpg : ภาพเฟรมเดี่ยวล่าสุด (สำหรับมือถือ)
 * 3. ไม่ใช้ Serverless จึงไม่มีปัญหาเรื่องการสลับตู้ หรือ RAM หาย
 */

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const AUTH_KEY = "TMSTUDIO_SECURE_TOKEN";

app.use(cors());

// รับ Body แบบ Raw Binary Buffer สูงสุด 500KB
app.use('/upload', express.raw({ type: '*/*', limit: '500kb' }));

let latestFrame = null;
let lastFrameTime = 0;
let totalFrames = 0;
let wakeUntil = 0;
let activeClients = []; // รายการเบราว์เซอร์ที่กำลังต่อดูวิดีโอสดผ่าน MJPEG Stream

// ========================================================
// 1. ESP32-CAM ส่งภาพดิบ (Binary JPEG) เข้ามา
// ========================================================
app.post('/upload', (req, res) => {
  const auth = req.headers['x-auth-key'];
  if (auth !== AUTH_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (req.body && req.body.length > 50) {
    latestFrame = req.body;
    lastFrameTime = Date.now();
    totalFrames++;

    // ส่งภาพไปให้ทุกหน้าจอที่เปิดสตรีมสดอยู่ทันที (Real-Time Broadcast)
    broadcastFrame(latestFrame);
  }

  res.status(200).json({
    success: true,
    isWake: Date.now() < wakeUntil,
    frameCount: totalFrames
  });
});

// ฟังก์ชันกระจายเฟรมภาพไปยังเบราว์เซอร์ทุกเครื่อง
function broadcastFrame(frameBuffer) {
  for (let i = activeClients.length - 1; i >= 0; i--) {
    const client = activeClients[i];
    try {
      client.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frameBuffer.length}\r\n\r\n`);
      client.write(frameBuffer);
      client.write('\r\n');
    } catch (e) {
      activeClients.splice(i, 1);
    }
  }
}

// ========================================================
// 2. สตรีมวิดีโอสด MJPEG Stream (ลื่นไหล 8-10 FPS เหมือนกล้องวงจรปิด)
// ========================================================
app.get(['/stream', '/live.mjpeg'], (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=--frame',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Connection': 'close',
    'Pragma': 'no-cache',
    'Access-Control-Allow-Origin': '*'
  });

  // ถ้ามีภาพใน RAM อยู่แล้ว ให้ส่งเฟรมแรกทันที
  if (latestFrame) {
    res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${latestFrame.length}\r\n\r\n`);
    res.write(latestFrame);
    res.write('\r\n');
  }

  activeClients.push(res);

  req.on('close', () => {
    const idx = activeClients.indexOf(res);
    if (idx !== -1) activeClients.splice(idx, 1);
  });
});

// ========================================================
// 3. ดึงภาพเดี่ยวล่าสุด (GET /latest.jpg)
// ========================================================
app.get(['/latest.jpg', '/frame'], (req, res) => {
  if (!latestFrame) {
    return res.status(404).send("No camera frame received yet");
  }

  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': latestFrame.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Access-Control-Allow-Origin': '*',
    'X-Frame-Age-Ms': (Date.now() - lastFrameTime).toString()
  });
  res.end(latestFrame);
});

// ========================================================
// 4. API ปลุกกล้องให้สตรีมเร็ว
// ========================================================
app.get('/wake', (req, res) => {
  wakeUntil = Date.now() + 180000;
  res.json({ success: true, wakeUntil: wakeUntil });
});

app.get('/check-wake', (req, res) => {
  res.json({
    wake: Date.now() < wakeUntil,
    viewers: activeClients.length
  });
});

// ========================================================
// 5. API ตรวจสอบสถานะการเชื่อมต่อ
// ========================================================
app.get('/status', (req, res) => {
  const ageMs = Date.now() - lastFrameTime;
  const isOnline = lastFrameTime > 0 && ageMs < 15000;

  res.json({
    project: "Flood-CAM Node Relay",
    municipality: "เทศบาลตำบลตันหยงมัส",
    cameraOnline: isOnline,
    lastSeenMsAgo: lastFrameTime > 0 ? ageMs : null,
    totalFrames: totalFrames,
    activeViewers: activeClients.length,
    isWakeActive: Date.now() < wakeUntil
  });
});

app.get('/', (req, res) => {
  res.send(`
    <h1>🚀 Flood-CAM Node.js Relay Server is Running!</h1>
    <p>เทศบาลตำบลตันหยงมัส อ.ระแงะ จ.นราธิวาส</p>
    <ul>
      <li><a href="/stream" target="_blank">🎥 ดูสตรีมสด MJPEG Stream (/stream)</a></li>
      <li><a href="/latest.jpg" target="_blank">📷 ดูภาพถ่ายล่าสุด (/latest.jpg)</a></li>
      <li><a href="/status" target="_blank">📊 ตรวจสอบสถานะกล้อง (/status)</a></li>
    </ul>
  `);
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
