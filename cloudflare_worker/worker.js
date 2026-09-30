/**
 * Cloudflare Worker: Flood-CAM High-Speed Edge Relay
 * เทศบาลตำบลตันหยงมัส (Tanyongmat Municipality Flood Monitoring)
 * 
 * คุณสมบัติ:
 * 1. รับภาพ Binary JPEG แท้ๆ จาก ESP32-CAM ผ่าน POST /upload (ไม่ต้องแปลง Base64)
 * 2. ให้หน้าเว็บเบราว์เซอร์/มือถือ 4G/5G ดึงภาพสดผ่าน GET /latest.jpg ด้วยความเร็ว 5-10 FPS
 * 3. มี API ตรวจสอบสถานะออนไลน์ของกล้อง GET /status
 */

// Memory Cache สำหรับเก็บบัฟเฟอร์รูปภาพล่าสุด
let cachedFrame = null;
let lastFrameTime = 0;
let frameCount = 0;

// Token ความปลอดภัยสำหรับให้เฉพาะ ESP32-CAM ของเราส่งภาพได้
const AUTH_KEY = "TMSTUDIO_SECURE_TOKEN";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // รองรับ CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, x-auth-key",
          "Access-Control-Max-Age": "86400",
        }
      });
    }

    // ==========================================
    // 1. ESP32-CAM ส่งภาพดิบ (Binary JPEG) ขึ้นมา
    // ==========================================
    if (request.method === "POST" && url.pathname === "/upload") {
      const auth = request.headers.get("x-auth-key");
      if (auth !== AUTH_KEY) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { 
          status: 401, 
          headers: { "Content-Type": "application/json" } 
        });
      }

      try {
        cachedFrame = await request.arrayBuffer();
        lastFrameTime = Date.now();
        frameCount++;

        return new Response(JSON.stringify({ 
          success: true, 
          frameSize: cachedFrame.byteLength,
          frameCount: frameCount
        }), {
          status: 200,
          headers: { 
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { 
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // ==========================================
    // 2. หน้าเว็บ/มือถือดึงภาพล่าสุดไปแสดงผล (High-Speed GET)
    // ==========================================
    if (request.method === "GET" && (url.pathname === "/latest.jpg" || url.pathname === "/frame")) {
      if (!cachedFrame) {
        return new Response("No image frame received yet from camera", { 
          status: 404,
          headers: {
            "Content-Type": "text/plain",
            "Access-Control-Allow-Origin": "*"
          }
        });
      }

      return new Response(cachedFrame, {
        status: 200,
        headers: {
          "Content-Type": "image/jpeg",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
          "Pragma": "no-cache",
          "X-Frame-Time": lastFrameTime.toString(),
          "X-Frame-Age-Ms": (Date.now() - lastFrameTime).toString()
        }
      });
    }

    // ==========================================
    // 3. API ตรวจสอบสถานะกล้อง (ออนไลน์/ออฟไลน์)
    // ==========================================
    if (request.method === "GET" && url.pathname === "/status") {
      const ageMs = Date.now() - lastFrameTime;
      const isOnline = lastFrameTime > 0 && ageMs < 10000; // ส่งภาพมาภายใน 10 วินาทีล่าสุด

      return new Response(JSON.stringify({
        project: "Flood-CAM Edge Relay",
        municipality: "เทศบาลตำบลตันหยงมัส",
        cameraOnline: isOnline,
        lastSeenMsAgo: lastFrameTime > 0 ? ageMs : null,
        lastFrameTime: lastFrameTime,
        totalFrames: frameCount,
        frameSize: cachedFrame ? cachedFrame.byteLength : 0
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // Default info response
    return new Response(
      "🚀 Flood-CAM Cloudflare Fast Edge Relay is Running!\n" +
      "Endpoints:\n" +
      " - POST /upload      : Binary JPEG push from ESP32-CAM\n" +
      " - GET  /latest.jpg  : Live image for Web/Mobile UI\n" +
      " - GET  /status      : Telemetry & Online Status\n", 
      { 
        status: 200,
        headers: { 
          "Content-Type": "text/plain; charset=utf-8",
          "Access-Control-Allow-Origin": "*"
        }
      }
    );
  }
};
