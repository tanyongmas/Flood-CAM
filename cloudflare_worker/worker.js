/**
 * =========================================================================================
 * CLOUDFLARE WORKER - ESP32-CAM WEBSOCKET REAL-TIME RELAY
 * ระบบสตรีมภาพสดข้ามเครือข่ายความเร็วสูง (Ultra-Low Latency 10-15 FPS)
 * เทศบาลตำบลตันหยงมัส อ.ระแงะ จ.นราธิวาส
 * =========================================================================================
 * ฟรี 100% ตลอดชีพ (Free Tier: 100,000 requests/day, Unlimited WebSocket sessions)
 * 
 * สถาปัตยกรรมการทำงาน:
 * [ESP32-CAM + Pocket Wi-Fi 4G] --- WebSocket (WSS) ---> [Cloudflare Worker Edge] <--- WebSocket (WSS) --- [Web Dashboard]
 * 
 * Endpoints:
 * 1. wss://<your-worker>.workers.dev/ws/camera?camId=CAM-TYM-01   (กล้องเชื่อมต่อส่งภาพ)
 * 2. wss://<your-worker>.workers.dev/ws/client?camId=CAM-TYM-01   (หน้าเว็บเชื่อมต่อรับภาพสด)
 * 3. https://<your-worker>.workers.dev/snapshot?camId=CAM-TYM-01  (ดึงภาพนิ่งล่าสุด HTTP JPEG)
 * 4. https://<your-worker>.workers.dev/status                     (เช็คสถานะการเชื่อมต่อ)
 * =========================================================================================
 */

// เก็บสถานะการเชื่อมต่อใน Edge Memory
const cameras = new Map();     // camId -> { ws, lastSeen, latestFrame, subscribers: Set }
const subscribers = new Map(); // camId -> Set<WebSocket>

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const camId = url.searchParams.get("camId") || "CAM-TYM-01";

    // -------------------------------------------------------------
    // 1. ตรวจสอบสถานะระบบ (HTTP GET /status)
    // -------------------------------------------------------------
    if (pathname === "/status") {
      const camInfo = cameras.get(camId);
      const subs = subscribers.get(camId) || new Set();
      return new Response(JSON.stringify({
        status: "active",
        service: "Cloudflare WebSocket Stream Relay - Tanyongmat Flood Watch",
        camId: camId,
        cameraOnline: !!(camInfo && camInfo.ws && camInfo.ws.readyState === WebSocket.OPEN),
        viewersCount: subs.size,
        hasLatestFrame: !!(camInfo && camInfo.latestFrame),
        timestamp: new Date().toISOString()
      }, null, 2), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // -------------------------------------------------------------
    // 2. ดึงภาพ Snapshot ล่าสุด (HTTP GET /snapshot)
    // -------------------------------------------------------------
    if (pathname === "/snapshot") {
      const camInfo = cameras.get(camId);
      if (camInfo && camInfo.latestFrame) {
        return new Response(camInfo.latestFrame, {
          headers: {
            "Content-Type": "image/jpeg",
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Access-Control-Allow-Origin": "*"
          }
        });
      }
      return new Response("No snapshot available yet", {
        status: 404,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }

    // -------------------------------------------------------------
    // 3. WebSocket สำหรับกล้อง ESP32-CAM ส่งภาพสด (/ws/camera)
    // -------------------------------------------------------------
    if (pathname === "/ws/camera") {
      const upgradeHeader = request.headers.get("Upgrade");
      if (!upgradeHeader || upgradeHeader !== "websocket") {
        return new Response("Expected WebSocket Upgrade", { status: 426 });
      }

      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);

      server.accept();

      // บันทึกการเชื่อมต่อของกล้อง
      let camState = cameras.get(camId);
      if (!camState) {
        camState = { ws: server, lastSeen: Date.now(), latestFrame: null };
        cameras.set(camId, camState);
      } else {
        try { camState.ws.close(); } catch(e) {}
        camState.ws = server;
        camState.lastSeen = Date.now();
      }

      console.log(`[Camera Connected] ${camId}`);

      // แจ้งจำนวนผู้ชมปัจจุบันให้กล้องทราบทันที
      const currentSubs = subscribers.get(camId) || new Set();
      server.send(JSON.stringify({
        type: "init",
        viewers: currentSubs.size,
        stream_mode: currentSubs.size > 0 ? "active" : "standby"
      }));

      // เมื่อกล้องส่งภาพเฟรม (Binary JPEG หรือ Base64)
      server.addEventListener("message", (event) => {
        camState.lastSeen = Date.now();

        // เก็บภาพล่าสุดไว้สำหรับ /snapshot
        camState.latestFrame = event.data;

        // ถ่ายทอดภาพสดให้ทุก Web Browser ที่กำลังชมอยู่ทันที (Zero Latency)
        const subs = subscribers.get(camId);
        if (subs && subs.size > 0) {
          for (const subWs of subs) {
            try {
              if (subWs.readyState === WebSocket.OPEN) {
                subWs.send(event.data);
              } else {
                subs.delete(subWs);
              }
            } catch (err) {
              subs.delete(subWs);
            }
          }
        }
      });

      server.addEventListener("close", () => {
        console.log(`[Camera Disconnected] ${camId}`);
        if (camState.ws === server) {
          camState.ws = null;
        }
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    // -------------------------------------------------------------
    // 4. WebSocket สำหรับ Web Browser รับภาพสด (/ws/client)
    // -------------------------------------------------------------
    if (pathname === "/ws/client") {
      const upgradeHeader = request.headers.get("Upgrade");
      if (!upgradeHeader || upgradeHeader !== "websocket") {
        return new Response("Expected WebSocket Upgrade", { status: 426 });
      }

      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);

      server.accept();

      let subs = subscribers.get(camId);
      if (!subs) {
        subs = new Set();
        subscribers.set(camId, subs);
      }
      subs.add(server);

      console.log(`[Viewer Joined] ${camId}, Total Viewers: ${subs.size}`);

      // แจ้งกล้องให้เริ่มสตรีมภาพ เพราะมีผู้เข้าชม
      const camState = cameras.get(camId);
      if (camState && camState.ws && camState.ws.readyState === WebSocket.OPEN) {
        camState.ws.send(JSON.stringify({
          type: "wake_stream",
          viewers: subs.size
        }));
      }

      // ส่งภาพล่าสุดที่มีอยู่ให้ผู้ชมทันทีไม่ต้องรอ
      if (camState && camState.latestFrame) {
        server.send(camState.latestFrame);
      }

      // รับคำสั่งควบคุมจาก Web Browser (เช่น ปรับไฟแฟลช, สั่งปลุก) แล้วส่งต่อไปยังกล้อง
      server.addEventListener("message", (event) => {
        if (camState && camState.ws && camState.ws.readyState === WebSocket.OPEN) {
          camState.ws.send(event.data);
        }
      });

      server.addEventListener("close", () => {
        subs.delete(server);
        console.log(`[Viewer Left] ${camId}, Remaining Viewers: ${subs.size}`);

        // หากไม่มีผู้ชมเหลืออยู่เลย ให้สั่งกล้องประหยัดพลังงานกลับสู่ Standby
        if (subs.size === 0 && camState && camState.ws && camState.ws.readyState === WebSocket.OPEN) {
          camState.ws.send(JSON.stringify({
            type: "standby",
            viewers: 0
          }));
        }
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    // หน้าต้อนรับและคำแนะนำ
    return new Response(`
      <h2>📡 Cloudflare WebSocket Stream Relay</h2>
      <p>ระบบสตรีมสดอัจฉริยะ เทศบาลตำบลตันหยงมัส</p>
      <ul>
        <li>Camera WS: <code>wss://${url.host}/ws/camera?camId=CAM-TYM-01</code></li>
        <li>Client WS: <code>wss://${url.host}/ws/client?camId=CAM-TYM-01</code></li>
        <li>Snapshot: <a href="/snapshot?camId=CAM-TYM-01">/snapshot?camId=CAM-TYM-01</a></li>
        <li>Status: <a href="/status?camId=CAM-TYM-01">/status?camId=CAM-TYM-01</a></li>
      </ul>
    `, {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
};
