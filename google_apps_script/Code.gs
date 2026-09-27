/**
 * =========================================================================================
 * GOOGLE APPS SCRIPT (GAS) - ระบบจัดการกล้องตรวจวัดอุทกภัยและสั่งปลุกสตรีมสด
 * เทศบาลตำบลตันหยงมัส อ.ระแงะ จ.นราธิวาส
 * =========================================================================================
 * รองรับ:
 * 1. รับรายงานระดับน้ำและสถานะกล้องจาก ESP32-CAM (รองรับทั้ง GET และ POST)
 * 2. รับคำสั่ง Remote Wake-up จาก Web Dashboard และจัดคิวคำสั่งให้ ESP32-CAM
 * 3. ส่งข้อมูลสถานะกล้องจริงทั้งหมดให้ Dashboard แสดงผล (getCamerasStatus)
 * 4. บันทึกข้อมูลลง PropertiesService และ Google Sheets
 * 5. แจ้งเตือนผ่าน LINE Notify เมื่อระดับน้ำเกินเกณฑ์วิกฤต
 */

// โทเคน LINE Notify (หากต้องการใช้งาน ให้ใส่ Line Notify Token ที่นี่)
const LINE_NOTIFY_TOKEN = ""; 

// เกณฑ์ระดับน้ำเตือนภัย (ซม.) สำหรับพื้นที่เสี่ยงเทศบาลตำบลตันหยงมัส
const WATER_WARNING_LEVEL = 180.0;  // เฝ้าระวัง (สีเหลือง)
const WATER_CRITICAL_LEVEL = 230.0; // วิกฤตน้ำล้นตลิ่ง (สีแดง)

/**
 * จัดการคำขอ HTTP GET (เสถียรที่สุดสำหรับ ESP32 และ Web App)
 */
function doGet(e) {
  try {
    const params = (e && e.parameter) ? e.parameter : {};
    const action = params.action;
    const scriptProperties = PropertiesService.getScriptProperties();

    // 1. ESP32-CAM รายงานสถานะโทรมาตร (GET method ป้องกัน 302 redirect error)
    if (action === "reportStatus") {
      return handleReportStatus(params);
    }

    // 2. ESP32-CAM สอบถามว่ามีคำสั่งปลุกหรือไม่
    if (action === "checkCommand") {
      const camId = params.camId || "CAM-TYM-01";
      const lastCmd = scriptProperties.getProperty("CMD_" + camId);
      const cmdTime = scriptProperties.getProperty("TIME_" + camId);
      
      let activeCmd = "standby";
      if (lastCmd && cmdTime) {
        const elapsedSec = (new Date().getTime() - parseInt(cmdTime)) / 1000;
        if (elapsedSec <= 180) {
          activeCmd = lastCmd;
        } else {
          scriptProperties.deleteProperty("CMD_" + camId);
        }
      }
      
      return createJsonResponse({
        status: "ok",
        camId: camId,
        command: activeCmd,
        timestamp: new Date().toISOString()
      });
    }

    // 3. Web Dashboard สั่งปลุกสตรีมสด (Wake up camera stream)
    if (action === "wakeCamera") {
      const camId = params.camId || "CAM-TYM-01";
      const duration = params.duration || 180;
      
      scriptProperties.setProperty("CMD_" + camId, "wake_stream");
      scriptProperties.setProperty("TIME_" + camId, new Date().getTime().toString());
      
      return createJsonResponse({
        success: true,
        message: "สั่งปลุกกล้อง " + camId + " สำเร็จ พร้อมเริ่มสตรีม RTSP/MJPEG",
        camId: camId,
        expiresInSec: duration
      });
    }

    // 3.1 Web Dashboard สั่งเปลี่ยนการตั้งค่า Wi-Fi ของกล้องทางไกล (Remote Wi-Fi Config)
    if (action === "setCameraWifi") {
      const camId = params.camId || "CAM-TYM-01";
      const newSsid = params.ssid || "";
      const newPass = params.pass || "";
      if (newSsid) {
        scriptProperties.setProperty("CMD_" + camId, "setwifi:" + newSsid + ":" + newPass);
        scriptProperties.setProperty("TIME_" + camId, new Date().getTime().toString());
        return createJsonResponse({
          success: true,
          message: "บันทึกคำสั่งเปลี่ยน Wi-Fi ไปยังกล้อง " + camId + " เรียบร้อย (SSID: " + newSsid + ")",
          camId: camId,
          ssid: newSsid
        });
      } else {
        return createJsonResponse({ success: false, error: "Missing ssid" });
      }
    }

    // 4. ดึงรายการสถานะกล้องจริงทั้งหมดสำหรับ Dashboard
    if (action === "getCamerasStatus") {
      const allProps = scriptProperties.getProperties();
      const cameras = {};

      for (let key in allProps) {
        if (key.indexOf("STATUS_") === 0) {
          try {
            const camData = JSON.parse(allProps[key]);
            cameras[camData.camId] = camData;
          } catch(err) {}
        }
      }

      return createJsonResponse({
        success: true,
        cameras: cameras,
        serverTime: new Date().toISOString()
      });
    }

    // 5. บันทึกข้อมูลตำแหน่งกล้องใหม่จาก Dashboard
    if (action === "registerCamera") {
      const camId = params.camId;
      if (camId) {
        scriptProperties.setProperty("META_" + camId, JSON.stringify(params));
        return createJsonResponse({ success: true, registered: camId });
      }
    }

    // 6. ดึงภาพถ่ายล่าสุด (Cloud Snapshot Relay ข้ามเครือข่าย)
    if (action === "getLatestSnapshot") {
      const camId = params.camId || "CAM-TYM-01";
      const cache = CacheService.getScriptCache();
      let base64Img = cache.get("SNAP_" + camId);
      
      // กรณีแบ่ง chunk เมื่อรูปภาพมีขนาดใหญ่
      if (!base64Img) {
        const chunks = cache.get("SNAP_" + camId + "_chunks");
        if (chunks) {
          const numChunks = parseInt(chunks);
          let assembled = "";
          for (let i = 0; i < numChunks; i++) {
            const piece = cache.get("SNAP_" + camId + "_" + i);
            if (piece) assembled += piece;
          }
          if (assembled.length > 0) base64Img = assembled;
        }
      }

      const snapTime = scriptProperties.getProperty("SNAP_TIME_" + camId);

      if (base64Img) {
        return createJsonResponse({
          success: true,
          camId: camId,
          image: base64Img.indexOf("data:") === 0 ? base64Img : ("data:image/jpeg;base64," + base64Img),
          updatedAt: snapTime ? parseInt(snapTime) : new Date().getTime()
        });
      } else {
        return createJsonResponse({
          success: false,
          camId: camId,
          message: "No snapshot in cache or waiting for camera stream."
        });
      }
    }

    return createJsonResponse({
      name: "Tanyongmat Flood Watch ESP32-CAM API",
      status: "active",
      time: new Date().toISOString()
    });

  } catch (err) {
    return createJsonResponse({ error: err.toString() });
  }
}

/**
 * จัดการคำขอ HTTP POST
 */
function doPost(e) {
  try {
    let payload = {};
    if (e && e.postData && e.postData.contents) {
      try {
        payload = JSON.parse(e.postData.contents);
      } catch (err) {
        payload = e.parameter || {};
      }
    } else if (e && e.parameter) {
      payload = e.parameter;
    }

    const action = payload.action;

    if (action === "reportStatus") {
      return handleReportStatus(payload);
    }

    if (action === "wakeCamera") {
      const camId = payload.camId || "CAM-TYM-01";
      const scriptProperties = PropertiesService.getScriptProperties();
      scriptProperties.setProperty("CMD_" + camId, "wake_stream");
      scriptProperties.setProperty("TIME_" + camId, new Date().getTime().toString());

      return createJsonResponse({
        success: true,
        message: "สั่งปลุกกล้อง " + camId + " สำเร็จ"
      });
    }

    if (action === "setCameraWifi") {
      const camId = payload.camId || "CAM-TYM-01";
      const newSsid = payload.ssid || "";
      const newPass = payload.pass || "";
      if (newSsid) {
        const scriptProperties = PropertiesService.getScriptProperties();
        scriptProperties.setProperty("CMD_" + camId, "setwifi:" + newSsid + ":" + newPass);
        scriptProperties.setProperty("TIME_" + camId, new Date().getTime().toString());
        return createJsonResponse({
          success: true,
          message: "บันทึกคำสั่งเปลี่ยน Wi-Fi ไปยังกล้อง " + camId + " เรียบร้อย (SSID: " + newSsid + ")",
          camId: camId,
          ssid: newSsid
        });
      }
    }

    // รับภาพถ่าย Snapshot จาก ESP32-CAM และเก็บลง CacheService (Cloud Relay)
    if (action === "uploadSnapshot") {
      const camId = payload.camId || "CAM-TYM-01";
      const base64Img = payload.image;
      if (base64Img) {
        const cache = CacheService.getScriptCache();
        const chunkSize = 85000; // CacheService จำกัด ~100KB ต่อคีย์

        if (base64Img.length > chunkSize) {
          const numChunks = Math.ceil(base64Img.length / chunkSize);
          cache.put("SNAP_" + camId + "_chunks", numChunks.toString(), 21600);
          for (let i = 0; i < numChunks; i++) {
            const start = i * chunkSize;
            const piece = base64Img.substring(start, start + chunkSize);
            cache.put("SNAP_" + camId + "_" + i, piece, 21600);
          }
          cache.remove("SNAP_" + camId);
        } else {
          cache.put("SNAP_" + camId, base64Img, 21600);
          cache.remove("SNAP_" + camId + "_chunks");
        }

        PropertiesService.getScriptProperties().setProperty("SNAP_TIME_" + camId, new Date().getTime().toString());

        return createJsonResponse({
          success: true,
          status: "snapshot_saved",
          camId: camId,
          timestamp: new Date().toISOString()
        });
      }
    }

    return createJsonResponse({ status: "ignored" });

  } catch (err) {
    return createJsonResponse({ error: err.toString() });
  }
}

/**
 * ฟังก์ชันประมวลผลการรายงานสถานะ (รองรับทั้ง GET และ POST)
 */
function handleReportStatus(payload) {
  const scriptProperties = PropertiesService.getScriptProperties();
  const camId = payload.camId || "CAM-TYM-01";
  const waterLevel = parseFloat(payload.waterLevel || 0);
  const battery = parseFloat(payload.battery || 0);
  const ip = payload.ip || "";
  const rssi = parseInt(payload.rssi || 0);
  const now = new Date();
  
  const alertStatus = waterLevel >= WATER_CRITICAL_LEVEL ? "CRITICAL" : 
                     (waterLevel >= WATER_WARNING_LEVEL ? "WARNING" : "NORMAL");

  // บันทึกสถานะล่าสุดลง PropertiesService (รวดเร็วและไม่มีปัญหาเรื่อง permission)
  const statusObj = {
    camId: camId,
    waterLevel: waterLevel,
    battery: battery,
    ip: ip,
    rssi: rssi,
    alertStatus: alertStatus,
    updatedAt: now.toISOString(),
    updatedAtThai: Utilities.formatDate(now, "Asia/Bangkok", "dd/MM/yyyy HH:mm:ss")
  };
  scriptProperties.setProperty("STATUS_" + camId, JSON.stringify(statusObj));

  // พยายามบันทึกลง Google Sheets (ถ้ามี Sheet ผูกอยู่)
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (ss) {
      let sheet = ss.getSheetByName("FloodLogs");
      if (!sheet) {
        sheet = ss.insertSheet("FloodLogs");
        sheet.appendRow(["วันเวลา (Timestamp)", "รหัสกล้อง (Camera ID)", "ระดับน้ำ (ซม.)", "แรงดันแบตเตอรี่ (V)", "IP Address", "สัญญาณ RSSI", "สถานะเตือนภัย"]);
        sheet.setFrozenRows(1);
        sheet.getRange("A1:G1").setBackground("#1e293b").setFontColor("#ffffff").setFontWeight("bold");
      }
      sheet.appendRow([now, camId, waterLevel, battery, ip, rssi, alertStatus]);
    }
  } catch (sheetErr) {
    Logger.log("Sheet log notice: " + sheetErr.toString());
  }

  // แจ้งเตือนเมื่อระดับน้ำวิกฤต
  if (alertStatus === "CRITICAL" && LINE_NOTIFY_TOKEN) {
    sendLineNotification("🚨 [แจ้งเตือนอุทกภัย ทต.ตันหยงมัส]\n" +
      "จุดตรวจ: " + camId + "\n" +
      "ระดับน้ำ: " + waterLevel.toFixed(1) + " ซม. (ระดับวิกฤต)\n" +
      "แบตเตอรี่: " + battery.toFixed(2) + "V\n" +
      "เวลา: " + Utilities.formatDate(now, "Asia/Bangkok", "dd/MM/yyyy HH:mm:ss")
    );
  }

  // ตรวจสอบว่ามีคำสั่งปลุกค้างอยู่หรือไม่
  const lastCmd = scriptProperties.getProperty("CMD_" + camId);
  const cmdTime = scriptProperties.getProperty("TIME_" + camId);
  let activeCmd = "standby";
  if (lastCmd && cmdTime) {
    const elapsedSec = (now.getTime() - parseInt(cmdTime)) / 1000;
    if (elapsedSec <= 180) {
      activeCmd = lastCmd;
    } else {
      scriptProperties.deleteProperty("CMD_" + camId);
    }
  }

  return createJsonResponse({
    status: "saved",
    camId: camId,
    command: activeCmd,
    waterLevel: waterLevel,
    battery: battery,
    alertStatus: alertStatus
  });
}

/**
 * ส่ง Output แบบ JSON พร้อม Header
 */
function createJsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * ส่งข้อความผ่าน LINE Notify
 */
function sendLineNotification(message) {
  if (!LINE_NOTIFY_TOKEN) return;
  const options = {
    method: "post",
    headers: { "Authorization": "Bearer " + LINE_NOTIFY_TOKEN },
    payload: { "message": message },
    muteHttpExceptions: true
  };
  try {
    UrlFetchApp.fetch("https://notify-api.line.me/api/notify", options);
  } catch (e) {
    Logger.log("Line notify error: " + e.message);
  }
}
