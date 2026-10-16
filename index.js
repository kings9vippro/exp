/**
 * Zalo QR Login - Bản vá lỗi fetch failed + POST đúng chuẩn Zalo ID
 * Tác giả: palofsc
 * Yêu cầu: Node.js >= 18, express
 * Cài đặt: npm install express
 * Chạy: node index.js
 */

const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;

// ==================== CẤU HÌNH THIẾT BỊ APPLE ====================
const APPLE_DEVICES = {
    'iphone18promax': {
        name: 'iPhone 18 Pro Max',
        ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
    },
    'iphone15pro': {
        name: 'iPhone 15 Pro',
        ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
    },
    'ipadpro': {
        name: 'iPad Pro (M4)',
        ua: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
    },
    'macbook': {
        name: 'MacBook Pro (macOS Sonoma)',
        ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    }
};

let currentDevice = 'iphone18promax';

// ==================== QUẢN LÝ PHIÊN ====================
let currentSession = {
    id: null,
    status: 'INITIALIZING',
    qrData: null,
    imei: null,
    cookies: null,
    error: null,
    device: currentDevice
};

// ==================== TIỆN ÍCH ====================
function parseCookies(responseHeaders) {
    const raw = responseHeaders.getSetCookie ? responseHeaders.getSetCookie() : [];
    let jar = {};
    raw.forEach(header => {
        const parts = header.split(';')[0].split('=');
        if (parts.length >= 2) {
            jar[parts[0].trim()] = parts.slice(1).join('=').trim();
        }
    });
    return jar;
}

function stringifyCookies(cookieJar) {
    return Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');
}

// Fetch có timeout (tránh treo vô hạn gây "fetch failed")
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        return res;
    } finally {
        clearTimeout(timer);
    }
}

// Header giả lập Safari Apple đầy đủ (bắt buộc để Zalo không chặn)
function buildHeaders(ua, cookieJar, extra = {}) {
    return {
        "User-Agent": ua,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept-Encoding": "gzip, deflate, br",
        "Origin": "https://id.zalo.me",
        "Referer": "https://id.zalo.me/account?continue=https%3A%2F%2Fchat.zalo.me%2F",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "Cookie": stringifyCookies(cookieJar),
        ...extra
    };
}

// ==================== VÒNG LẶP XỬ LÝ QR ====================
async function startSessionLoop() {
    while (true) {
        currentSession.device = currentDevice;
        const deviceUA = APPLE_DEVICES[currentDevice].ua;

        currentSession.id = crypto.randomUUID().slice(0, 8);
        currentSession.status = 'INITIALIZING';
        currentSession.qrData = null;
        currentSession.imei = crypto.randomUUID();
        currentSession.cookies = null;
        currentSession.error = null;

        console.log(`\n========================================`);
        console.log(`[Phiên: ${currentSession.id}] Thiết bị: ${APPLE_DEVICES[currentDevice].name}`);

        try {
            let cookieJar = {};

            // 1. Lấy cookie phiên từ Zalo ID
            const initRes = await fetchWithTimeout(
                "https://id.zalo.me/account?continue=https%3A%2F%2Fchat.zalo.me%2F",
                { headers: { "User-Agent": deviceUA, "Accept-Language": "vi-VN,vi;q=0.9" } },
                15000
            );
            Object.assign(cookieJar, parseCookies(initRes.headers));

            // 2. POST tạo QR (đúng method của Zalo ID)
            const qrRes = await fetchWithTimeout(
                "https://id.zalo.me/account/authen/qr/generate",
                {
                    method: "POST",
                    headers: buildHeaders(deviceUA, cookieJar, {
                        "Content-Type": "application/json"
                    }),
                    body: JSON.stringify({})
                },
                15000
            );
            Object.assign(cookieJar, parseCookies(qrRes.headers));

            const rawText = await qrRes.text();
            let qrJson;
            try {
                qrJson = JSON.parse(rawText);
            } catch (e) {
                throw new Error(`Zalo trả về không phải JSON: ${rawText.slice(0, 200)}`);
            }

            if (qrJson.error_code !== 0 || !qrJson.data) {
                throw new Error(qrJson.error_message || `Zalo từ chối (code ${qrJson.error_code})`);
            }

            const code = qrJson.data.code;
            currentSession.qrData = qrJson.data.image || qrJson.data.url || code;
            currentSession.status = 'WAITING';
            console.log(`[Phiên: ${currentSession.id}] QR sẵn sàng, đợi quét...`);

            // 3. Poll trạng thái xác nhận
            const startTime = Date.now();
            let isDone = false;

            while (Date.now() - startTime < 120000) {
                await new Promise(r => setTimeout(r, 2000));

                let checkRes;
                try {
                    checkRes = await fetchWithTimeout(
                        `https://id.zalo.me/account/authen/qr/waiting-scan?code=${encodeURIComponent(code)}`,
                        { headers: buildHeaders(deviceUA, cookieJar) },
                        10000
                    );
                } catch (pollErr) {
                    console.log(`[Phiên: ${currentSession.id}] Poll lỗi tạm thời, thử lại...`);
                    continue;
                }

                Object.assign(cookieJar, parseCookies(checkRes.headers));

                let checkJson;
                try {
                    checkJson = await checkRes.json();
                } catch { continue; }

                if (checkJson.error_code === 0 && checkJson.data &&
                    (checkJson.data.status === 2 || checkJson.data.url)) {

                    console.log(`🎉 [Phiên: ${currentSession.id}] Đăng nhập thành công!`);

                    if (checkJson.data.url) {
                        const finalRes = await fetchWithTimeout(
                            checkJson.data.url,
                            { headers: buildHeaders(deviceUA, cookieJar), redirect: 'manual' },
                            10000
                        ).catch(() => null);
                        if (finalRes) Object.assign(cookieJar, parseCookies(finalRes.headers));
                    }

                    currentSession.status = 'SUCCESS';
                    currentSession.cookies = cookieJar;
                    currentSession.qrData = null;
                    isDone = true;
                    await new Promise(r => setTimeout(r, 3500));
                    break;
                }
            }

            if (!isDone) {
                console.log(`[Phiên: ${currentSession.id}] Hết hạn, sinh mã mới.`);
            }

        } catch (err) {
            console.error(`❌ [Phiên: ${currentSession.id}] Lỗi:`, err.message);
            currentSession.status = 'ERROR';
            currentSession.error = err.message;
            await new Promise(r => setTimeout(r, 3000));
        }
    }
}

startSessionLoop();

// ==================== API ====================
app.get('/api/status', (req, res) => res.json(currentSession));

app.get('/api/set-device', (req, res) => {
    const device = req.query.device;
    if (device && APPLE_DEVICES[device]) {
        currentDevice = device;
        console.log(`[Hệ thống] Chuyển thiết bị: ${APPLE_DEVICES[device].name}`);
        res.json({ success: true, device: currentDevice });
    } else {
        res.status(400).json({ success: false, error: 'Thiết bị không hợp lệ' });
    }
});

app.get('/api/devices', (req, res) => {
    const list = Object.entries(APPLE_DEVICES).map(([key, val]) => ({ key, name: val.name }));
    res.json(list);
});

// ==================== GIAO DIỆN ====================
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Zalo QR Login</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
       background: #f0f2f5; display: flex; justify-content: center; align-items: center;
       min-height: 100vh; padding: 16px; }
.card { background: #fff; width: 100%; max-width: 380px; padding: 30px 20px;
        border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.06); text-align: center; }
h2 { color: #0068ff; margin-bottom: 6px; font-size: 20px; }
.badge { display: inline-block; font-size: 11px; background: #eef5ff; color: #0068ff;
         padding: 4px 10px; border-radius: 20px; margin-bottom: 15px; font-weight: 600; }
p.desc { font-size: 13px; color: #666; margin-bottom: 16px; }
.qr-wrapper { width: 250px; height: 250px; margin: 0 auto 16px;
              border: 1px solid #e1e4ea; border-radius: 12px;
              display: flex; align-items: center; justify-content: center;
              background: #fafafa; position: relative; overflow: hidden; }
.qr-wrapper img { max-width: 100%; max-height: 100%; }
.spinner { border: 3px solid #f3f3f3; border-top: 3px solid #0068ff;
           border-radius: 50%; width: 34px; height: 34px;
           animation: spin 0.8s linear infinite; }
@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
.status-text { font-size: 14px; font-weight: 500; color: #444; min-height: 24px; }
.result-box { display: none; text-align: left; background: #f8f9fa;
              border: 1px solid #e9ecef; padding: 12px; border-radius: 8px;
              margin-top: 15px; font-size: 12px; }
.result-box textarea { width: 100%; height: 80px; margin-top: 6px; font-family: monospace;
                       font-size: 11px; padding: 6px; border: 1px solid #ccc; border-radius: 4px; }
.device-selector { margin-bottom: 15px; }
.device-selector select { width: 100%; padding: 10px; border-radius: 8px;
                          border: 1px solid #ccc; font-size: 14px; background: #fff; color: #333; }
.device-selector label { display: block; text-align: left; font-size: 12px;
                         color: #666; margin-bottom: 4px; font-weight: 500; }
</style>
</head>
<body>
<div class="card">
    <h2>Zalo QR Login</h2>
    <div class="badge" id="deviceBadge">Thiết bị: iPhone 18 Pro Max</div>
    <p class="desc">Mở Zalo trên điện thoại để quét mã</p>
    <div class="device-selector">
        <label for="deviceSelect">Chọn thiết bị giả lập:</label>
        <select id="deviceSelect"></select>
    </div>
    <div class="qr-wrapper" id="qrContainer">
        <div class="spinner" id="spinner"></div>
        <div id="qrcode"></div>
    </div>
    <div class="status-text" id="statusText">Đang khởi tạo mã...</div>
    <div class="result-box" id="resultBox">
        <b>Trạng thái:</b> Đã bắt phiên đăng nhập!<br>
        <textarea id="resCookies" readonly></textarea>
    </div>
</div>
<script>
let lastSid = null;
let devicesLoaded = false;

async function loadDevices() {
    try {
        const res = await fetch('/api/devices');
        const devices = await res.json();
        const select = document.getElementById('deviceSelect');
        select.innerHTML = '';
        devices.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.key;
            opt.textContent = d.name;
            select.appendChild(opt);
        });
        select.value = 'iphone18promax';
        devicesLoaded = true;
    } catch (e) { console.error('Load devices failed', e); }
}

document.getElementById('deviceSelect').addEventListener('change', async (e) => {
    const device = e.target.value;
    await fetch('/api/set-device?device=' + device);
    document.getElementById('deviceBadge').innerText =
        'Thiết bị: ' + e.target.options[e.target.selectedIndex].text;
    lastSid = null;
});

loadDevices();

setInterval(async () => {
    if (!devicesLoaded) return;
    try {
        const res = await fetch('/api/status');
        const data = await res.json();

        if (data.status === 'INITIALIZING') {
            document.getElementById('spinner').style.display = 'block';
            document.getElementById('qrcode').innerHTML = '';
            document.getElementById('statusText').innerText = 'Đang tạo mã QR mới...';
            document.getElementById('statusText').style.color = '#555';
            document.getElementById('resultBox').style.display = 'none';
        }
        else if (data.status === 'WAITING' && data.qrData) {
            if (lastSid !== data.id) {
                lastSid = data.id;
                document.getElementById('spinner').style.display = 'none';
                const qrContainer = document.getElementById('qrcode');
                qrContainer.innerHTML = '';
                if (typeof data.qrData === 'string' && data.qrData.startsWith('data:image')) {
                    qrContainer.innerHTML = '<img src="' + data.qrData + '" style="width:230px;height:230px;" />';
                } else {
                    new QRCode(qrContainer, { text: data.qrData, width: 230, height: 230 });
                }
                document.getElementById('statusText').innerText = 'Quét mã và bấm Xác nhận trên điện thoại';
                document.getElementById('statusText').style.color = '#0068ff';
            }
        }
        else if (data.status === 'SUCCESS') {
            document.getElementById('spinner').style.display = 'none';
            document.getElementById('qrcode').innerHTML =
                '<p style="color:#28a745;font-weight:bold;">✔ Đã nhận diện!<br>Mã cũ đã bị hủy.</p>';
            document.getElementById('statusText').innerText = '🎉 Thành công! Đang chuyển tiếp mã mới...';
            document.getElementById('statusText').style.color = '#28a745';
            document.getElementById('resultBox').style.display = 'block';
            document.getElementById('resCookies').value = JSON.stringify(data.cookies);
        }
        else if (data.status === 'ERROR') {
            document.getElementById('statusText').innerText =
                'Lỗi: ' + (data.error || 'không xác định') + ' — đang thử lại...';
            document.getElementById('statusText').style.color = '#dc3545';
        }
    } catch (e) {}
}, 1200);
</script>
</body>
</html>`);
});

app.listen(PORT, () => {
    console.log(`Server chạy cổng: ${PORT}`);
});
