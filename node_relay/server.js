/**
 * High-Speed Node.js Video & Image Relay Server for ESP32-CAM (Multi-Camera Support)
 * เทศบาลตำบลตันหยงมัส (Tanyongmat Municipality Flood Monitoring)
 * 
 * คุณสมบัติ:
 * 1. รองรับกล้องหลายจุดพร้อมกัน (CAM-TYM-01, CAM-TYM-02, CAM-TYM-03, ...)
 * 2. รับภาพ Binary JPEG จาก ESP32-CAM แต่ละตัวผ่าน POST /upload แยกตาม x-cam-id
 * 3. บริการสตรีมสด MJPEG แยกตามกล้อง:
 *    - GET /stream?camId=CAM-TYM-01
 *    - GET /stream?camId=CAM-TYM-02
 * 4. บริการดึงภาพนิ่งล่าสุด:
 *    - GET /latest.jpg?camId=CAM-TYM-01
 * 5. ตรวจสอบสถานะกล้องทุกตัวพร้อมกัน:
 *    - GET /status
 */

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const AUTH_KEY = "TMSTUDIO_SECURE_TOKEN";

app.use(cors());

// รับ Body แบบ Raw Binary Buffer สูงสุด 500KB
app.use('/upload', express.raw({ type: '*/*', limit: '500kb' }));

// ฐานข้อมูลเก็บเฟรมภาพและผู้ชมแยกตาม Camera ID ใน RAM
const cameras = {};

function getOrCreateCamera(camId) {
  if (!cameras[camId]) {
    cameras[camId] = {
      id: camId,
      latestFrame: null,
      lastFrameTime: 0,
      totalFrames: 0,
      wakeUntil: 0,
      clients: []
    };
  }
  return cameras[camId];
}

// ========================================================
// 1. ESP32-CAM ส่งภาพดิบ (Binary JPEG) เข้ามาแยกตามจุด
// ========================================================
app.post('/upload', (req, res) => {
  const auth = req.headers['x-auth-key'];
  if (auth !== AUTH_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // ระบุรหัสกล้องจาก Header หรือ Query Parameter (ค่าเริ่มต้น CAM-TYM-01)
  const camId = req.headers['x-cam-id'] || req.query.camId || "CAM-TYM-01";
  const cam = getOrCreateCamera(camId);

  if (req.body && req.body.length > 50) {
    cam.latestFrame = req.body;
    cam.lastFrameTime = Date.now();
    cam.totalFrames++;

    // กระจายภาพสดไปยังผู้ชมที่กำลังดูกล้องจุดนี้ทันที (Real-Time Broadcast)
    broadcastToCameraClients(cam, cam.latestFrame);
  }

  res.status(200).json({
    success: true,
    camId: camId,
    isWake: Date.now() < cam.wakeUntil,
    frameCount: cam.totalFrames
  });
});

function broadcastToCameraClients(cam, frameBuffer) {
  for (let i = cam.clients.length - 1; i >= 0; i--) {
    const client = cam.clients[i];
    try {
      client.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frameBuffer.length}\r\n\r\n`);
      client.write(frameBuffer);
      client.write('\r\n');
    } catch (e) {
      cam.clients.splice(i, 1);
    }
  }
}

// ========================================================
// 2. สตรีมวิดีโอสด MJPEG Stream แยกตามกล้อง
//    ตัวอย่าง: /stream?camId=CAM-TYM-01 หรือ /stream?camId=CAM-TYM-02
// ========================================================
app.get(['/stream', '/live.mjpeg', '/stream/:camId'], (req, res) => {
  const camId = req.params.camId || req.query.camId || "CAM-TYM-01";
  const cam = getOrCreateCamera(camId);

  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=--frame',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Connection': 'close',
    'Pragma': 'no-cache',
    'Access-Control-Allow-Origin': '*'
  });

  // ถ้ามีภาพใน RAM อยู่แล้ว ให้ส่งเฟรมแรกทันที
  if (cam.latestFrame) {
    res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${cam.latestFrame.length}\r\n\r\n`);
    res.write(cam.latestFrame);
    res.write('\r\n');
  }

  cam.clients.push(res);

  req.on('close', () => {
    const idx = cam.clients.indexOf(res);
    if (idx !== -1) cam.clients.splice(idx, 1);
  });
});

// ========================================================
// 3. ดึงภาพเดี่ยวล่าสุดแยกตามกล้อง
//    ตัวอย่าง: /latest.jpg?camId=CAM-TYM-01 หรือ /latest.jpg?camId=CAM-TYM-02
// ========================================================
app.get(['/latest.jpg', '/frame', '/frame/:camId'], (req, res) => {
  const camId = req.params.camId || req.query.camId || "CAM-TYM-01";
  const cam = getOrCreateCamera(camId);

  if (!cam.latestFrame) {
    return res.status(404).send(`No camera frame received yet for ${camId}`);
  }

  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': cam.latestFrame.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Access-Control-Allow-Origin': '*',
    'X-Cam-Id': camId,
    'X-Frame-Age-Ms': (Date.now() - cam.lastFrameTime).toString()
  });
  res.end(cam.latestFrame);
});

// ========================================================
// 4. API ปลุกกล้องให้สตรีมเร็ว
// ========================================================
app.get('/wake', (req, res) => {
  const camId = req.query.camId || "CAM-TYM-01";
  const cam = getOrCreateCamera(camId);
  cam.wakeUntil = Date.now() + 180000;
  res.json({ success: true, camId: camId, wakeUntil: cam.wakeUntil });
});

app.get('/check-wake', (req, res) => {
  const camId = req.query.camId || "CAM-TYM-01";
  const cam = getOrCreateCamera(camId);
  res.json({
    camId: camId,
    wake: Date.now() < cam.wakeUntil,
    viewers: cam.clients.length
  });
});

// ========================================================
// 5. API ตรวจสอบสถานะกล้องทุกตัวในระบบ
// ========================================================
app.get('/status', (req, res) => {
  const statusList = {};
  const now = Date.now();

  for (let id in cameras) {
    const cam = cameras[id];
    const ageMs = now - cam.lastFrameTime;
    statusList[id] = {
      online: cam.lastFrameTime > 0 && ageMs < 15000,
      lastSeenMsAgo: cam.lastFrameTime > 0 ? ageMs : null,
      totalFrames: cam.totalFrames,
      viewers: cam.clients.length,
      isWakeActive: now < cam.wakeUntil
    };
  }

  res.json({
    project: "Flood-CAM Multi-Relay",
    municipality: "เทศบาลตำบลตันหยงมัส",
    camerasCount: Object.keys(cameras).length,
    cameras: statusList
  });
});

app.get('/', (req, res) => {
  res.send(`
    <h1>🚀 Flood-CAM Multi-Relay Server is Running!</h1>
    <p>เทศบาลตำบลตันหยงมัส อ.ระแงะ จ.นราธิวาส (รองรับกล้องหลายจุดพร้อมกัน)</p>
    <ul>
      <li><a href="/stream?camId=CAM-TYM-01" target="_blank">🎥 จุดที่ 1: ถนนประชาสามัคคี (/stream?camId=CAM-TYM-01)</a></li>
      <li><a href="/stream?camId=CAM-TYM-02" target="_blank">🎥 จุดที่ 2: จุดตรวจที่ 2 (/stream?camId=CAM-TYM-02)</a></li>
      <li><a href="/status" target="_blank">📊 ตรวจสอบสถานะกล้องทุกตัว (/status)</a></li>
    </ul>
  `);
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
