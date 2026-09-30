/**
 * Cloudflare Worker: Flood-CAM High-Speed Edge Relay (v2 - Durable Cache & Instant Wake)
 * เทศบาลตำบลตันหยงมัส (Tanyongmat Municipality Flood Monitoring)
 */

let memoryFrame = null;
let lastFrameTime = 0;
let frameCount = 0;
let wakeUntil = 0;

const AUTH_KEY = "TMSTUDIO_SECURE_TOKEN";
const CACHE_URL = "https://floodcam.internal/latest.jpg";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cache = caches.default;

    // 1. CORS Preflight
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
    // 2. ESP32-CAM ส่งภาพ Binary JPEG ขึ้นมา
    // ==========================================
    if (request.method === "POST" && url.pathname === "/upload") {
      const auth = request.headers.get("x-auth-key");
      if (auth !== AUTH_KEY) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { 
          status: 401, 
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } 
        });
      }

      try {
        const rawBuffer = await request.arrayBuffer();
        if (rawBuffer.byteLength > 100) {
          memoryFrame = rawBuffer;
          lastFrameTime = Date.now();
          frameCount++;

          // บันทึกลง Cloudflare Edge Cache เพื่อให้ทุกเครื่องทั่วโลกดึงได้พร้อมกัน
          const cacheResponse = new Response(rawBuffer, {
            headers: {
              "Content-Type": "image/jpeg",
              "Access-Control-Allow-Origin": "*",
              "Cache-Control": "public, max-age=60",
              "X-Frame-Time": lastFrameTime.toString()
            }
          });
          ctx.waitUntil(cache.put(CACHE_URL, cacheResponse.clone()));
        }

        return new Response(JSON.stringify({ 
          success: true, 
          isWake: Date.now() < wakeUntil,
          frameCount: frameCount 
        }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { 
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // ==========================================
    // 3. ปลุกกล้องให้สตรีมเร็ว (Wake-up) เมื่อมีคนกดดูจากมือถือ
    // ==========================================
    if (url.pathname === "/wake") {
      wakeUntil = Date.now() + 180000; // สตรีมเร็วต่อเนื่อง 3 นาที (180s)
      return new Response(JSON.stringify({ success: true, wakeUntil: wakeUntil }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // API ให้กล้องเช็คว่าต้องสตรีมเร็วหรือไม่
    if (url.pathname === "/check-wake") {
      const shouldStream = Date.now() < wakeUntil;
      return new Response(JSON.stringify({ 
        wake: shouldStream,
        remainingSec: Math.max(0, Math.round((wakeUntil - Date.now()) / 1000))
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // ==========================================
    // 4. หน้าเว็บ/มือถือ 4G/5G ดึงภาพสด (GET /latest.jpg)
    // ==========================================
    if (request.method === "GET" && (url.pathname === "/latest.jpg" || url.pathname === "/frame")) {
      // 4.1 ลองดึงจากหน่วยความจำ RAM ก่อน
      if (memoryFrame) {
        return new Response(memoryFrame, {
          status: 200,
          headers: {
            "Content-Type": "image/jpeg",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "X-Frame-Time": lastFrameTime.toString()
          }
        });
      }

      // 4.2 ถ้าใน RAM ยังไม่มี ลองดึงจาก Edge Cache
      const cached = await cache.match(CACHE_URL);
      if (cached) {
        return new Response(cached.body, {
          status: 200,
          headers: {
            "Content-Type": "image/jpeg",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"
          }
        });
      }

      // 4.3 หากกล้องเพิ่งเปิดและยังไม่ได้ยิงภาพแรก ส่งรูปกราฟิก Placeholder กลับไปแทน 404
      const placeholderSvg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">
          <rect width="640" height="480" fill="#0f172a"/>
          <text x="50%" y="45%" text-anchor="middle" fill="#38bdf8" font-family="sans-serif" font-size="22" font-weight="bold">
            📡 FLOOD-CAM TANYONGMAT
          </text>
          <text x="50%" y="55%" text-anchor="middle" fill="#94a3b8" font-family="sans-serif" font-size="16">
            กำลังรอเชื่อมต่อสัญญาณจากกล้อง ESP32-CAM...
          </text>
          <circle cx="320" cy="320" r="16" fill="none" stroke="#38bdf8" stroke-width="4" stroke-dasharray="25 25">
            <animateTransform attributeName="transform" type="rotate" from="0 320 320" to="360 320 320" dur="1.5s" repeatCount="indefinite"/>
          </circle>
        </svg>
      `;

      return new Response(placeholderSvg, {
        status: 200,
        headers: {
          "Content-Type": "image/svg+xml",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store, no-cache, must-revalidate"
        }
      });
    }

    // ==========================================
    // 5. ตรวจสอบสถานะการเชื่อมต่อกล้อง
    // ==========================================
    if (request.method === "GET" && url.pathname === "/status") {
      const ageMs = Date.now() - lastFrameTime;
      const isOnline = lastFrameTime > 0 && ageMs < 15000;

      return new Response(JSON.stringify({
        project: "Flood-CAM Edge Relay v2",
        municipality: "เทศบาลตำบลตันหยงมัส",
        cameraOnline: isOnline,
        lastSeenMsAgo: lastFrameTime > 0 ? ageMs : null,
        totalFrames: frameCount,
        isWakeActive: Date.now() < wakeUntil
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    return new Response("🚀 Flood-CAM Cloudflare Fast Edge Relay v2 Running!", { 
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" }
    });
  }
};
