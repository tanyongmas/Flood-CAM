/**
 * Cloudflare Worker: Flood-CAM High-Speed Edge Relay (v3 - Origin-Matched Durable Cache)
 * เทศบาลตำบลตันหยงมัส (Tanyongmat Municipality Flood Monitoring)
 */

let memoryFrame = null;
let lastFrameTime = 0;
let frameCount = 0;
let wakeUntil = 0;

const AUTH_KEY = "TMSTUDIO_SECURE_TOKEN";

// สร้าง Cache Key ที่ตรงกับ Hostname ของ Worker เสมอ (ป้องกัน Origin Mismatch)
function getCacheKey(request) {
  const origin = new URL(request.url).origin;
  return new Request(`${origin}/latest.jpg`, { method: "GET" });
}

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

          // บันทึกลง Cloudflare Edge Cache ด้วย Origin ของ Worker ที่ถูกต้อง
          const cacheKey = getCacheKey(request);
          const cacheResponse = new Response(rawBuffer, {
            headers: {
              "Content-Type": "image/jpeg",
              "Access-Control-Allow-Origin": "*",
              "Cache-Control": "public, max-age=120",
              "X-Frame-Time": lastFrameTime.toString()
            }
          });
          
          ctx.waitUntil(cache.put(cacheKey, cacheResponse));
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
      wakeUntil = Date.now() + 180000; // สตรีมเร็วต่อเนื่อง 3 นาที
      return new Response(JSON.stringify({ success: true, wakeUntil: wakeUntil }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // ==========================================
    // 4. หน้าเว็บ/มือถือ 4G/5G ดึงภาพสด (GET /latest.jpg)
    // ==========================================
    if (request.method === "GET" && (url.pathname === "/latest.jpg" || url.pathname === "/frame")) {
      // 4.1 ตรวจสอบใน Memory RAM ก่อน
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

      // 4.2 ตรวจสอบใน Edge Cache
      try {
        const cacheKey = getCacheKey(request);
        const cached = await cache.match(cacheKey);
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
      } catch (e) {
        // Cache read fallback
      }

      // 4.3 หากยังไม่มีรูปภาพใดๆ ให้ส่ง Placeholder กลับไป
      const placeholderSvg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="400" height="296" viewBox="0 0 400 296">
          <rect width="400" height="296" fill="#0f172a"/>
          <text x="50%" y="45%" text-anchor="middle" fill="#38bdf8" font-family="sans-serif" font-size="16" font-weight="bold">
            📡 FLOOD-CAM TANYONGMAT
          </text>
          <text x="50%" y="58%" text-anchor="middle" fill="#94a3b8" font-family="sans-serif" font-size="12">
            กำลังรอรับภาพจากกล้อง ESP32-CAM...
          </text>
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
        project: "Flood-CAM Edge Relay v3",
        municipality: "เทศบาลตำบลตันหยงมัส",
        cameraOnline: isOnline,
        lastSeenMsAgo: lastFrameTime > 0 ? ageMs : null,
        totalFrames: frameCount,
        hasMemoryFrame: memoryFrame !== null,
        isWakeActive: Date.now() < wakeUntil
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    return new Response("🚀 Flood-CAM Cloudflare Fast Edge Relay v3 Running!", { 
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" }
    });
  }
};
