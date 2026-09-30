/**
 * =========================================================================================
 * แดชบอร์ดระบบกล้องตรวจวัดและเฝ้าระวังอุทกภัย เทศบาลตำบลตันหยงมัส
 * Minimal Clean Light On-Demand Streaming Controller (Centered View Only)
 * =========================================================================================
 */

// ค่าเริ่มต้นระบบและกล้อง
const DEFAULT_CAMERA_CONFIG = {
  id: "CAM-TYM-01",
  name: "จุดที่ 1: ถนนประชาสามัคคี ชุมชนตลาดกลางผลไม้",
  lat: 6.2845,
  lng: 101.7340,
  ip: "192.168.1.109",
  control_port: 80,
  stream_port: 81,
  rtsp_port: 8554,
  alert_threshold: 180,
  bank_level: 250,
  admin_password: "admin1234",
  cf_worker_url: "https://flood-cam1.tonyongmas-app.workers.dev",
  gas_url: "https://script.google.com/macros/s/AKfycbwiE9fu8R9GRQ9LJoD4UXnz3K7PKV6Nip3JGMzVVOznZR0wvq5f7oHEwEfuIuh_F6in/exec",
  network_mode: "auto", // "auto" | "local" | "cloud"
  wifi_ssid: "TMSTUDIO",
  wifi_pass: "026830TM"
};

// โหลดค่าจากการตั้งค่าของผู้ใช้ในเบราว์เซอร์ (localStorage)
let CAMERA_CONFIG = loadCameraConfig();

function loadCameraConfig() {
  try {
    const saved = localStorage.getItem('ESP32CAM_CONFIG');
    if (saved) {
      const parsed = JSON.parse(saved);
      delete parsed.preferred_mode;
      if (!parsed.cf_worker_url) {
        parsed.cf_worker_url = DEFAULT_CAMERA_CONFIG.cf_worker_url;
      }
      if (parsed.ip === "192.168.1.36") {
        parsed.ip = DEFAULT_CAMERA_CONFIG.ip;
      }
      return Object.assign({}, DEFAULT_CAMERA_CONFIG, parsed);
    }
  } catch (e) {
    console.warn("Failed to load config from localStorage", e);
  }
  return Object.assign({}, DEFAULT_CAMERA_CONFIG);
}

let map = null;
let tileLayers = {};
let currentLayer = 'osm';
let cameraMarker = null;
let isStreaming = false;
let flashDebounceTimer = null;
let isPickingOnMap = false;
let isMarkerDraggable = false;

// ข้อมูลสถานะล่าสุด
let latestTelemetry = {
  waterLevel: null,
  battery: null,
  rssi: null,
  source: 'กำลังเชื่อมต่อ...'
};

// =========================================================================
// Initialization
// =========================================================================
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  updateUIFromConfig();
  syncRealData();

  // ดึงข้อมูลโทรมาตรระดับน้ำทุกๆ 15 วินาที
  setInterval(syncRealData, 15000);

  // รองรับการกดปุ่ม ESC เพื่อปิด Modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (isPickingOnMap) cancelMapPicker();
      closeAdminModal();
      closeAdminAuth();
      closeLiveModal();
    }
  });
});

function updateUIFromConfig() {
  const nameEl = document.getElementById('dockCamName');
  const metaEl = document.getElementById('dockCamMeta');
  const streamMetaEl = document.getElementById('streamCamIdTag');
  const alertEl = document.getElementById('dockAlertLevel');
  const bankEl = document.getElementById('dockBankLevel');

  if (nameEl) nameEl.innerText = CAMERA_CONFIG.name;
  if (metaEl) metaEl.innerText = `${CAMERA_CONFIG.id} • IP: ${CAMERA_CONFIG.ip}`;
  if (streamMetaEl) streamMetaEl.innerText = `${CAMERA_CONFIG.id} • ${CAMERA_CONFIG.ip}`;
  if (alertEl) alertEl.innerText = `${parseFloat(CAMERA_CONFIG.alert_threshold || 180).toFixed(1)} ซม.`;
  if (bankEl) bankEl.innerText = `${parseFloat(CAMERA_CONFIG.bank_level || 250).toFixed(1)} ซม.`;

  updateStreamModeBadge();
}

// =========================================================================
// Leaflet Map (OSM & Satellite Imagery)
// =========================================================================
function initMap() {
  tileLayers.osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap | เทศบาลตำบลตันหยงมัส'
  });

  tileLayers.satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri &mdash; ภาพถ่ายดาวเทียม ทต.ตันหยงมัส'
  });

  tileLayers.dark = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    attribution: '&copy; CARTO'
  });

  map = L.map('map', {
    center: [CAMERA_CONFIG.lat, CAMERA_CONFIG.lng],
    zoom: 16,
    zoomControl: false,
    layers: [tileLayers.osm]
  });

  L.control.zoom({ position: 'bottomleft' }).addTo(map);

  // วาดหมุดกล้องบนแผนที่
  renderCameraMarker();
}

function switchMapLayer(layerName) {
  if (!tileLayers[layerName]) return;
  Object.values(tileLayers).forEach(layer => map.removeLayer(layer));
  tileLayers[layerName].addTo(map);
  currentLayer = layerName;

  document.querySelectorAll('.btn-layer-switch').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.layer === layerName);
  });
}

function renderCameraMarker() {
  if (cameraMarker) {
    map.removeLayer(cameraMarker);
  }

  const customIcon = L.divIcon({
    className: 'clean-marker',
    html: `
      <div class="clean-pin-pulse"></div>
      <div class="clean-pin-core" title="${CAMERA_CONFIG.name}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
          <circle cx="12" cy="13" r="4"></circle>
        </svg>
      </div>
    `,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
    popupAnchor: [0, -18]
  });

  cameraMarker = L.marker([CAMERA_CONFIG.lat, CAMERA_CONFIG.lng], { 
    icon: customIcon,
    draggable: isMarkerDraggable
  }).addTo(map);

  cameraMarker.on('dragend', function (e) {
    const pos = e.target.getLatLng();
    CAMERA_CONFIG.lat = parseFloat(pos.lat.toFixed(6));
    CAMERA_CONFIG.lng = parseFloat(pos.lng.toFixed(6));
    
    const latInp = document.getElementById('cfgLat');
    const lngInp = document.getElementById('cfgLng');
    if (latInp) latInp.value = CAMERA_CONFIG.lat;
    if (lngInp) lngInp.value = CAMERA_CONFIG.lng;

    saveCameraConfigToStorage();
    bindCameraPopup();
  });

  bindCameraPopup();
}

function bindCameraPopup() {
  if (!cameraMarker) return;

  const alertVal = parseFloat(CAMERA_CONFIG.alert_threshold || 180);
  const bankVal = parseFloat(CAMERA_CONFIG.bank_level || 250);
  const waterVal = (latestTelemetry.waterLevel !== null && latestTelemetry.waterLevel !== undefined)
    ? parseFloat(latestTelemetry.waterLevel)
    : null;

  const waterText = (waterVal !== null) ? `${waterVal.toFixed(1)} ซม.` : '-- ซม.';
  const alertText = `${alertVal.toFixed(1)} ซม.`;
  const bankText = `${bankVal.toFixed(1)} ซม.`;

  let statusColor = '#059669';
  let statusLabel = 'ระดับน้ำปกติ';
  if (waterVal !== null) {
    if (waterVal >= bankVal) {
      statusColor = '#e11d48';
      statusLabel = '⚠️ น้ำล้นตลิ่งวิกฤต';
    } else if (waterVal >= alertVal) {
      statusColor = '#d97706';
      statusLabel = '⚠️ เฝ้าระวังเตือนภัย';
    }
  }

  const isAlertOrAbove = (waterVal !== null && waterVal >= alertVal);

  const popupContent = `
    <div style="font-family:'Prompt',sans-serif; min-width:240px; padding:3px 2px;">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">
        <span style="font-size:0.7rem; font-weight:700; color:#2563eb; background:#eff6ff; padding:2px 8px; border-radius:999px;">
          ${CAMERA_CONFIG.id}
        </span>
        <span style="font-size:0.72rem; font-weight:600; color:${statusColor};">
          ${statusLabel}
        </span>
      </div>

      <div style="font-weight:700; font-size:0.92rem; color:#0f172a; line-height:1.35; margin-bottom:8px;">
        ${CAMERA_CONFIG.name}
      </div>

      <!-- สรุปข้อมูล: ระดับน้ำปัจจุบัน, ระดับเตือนภัย, ระดับตลิ่ง -->
      <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:8px 10px; margin-bottom:10px; display:flex; flex-direction:column; gap:6px;">
        <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px dashed #e2e8f0; padding-bottom:5px;">
          <span style="font-size:0.74rem; color:#475569; font-weight:500;">💧 ระดับน้ำปัจจุบัน:</span>
          <strong style="font-size:0.96rem; color:${isAlertOrAbove ? '#e11d48' : '#059669'}; font-weight:800;">
            ${waterText}
          </strong>
        </div>
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <span style="font-size:0.72rem; color:#64748b;">⚠️ ระดับการเตือนภัย:</span>
          <span style="font-size:0.8rem; color:#d97706; font-weight:700;">${alertText}</span>
        </div>
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <span style="font-size:0.72rem; color:#64748b;">🌊 ระดับตลิ่ง:</span>
          <span style="font-size:0.8rem; color:#e11d48; font-weight:700;">${bankText}</span>
        </div>
      </div>

      <!-- ปุ่มดูภาพสดกลางจอ (ปุ่มเดียว ไม่มีมุมจอ และไม่มีปุ่มตั้งค่า) -->
      <button onclick="openLiveModal()" style="width:100%; background:#2563eb; color:#fff; border:none; padding:9px 12px; border-radius:7px; font-weight:700; font-size:0.82rem; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:6px; box-shadow:0 2px 6px rgba(37,99,235,0.25);">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
          <polygon points="5 3 19 12 5 21 5 3"></polygon>
        </svg>
        <span>ดูภาพสด (Live Stream)</span>
      </button>
    </div>
  `;
  cameraMarker.bindPopup(popupContent);
}

function getControlBaseUrl() {
  const host = (CAMERA_CONFIG.ip || '').trim();
  if (host.startsWith('http://') || host.startsWith('https://')) {
    return host.replace(/\/+$/, '');
  }
  const port = CAMERA_CONFIG.control_port;
  return (port && port != 80) ? `http://${host}:${port}` : `http://${host}`;
}

function getStreamUrl() {
  const host = (CAMERA_CONFIG.ip || '').trim();
  if (host.startsWith('http://') || host.startsWith('https://')) {
    return `${host.replace(/\/+$/, '')}/stream`;
  }
  const port = CAMERA_CONFIG.stream_port || 81;
  return `http://${host}:${port}/stream`;
}

// =========================================================================
// Live Stream Player (เปิดแบบเด้งขึ้นกลางจอเท่านั้น)
// =========================================================================
function openLiveModal() {
  const backdrop = document.getElementById('liveModalBackdrop');
  if (backdrop) backdrop.style.display = 'flex';

  // เริ่มสตรีมภาพสดทันที
  startLiveStream();
}

function closeLiveModal() {
  stopLiveStream();
  const backdrop = document.getElementById('liveModalBackdrop');
  if (backdrop) backdrop.style.display = 'none';
}

function handleLiveBackdropClick(event) {
  if (event.target === document.getElementById('liveModalBackdrop')) {
    closeLiveModal();
  }
}

let videoTimestampTimer = null;

function updateVideoTimestamp() {
  const tsEl = document.getElementById('videoTimestampText');
  if (!tsEl) return;
  const now = new Date();
  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = now.getFullYear();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');

  tsEl.innerText = `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
}

function startVideoTimestamp() {
  const overlay = document.getElementById('videoTimestamp');
  if (overlay) overlay.style.display = 'flex';
  updateVideoTimestamp();
  clearInterval(videoTimestampTimer);
  videoTimestampTimer = setInterval(updateVideoTimestamp, 1000);
}

function stopVideoTimestamp() {
  const overlay = document.getElementById('videoTimestamp');
  if (overlay) overlay.style.display = 'none';
  clearInterval(videoTimestampTimer);
  videoTimestampTimer = null;
}

let cloudSnapshotTimer = null;
let wakeKeepAliveTimer = null;
let currentStreamMode = 'idle'; // 'local' | 'cloud' | 'idle'

function toggleStreamState() {
  if (isStreaming) {
    stopLiveStream();
  } else {
    startLiveStream();
  }
}

function startLiveStream() {
  isStreaming = true;
  const streamImg = document.getElementById('liveStreamImg');
  const placeholder = document.getElementById('streamPlaceholder');
  const indicator = document.getElementById('liveIndicator');
  const statusText = document.getElementById('liveStatusText');
  const toggleBtn = document.getElementById('btnToggleStream');

  // UI สถานะเริ่มเชื่อมต่อ
  indicator.className = 'live-indicator active';
  statusText.innerText = '🔄 กำลังเชื่อมต่อกล้อง...';
  toggleBtn.innerText = '⏹ หยุดสตรีมภาพ';
  toggleBtn.style.color = 'var(--accent-rose)';

  // เริ่ม Timestamp เวลาปัจจุบันบนมุมบนซ้ายของวิดีโอ
  startVideoTimestamp();

  // ส่งคำสั่ง Wake ปลุกกล้องให้สตรีมเร็ว
  if (CAMERA_CONFIG.cf_worker_url && CAMERA_CONFIG.cf_worker_url.includes("workers.dev")) {
    const cfBase = CAMERA_CONFIG.cf_worker_url.replace(/\/+$/, '');
    fetch(`${cfBase}/wake`, { mode: 'cors' }).catch(() => {});
  }

  // ส่ง Wake ไปยัง Local LAN เฉพาะเมื่อไม่ได้เลือกเจาะจง Cloud Mode (ป้องกัน net::ERR_CONNECTION_TIMED_OUT)
  if (CAMERA_CONFIG.network_mode !== 'cloud') {
    fetch(`${getControlBaseUrl()}/wake`, { mode: 'no-cors' }).catch(() => {});
  }

  if (CAMERA_CONFIG.gas_url) {
    fetch(`${CAMERA_CONFIG.gas_url}?action=wakeCamera&camId=${encodeURIComponent(CAMERA_CONFIG.id)}`).catch(() => {});
  }

  // ส่งสัญญาณปลุก (Keep-Alive) ซ้ำทุกๆ 45 วินาที เพื่อให้กล้องสตรีมต่อเนื่อง
  clearInterval(wakeKeepAliveTimer);
  wakeKeepAliveTimer = setInterval(() => {
    if (!isStreaming) return;
    if (CAMERA_CONFIG.cf_worker_url && CAMERA_CONFIG.cf_worker_url.includes("workers.dev")) {
      const cfBase = CAMERA_CONFIG.cf_worker_url.replace(/\/+$/, '');
      fetch(`${cfBase}/wake`, { mode: 'cors' }).catch(() => {});
    }
    if (CAMERA_CONFIG.network_mode !== 'cloud') {
      fetch(`${getControlBaseUrl()}/wake`, { mode: 'no-cors' }).catch(() => {});
    }
    if (CAMERA_CONFIG.gas_url) {
      fetch(`${CAMERA_CONFIG.gas_url}?action=wakeCamera&camId=${encodeURIComponent(CAMERA_CONFIG.id)}`).catch(() => {});
    }
  }, 45000);

  const mode = CAMERA_CONFIG.network_mode || 'auto';

  // กรณีที่ 1: เลือกโหมดวงเดียวกัน (Local LAN) -> สตรีมสดความเร็วสูงทันที
  if (mode === 'local') {
    currentStreamMode = 'local';
    updateStreamModeBadge();
    streamImg.src = `${getStreamUrl()}?t=${Date.now()}`;
    streamImg.style.display = 'block';
    placeholder.style.display = 'none';
    statusText.innerText = '🟢 กำลังสตรีมภาพสด (LAN 25 FPS)';
    return;
  }

  // กรณีที่ 2: เลือกโหมด 4G วงนอก -> สตรีมผ่าน Google Apps Script Snapshot Relay ทันที
  if (mode === 'cloud') {
    currentStreamMode = 'cloud';
    updateStreamModeBadge();
    startCloudSnapshotRelay();
    return;
  }

  // กรณีโหมดอัตโนมัติ (auto): ทดสอบการเชื่อมต่อ Local LAN ก่อน (1.2 วินาที)
  updateStreamModeBadge();
  let isLocalSuccess = false;
  const probeImg = new Image();

  const fallbackTimer = setTimeout(() => {
    if (!isLocalSuccess && isStreaming) {
      console.log("[Stream] Local LAN unreachable -> Starting Cloud Snapshot Relay");
      probeImg.src = '';
      probeImg.onload = null;
      probeImg.onerror = null;
      startCloudSnapshotRelay();
    }
  }, 1200);

  probeImg.onload = () => {
    if (!isStreaming) return;
    isLocalSuccess = true;
    clearTimeout(fallbackTimer);
    currentStreamMode = 'local';
    updateStreamModeBadge();
    streamImg.src = `${getStreamUrl()}?t=${Date.now()}`;
    streamImg.style.display = 'block';
    placeholder.style.display = 'none';
    statusText.innerText = '🟢 กำลังสตรีมภาพสด (LAN 25 FPS)';
  };

  probeImg.onerror = () => {
    if (!isStreaming) return;
    clearTimeout(fallbackTimer);
    if (!isLocalSuccess) {
      console.log("[Stream] Local LAN error -> Starting Cloud Snapshot Relay");
      startCloudSnapshotRelay();
    }
  };

  probeImg.src = `${getControlBaseUrl()}/capture?t=${Date.now()}`;
}

// วิธีที่ 1 & C1: Cloud Relay (รองรับ Cloudflare Fast Edge 5-10 FPS หรือ Google Apps Script)
function startCloudSnapshotRelay() {
  if (!isStreaming) return;
  currentStreamMode = 'cloud';
  updateStreamModeBadge();
  const streamImg = document.getElementById('liveStreamImg');
  const placeholder = document.getElementById('streamPlaceholder');
  const statusText = document.getElementById('liveStatusText');

  // แนวทาง C1: หากมีการระบุ Cloudflare Worker URL ให้สตรีมสดความเร็วสูง 5-10 FPS
  if (CAMERA_CONFIG.cf_worker_url && CAMERA_CONFIG.cf_worker_url.includes("workers.dev")) {
    const cfBase = CAMERA_CONFIG.cf_worker_url.replace(/\/+$/, '');
    statusText.innerText = '⚡ Cloudflare Fast Edge: กำลังเชื่อมต่อสตรีมสดความเร็วสูง...';

    let isEdgeFetching = false;
    let frameCounter = 0;
    let fpsStart = Date.now();
    let currentFps = '5.0';

    const fetchEdgeFrame = () => {
      if (!isStreaming || currentStreamMode !== 'cloud' || isEdgeFetching) return;
      isEdgeFetching = true;

      const preImg = new Image();
      preImg.onload = () => {
        if (!isStreaming || currentStreamMode !== 'cloud') {
          isEdgeFetching = false;
          return;
        }
        streamImg.src = preImg.src;
        streamImg.style.display = 'block';
        placeholder.style.display = 'none';

        frameCounter++;
        const elapsed = (Date.now() - fpsStart) / 1000;
        if (elapsed >= 2.0) {
          currentFps = (frameCounter / elapsed).toFixed(1);
          frameCounter = 0;
          fpsStart = Date.now();
        }
        statusText.innerText = `⚡ Cloudflare Fast Edge (${currentFps} FPS • ความหน่วงต่ำ)`;
        isEdgeFetching = false;
      };

      preImg.onerror = () => {
        isEdgeFetching = false;
        statusText.innerText = '⚡ Cloudflare Edge: กำลังรอเฟรมภาพสดจากกล้อง...';
      };

      preImg.src = `${cfBase}/latest.jpg?t=${Date.now()}`;
    };

    fetchEdgeFrame();
    clearInterval(cloudSnapshotTimer);
    cloudSnapshotTimer = setInterval(fetchEdgeFrame, 120); // Polling ทุก 120ms (~8 FPS)
    return;
  }

  // แนวทางเดิม (A): Google Apps Script Snapshot Relay (สำรอง)
  statusText.innerText = '☁️ โหมด Cloud Relay: กำลังดึงภาพสดข้ามเครือข่าย...';

  let isFetching = false;
  const fetchCloudFrame = async () => {
    if (!isStreaming || currentStreamMode !== 'cloud' || isFetching) return;
    isFetching = true;
    try {
      const gasUrl = CAMERA_CONFIG.gas_url || DEFAULT_CAMERA_CONFIG.gas_url;
      const res = await fetch(`${gasUrl}?action=getLatestSnapshot&camId=${encodeURIComponent(CAMERA_CONFIG.id)}&t=${Date.now()}`);
      if (res.ok) {
        const data = await res.json();
        if (data && data.success && data.image) {
          // โหลดภาพแบบ Offscreen ก่อนแสดงจริง ป้องกันการกะพริบ (100% Flicker-Free)
          const preImg = new Image();
          preImg.onload = () => {
            if (!isStreaming || currentStreamMode !== 'cloud') return;
            streamImg.src = preImg.src;
            streamImg.style.display = 'block';
            placeholder.style.display = 'none';
            const updateSecAgo = Math.max(0, Math.round((Date.now() - (data.updatedAt || Date.now())) / 1000));
            statusText.innerText = `☁️ Cloud Snapshot Relay (อัปเดต ${updateSecAgo}s ที่แล้ว)`;
          };
          preImg.src = data.image;
        } else {
          statusText.innerText = '☁️ Cloud Relay: รอภาพแรกจากกล้องกำลังส่งขึ้นคลาวด์...';
        }
      }
    } catch (e) {
      console.warn("Cloud snapshot fetch error", e);
      statusText.innerText = '⚠️ การเชื่อมต่อ Cloud Relay ขัดข้อง กำลังลองใหม่...';
    } finally {
      isFetching = false;
    }
  };

  fetchCloudFrame();
  clearInterval(cloudSnapshotTimer);
  cloudSnapshotTimer = setInterval(fetchCloudFrame, 1600);
}

function stopLiveStream() {
  isStreaming = false;
  currentStreamMode = 'idle';
  updateStreamModeBadge();
  clearInterval(cloudSnapshotTimer);
  cloudSnapshotTimer = null;
  clearInterval(wakeKeepAliveTimer);
  wakeKeepAliveTimer = null;

  const streamImg = document.getElementById('liveStreamImg');
  const placeholder = document.getElementById('streamPlaceholder');
  const indicator = document.getElementById('liveIndicator');
  const statusText = document.getElementById('liveStatusText');
  const toggleBtn = document.getElementById('btnToggleStream');

  // ส่งคำสั่งหยุดสตรีมไปที่กล้อง
  fetch(`${getControlBaseUrl()}/stop`, { mode: 'no-cors' }).catch(() => {});

  // หยุด Timestamp Overlay
  stopVideoTimestamp();

  // รีเซ็ตการแสดงภาพ
  streamImg.src = '';
  streamImg.style.display = 'none';
  placeholder.style.display = 'flex';

  // ปรับสถานะ UI
  indicator.className = 'live-indicator';
  statusText.innerText = 'โหมดสแตนด์บาย (Standby)';
  toggleBtn.innerText = '▶ เริ่มดูภาพสด';
  toggleBtn.style.color = '';
}

// อัปเดตป้ายสถานะโหมดการสตรีมบนหัวต่างหน้าสตรีม
function updateStreamModeBadge() {
  const badge = document.getElementById('streamModeBadge');
  if (!badge) return;
  const cfgMode = CAMERA_CONFIG.network_mode || 'auto';
  if (cfgMode === 'local' || currentStreamMode === 'local') {
    badge.innerText = '🏠 วงใน RTSP 25 FPS';
    badge.style.background = '#eff6ff';
    badge.style.color = '#2563eb';
    badge.style.borderColor = '#bfdbfe';
  } else if (cfgMode === 'cloud' || currentStreamMode === 'cloud') {
    badge.innerText = '☁️ 4G Cloud Relay';
    badge.style.background = '#f0fdf4';
    badge.style.color = '#16a34a';
    badge.style.borderColor = '#bbf7d0';
  } else {
    badge.innerText = '🔄 โหมดอัตโนมัติ (Auto)';
    badge.style.background = '#f8fafc';
    badge.style.color = '#475569';
    badge.style.borderColor = '#cbd5e1';
  }
}

// สลับโหมดการสตรีมด่วนจากหัวหน้าต่างสตรีมสด
function cycleLiveStreamMode() {
  const current = CAMERA_CONFIG.network_mode || 'auto';
  let next = 'auto';
  if (current === 'auto') next = 'local';
  else if (current === 'local') next = 'cloud';
  else if (current === 'cloud') next = 'auto';

  CAMERA_CONFIG.network_mode = next;
  saveCameraConfigToStorage();
  updateStreamModeBadge();

  const netSelect = document.getElementById('cfgNetworkMode');
  if (netSelect) netSelect.value = next;

  if (isStreaming) {
    if (next === 'local') {
      clearInterval(cloudSnapshotTimer);
      cloudSnapshotTimer = null;
      currentStreamMode = 'local';
      const streamImg = document.getElementById('liveStreamImg');
      const placeholder = document.getElementById('streamPlaceholder');
      const statusText = document.getElementById('liveStatusText');
      streamImg.src = `${getStreamUrl()}?t=${Date.now()}`;
      streamImg.style.display = 'block';
      placeholder.style.display = 'none';
      statusText.innerText = '🟢 กำลังสตรีมภาพสด (LAN 25 FPS)';
      updateStreamModeBadge();
    } else if (next === 'cloud') {
      startCloudSnapshotRelay();
    } else {
      startLiveStream();
    }
  }
}

// คัดลอก RTSP URL สำหรับ VLC Player หรือ NVR
function copyRtspUrl() {
  const port = CAMERA_CONFIG.rtsp_port || 8554;
  const rtspUrl = `rtsp://${CAMERA_CONFIG.ip}:${port}/mjpeg/1`;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(rtspUrl).then(() => {
      alert(`📋 คัดลอก RTSP URL เรียบร้อยแล้ว:\n${rtspUrl}\n\nสามารถนำไปเปิดใน VLC Media Player หรือบันทึกลงเครื่อง NVR ได้ทันที`);
    }).catch(() => {
      prompt("คัดลอก RTSP URL สำหรับ VLC / NVR:", rtspUrl);
    });
  } else {
    prompt("คัดลอก RTSP URL สำหรับ VLC / NVR:", rtspUrl);
  }
}

// =========================================================================
// Instant Flash LED Control (ตอบสนองฉับไวทันทีใน 5 มิลลิวินาที)
// =========================================================================
function changeFlashBrightness(val) {
  document.getElementById('flashValText').innerText = `${val}%`;

  clearTimeout(flashDebounceTimer);
  flashDebounceTimer = setTimeout(() => {
    const pwmVal = Math.round((val / 100) * 255);
    // ส่งคำสั่งตรงไปยัง Control Server
    fetch(`${getControlBaseUrl()}/flash?val=${pwmVal}`, { mode: 'no-cors' }).catch(() => {});
  }, 30);
}

// =========================================================================
// Real-time Data Sync (ระดับน้ำ)
// =========================================================================
async function syncRealData() {
  // ดึงค่าโดยตรงจาก IP ในแลนก่อน (เร็วที่สุด)
  try {
    const localRes = await fetch(`${getControlBaseUrl()}/status`, { timeout: 1500 });
    if (localRes.ok) {
      const data = await localRes.json();
      updateTelemetryUI(data.water_level, data.battery, data.rssi, "ออนไลน์ (ผ่านแลน)");
      return;
    }
  } catch (e) {}

  // หากอยู่นอกแลน ดึงจาก Google Apps Script
  try {
    const cloudRes = await fetch(`${CAMERA_CONFIG.gas_url}?action=getCamerasStatus`);
    if (cloudRes.ok) {
      const data = await cloudRes.json();
      if (data && data.cameras && data.cameras[CAMERA_CONFIG.id]) {
        const camData = data.cameras[CAMERA_CONFIG.id];
        updateTelemetryUI(camData.waterLevel, camData.battery, camData.rssi, camData.updatedAtThai || "ผ่านคลาวด์");
      }
    }
  } catch (e) {}
}

function updateTelemetryUI(waterLevel, battery, rssi, source) {
  const waterEl = document.getElementById('dockWaterLevel');
  const alertEl = document.getElementById('dockAlertLevel');
  const bankEl = document.getElementById('dockBankLevel');
  const syncEl = document.getElementById('dockLastSync');
  const alertThreshold = parseFloat(CAMERA_CONFIG.alert_threshold || 180);
  const bankLevel = parseFloat(CAMERA_CONFIG.bank_level || 250);

  latestTelemetry.waterLevel = waterLevel;
  latestTelemetry.battery = battery;
  latestTelemetry.rssi = rssi;
  latestTelemetry.source = source;

  // อัปเดตการแสดงผลระดับน้ำปัจจุบัน
  if (waterLevel !== undefined && waterLevel !== null) {
    const val = parseFloat(waterLevel);
    if (waterEl) {
      waterEl.innerText = `${val.toFixed(1)} ซม.`;
      if (val >= bankLevel) {
        waterEl.style.color = 'var(--accent-rose)';
      } else if (val >= alertThreshold) {
        waterEl.style.color = 'var(--accent-amber)';
      } else {
        waterEl.style.color = 'var(--accent-green)';
      }
    }
  } else {
    if (waterEl) waterEl.innerText = '-- ซม.';
  }

  // อัปเดตระดับเตือนภัย และ ระดับตลิ่ง
  if (alertEl) alertEl.innerText = `${alertThreshold.toFixed(1)} ซม.`;
  if (bankEl) bankEl.innerText = `${bankLevel.toFixed(1)} ซม.`;

  if (syncEl) {
    syncEl.innerText = `อัปเดต: ${source}`;
  }

  // อัปเดตเนื้อหาใน Popup ของหมุดแผนที่ด้วย
  bindCameraPopup();
}

// =========================================================================
// Snapshot & RTSP Copy
// =========================================================================
function takeSnapshot() {
  const streamImg = document.getElementById('liveStreamImg');
  // หากอยู่ในโหมด Cloud Snapshot Relay ให้ดาวน์โหลดรูปจาก Base64 ทันที
  if (streamImg && streamImg.src && streamImg.src.startsWith('data:image')) {
    const a = document.createElement('a');
    a.href = streamImg.src;
    a.download = `ESP32CAM_${CAMERA_CONFIG.id}_${Date.now()}.jpg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return;
  }

  const a = document.createElement('a');
  a.href = `${getControlBaseUrl()}/capture?t=${Date.now()}`;
  a.download = `ESP32CAM_${CAMERA_CONFIG.id}_${Date.now()}.jpg`;
  a.target = '_blank';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function copyRtspUrl() {
  const rtspUrl = `rtsp://${CAMERA_CONFIG.ip}:${CAMERA_CONFIG.rtsp_port}/mjpeg/1`;
  navigator.clipboard.writeText(rtspUrl).then(() => {
    alert(`คัดลอก RTSP Stream URL เรียบร้อย:\n${rtspUrl}\n\nสามารถนำไปเปิดในโปรแกรม VLC หรือระบบ NVR ได้ทันที`);
  });
}

// =========================================================================
// Admin Authentication (Password Gate ทุกครั้งที่กดเข้าโหมดแอดมิน)
// =========================================================================
function promptAdminAuth() {
  const backdrop = document.getElementById('adminAuthBackdrop');
  const passInp = document.getElementById('adminAuthPassword');
  const errBox = document.getElementById('authErrorMsg');

  if (passInp) passInp.value = '';
  if (errBox) errBox.style.display = 'none';

  backdrop.style.display = 'flex';
  setTimeout(() => {
    if (passInp) passInp.focus();
  }, 100);
}

function closeAdminAuth() {
  const backdrop = document.getElementById('adminAuthBackdrop');
  if (backdrop) backdrop.style.display = 'none';
}

function handleAuthBackdropClick(event) {
  if (event.target === document.getElementById('adminAuthBackdrop')) {
    closeAdminAuth();
  }
}

function togglePasswordVisibility(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.type = (input.type === 'password') ? 'text' : 'password';
}

function submitAdminAuth(event) {
  if (event) event.preventDefault();
  const input = document.getElementById('adminAuthPassword');
  const errBox = document.getElementById('authErrorMsg');
  const enteredPass = input.value;
  const currentPass = CAMERA_CONFIG.admin_password || "admin1234";

  if (enteredPass === currentPass) {
    closeAdminAuth();
    openAdminModal();
  } else {
    if (errBox) {
      errBox.style.display = 'block';
    }
    input.classList.add('auth-shake');
    setTimeout(() => input.classList.remove('auth-shake'), 400);
    input.select();
  }
}

// =========================================================================
// Admin Configuration Modal & Actions
// =========================================================================
function openAdminModal() {
  document.getElementById('cfgCamName').value = CAMERA_CONFIG.name;
  document.getElementById('cfgCamId').value = CAMERA_CONFIG.id;
  document.getElementById('cfgLat').value = CAMERA_CONFIG.lat;
  document.getElementById('cfgLng').value = CAMERA_CONFIG.lng;
  document.getElementById('cfgCamIp').value = CAMERA_CONFIG.ip;
  document.getElementById('cfgControlPort').value = CAMERA_CONFIG.control_port;
  document.getElementById('cfgStreamPort').value = CAMERA_CONFIG.stream_port;
  document.getElementById('cfgRtspPort').value = CAMERA_CONFIG.rtsp_port;
  document.getElementById('cfgAlertThreshold').value = CAMERA_CONFIG.alert_threshold || 180;
  document.getElementById('cfgBankLevel').value = CAMERA_CONFIG.bank_level || 250;
  document.getElementById('cfgNetworkMode').value = CAMERA_CONFIG.network_mode || "auto";
  document.getElementById('cfgWifiSsid').value = CAMERA_CONFIG.wifi_ssid || "TMSTUDIO";
  document.getElementById('cfgWifiPass').value = CAMERA_CONFIG.wifi_pass || "026830TM";
  document.getElementById('cfgCfWorkerUrl').value = CAMERA_CONFIG.cf_worker_url || "";
  document.getElementById('cfgGasUrl').value = CAMERA_CONFIG.gas_url;
  document.getElementById('cfgAdminPassword').value = CAMERA_CONFIG.admin_password || "admin1234";
  document.getElementById('cfgDraggableMarker').checked = isMarkerDraggable;

  const statusEl = document.getElementById('wifiSendStatus');
  if (statusEl) statusEl.style.display = 'none';

  document.getElementById('adminModalBackdrop').style.display = 'flex';
}

function closeAdminModal() {
  document.getElementById('adminModalBackdrop').style.display = 'none';
}

function handleBackdropClick(event) {
  if (event.target === document.getElementById('adminModalBackdrop')) {
    closeAdminModal();
  }
}

function saveAdminSettings() {
  const name = document.getElementById('cfgCamName').value.trim();
  const id = document.getElementById('cfgCamId').value.trim();
  const lat = parseFloat(document.getElementById('cfgLat').value);
  const lng = parseFloat(document.getElementById('cfgLng').value);
  const ip = document.getElementById('cfgCamIp').value.trim();
  const controlPort = parseInt(document.getElementById('cfgControlPort').value) || 80;
  const streamPort = parseInt(document.getElementById('cfgStreamPort').value) || 81;
  const rtspPort = parseInt(document.getElementById('cfgRtspPort').value) || 8554;
  const threshold = parseFloat(document.getElementById('cfgAlertThreshold').value) || 180;
  const bankLevel = parseFloat(document.getElementById('cfgBankLevel').value) || 250;
  const networkMode = document.getElementById('cfgNetworkMode').value || "auto";
  const wifiSsid = (document.getElementById('cfgWifiSsid').value || "").trim();
  const wifiPass = (document.getElementById('cfgWifiPass').value || "").trim();
  const cfWorkerUrl = (document.getElementById('cfgCfWorkerUrl').value || "").trim().replace(/\/+$/, '');
  const gasUrl = document.getElementById('cfgGasUrl').value.trim();
  const newPassword = document.getElementById('cfgAdminPassword').value.trim();

  if (!name || !id || !ip || isNaN(lat) || isNaN(lng)) {
    alert("กรุณากรอกข้อมูลให้ครบถ้วน (ชื่อ, รหัส, IP และพิกัดละติจูด/ลองจิจูด)");
    return;
  }

  CAMERA_CONFIG.name = name;
  CAMERA_CONFIG.id = id;
  CAMERA_CONFIG.lat = lat;
  CAMERA_CONFIG.lng = lng;
  CAMERA_CONFIG.ip = ip;
  CAMERA_CONFIG.control_port = controlPort;
  CAMERA_CONFIG.stream_port = streamPort;
  CAMERA_CONFIG.rtsp_port = rtspPort;
  CAMERA_CONFIG.alert_threshold = threshold;
  CAMERA_CONFIG.bank_level = bankLevel;
  CAMERA_CONFIG.network_mode = networkMode;
  CAMERA_CONFIG.wifi_ssid = wifiSsid;
  CAMERA_CONFIG.wifi_pass = wifiPass;
  CAMERA_CONFIG.cf_worker_url = cfWorkerUrl;
  CAMERA_CONFIG.gas_url = gasUrl;
  if (newPassword) {
    CAMERA_CONFIG.admin_password = newPassword;
  }

  saveCameraConfigToStorage();
  updateUIFromConfig();
  updateStreamModeBadge();

  // ปรับตำแหน่งหมุดและเคลื่อนแผนที่
  if (cameraMarker) {
    cameraMarker.setLatLng([lat, lng]);
    bindCameraPopup();
  }
  if (map) {
    map.panTo([lat, lng]);
  }

  closeAdminModal();
  alert("✅ บันทึกการตั้งค่ากล้องเรียบร้อยแล้ว ข้อมูลจะถูกจดจำไว้ตลอดการใช้งาน");
}

// เลือกโปรไฟล์ Wi-Fi ด่วนในหน้าแอดมิน
function applyWifiPreset(preset) {
  const ssidInp = document.getElementById('cfgWifiSsid');
  const passInp = document.getElementById('cfgWifiPass');
  const modeInp = document.getElementById('cfgNetworkMode');

  if (preset === 'local') {
    if (ssidInp) ssidInp.value = 'TMSTUDIO';
    if (passInp) passInp.value = '026830TM';
    if (modeInp) modeInp.value = 'local';
    CAMERA_CONFIG.network_mode = 'local';
    CAMERA_CONFIG.wifi_ssid = 'TMSTUDIO';
    CAMERA_CONFIG.wifi_pass = '026830TM';
  } else if (preset === '4g') {
    if (ssidInp) ssidInp.value = '199X';
    if (passInp) passInp.value = '5910110106';
    if (modeInp) modeInp.value = 'cloud';
    CAMERA_CONFIG.network_mode = 'cloud';
    CAMERA_CONFIG.wifi_ssid = '199X';
    CAMERA_CONFIG.wifi_pass = '5910110106';
  }
  updateStreamModeBadge();
}

// ส่งการตั้งค่า Wi-Fi ตรงไปยัง ESP32-CAM (ผ่านทั้ง IP วงใน และ Google Apps Script Remote Queue)
async function sendWifiConfigToCamera() {
  const ssid = (document.getElementById('cfgWifiSsid').value || '').trim();
  const pass = (document.getElementById('cfgWifiPass').value || '').trim();
  const statusEl = document.getElementById('wifiSendStatus');

  if (!ssid) {
    alert("กรุณากรอกชื่อ Wi-Fi (SSID)");
    return;
  }

  if (statusEl) {
    statusEl.style.display = 'block';
    statusEl.style.background = '#eff6ff';
    statusEl.style.color = '#1d4ed8';
    statusEl.innerText = `⏳ กำลังส่งคำสั่งเปลี่ยน Wi-Fi ไปยังกล้อง (SSID: ${ssid})...`;
  }

  // 1. ส่งตรงผ่าน Local LAN IP (/setwifi)
  try {
    fetch(`${getControlBaseUrl()}/setwifi?ssid=${encodeURIComponent(ssid)}&pass=${encodeURIComponent(pass)}`, { mode: 'no-cors' }).catch(() => {});
  } catch(e) {}

  // 2. ส่งผ่าน Google Apps Script คลาวด์คิว
  if (CAMERA_CONFIG.gas_url) {
    try {
      await fetch(`${CAMERA_CONFIG.gas_url}?action=setCameraWifi&camId=${encodeURIComponent(CAMERA_CONFIG.id)}&ssid=${encodeURIComponent(ssid)}&pass=${encodeURIComponent(pass)}`);
    } catch(e) {}
  }

  CAMERA_CONFIG.wifi_ssid = ssid;
  CAMERA_CONFIG.wifi_pass = pass;
  saveCameraConfigToStorage();

  if (statusEl) {
    statusEl.style.background = '#f0fdf4';
    statusEl.style.color = '#15803d';
    statusEl.innerText = `✅ ส่งคำสั่งเปลี่ยน Wi-Fi เรียบร้อย! กล้องจะบันทึกและเชื่อมต่อ ${ssid} ภายใน 5 วินาที`;
  }
}

// จัดการเมื่อเปลี่ยนโหมดสตรีมในแอดมิน
function handleNetworkModeChange(mode) {
  CAMERA_CONFIG.network_mode = mode;
  saveCameraConfigToStorage();
  updateStreamModeBadge();
}

function saveCameraConfigToStorage() {
  try {
    localStorage.setItem('ESP32CAM_CONFIG', JSON.stringify(CAMERA_CONFIG));
  } catch (e) {
    console.error("Failed to save to localStorage", e);
  }
}

function resetAdminSettingsToDefault() {
  if (confirm("ต้องการคืนค่าเริ่มต้นจากโรงงานทั้งหมดใช่หรือไม่?")) {
    CAMERA_CONFIG = Object.assign({}, DEFAULT_CAMERA_CONFIG);
    saveCameraConfigToStorage();
    openAdminModal();
    updateUIFromConfig();
    if (cameraMarker) {
      cameraMarker.setLatLng([CAMERA_CONFIG.lat, CAMERA_CONFIG.lng]);
      bindCameraPopup();
    }
    if (map) {
      map.panTo([CAMERA_CONFIG.lat, CAMERA_CONFIG.lng]);
    }
  }
}

function toggleDraggableMarker(checked) {
  isMarkerDraggable = checked;
  if (cameraMarker && cameraMarker.dragging) {
    if (isMarkerDraggable) {
      cameraMarker.dragging.enable();
    } else {
      cameraMarker.dragging.disable();
    }
  }
}

function startPickLocationOnMap() {
  isPickingOnMap = true;
  closeAdminModal();
  const banner = document.getElementById('mapPickerBanner');
  if (banner) banner.style.display = 'flex';

  map.once('click', function (e) {
    if (!isPickingOnMap) return;
    const clickedLat = parseFloat(e.latlng.lat.toFixed(6));
    const clickedLng = parseFloat(e.latlng.lng.toFixed(6));

    CAMERA_CONFIG.lat = clickedLat;
    CAMERA_CONFIG.lng = clickedLng;

    const latInp = document.getElementById('cfgLat');
    const lngInp = document.getElementById('cfgLng');
    if (latInp) latInp.value = clickedLat;
    if (lngInp) lngInp.value = clickedLng;

    if (cameraMarker) {
      cameraMarker.setLatLng([clickedLat, clickedLng]);
      bindCameraPopup();
    }

    cancelMapPicker();
    openAdminModal();
  });
}

function cancelMapPicker() {
  isPickingOnMap = false;
  const banner = document.getElementById('mapPickerBanner');
  if (banner) banner.style.display = 'none';
}

async function testCameraPing() {
  const ip = document.getElementById('cfgCamIp').value.trim();
  if (!ip) {
    alert("กรุณาระบุ IP Address ของกล้องก่อนทดสอบ");
    return;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(`http://${ip}/status`, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (res.ok) {
      const data = await res.json();
      alert(`✅ ติดต่อกล้องสำเร็จ!\n\nIP: ${ip}\nระดับน้ำ: ${data.water_level || '--'} ซม.\nแบตเตอรี่: ${data.battery || '--'} V\nสัญญาณ RSSI: ${data.rssi || '--'} dBm`);
    } else {
      alert(`⚠️ กล้องตอบสนองแต่มีสถานะ HTTP ${res.status}`);
    }
  } catch (err) {
    alert(`❌ ไม่สามารถเชื่อมต่อกับกล้องที่ IP: ${ip}\n\nคำแนะนำ:\n1. ตรวจสอบว่าอุปกรณ์เชื่อมต่อ Wi-Fi เดียวกันกับกล้องหรือไม่\n2. ตรวจสอบว่ากล้องเปิดเครื่องปกติ\n3. เช็คหมายเลข IP ใน Serial Monitor`);
  }
}
