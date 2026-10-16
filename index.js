// =====================================================================
// ZALO QR LOGIN - MACBOOK REQUEST SIMULATION
// - Tạo IMEI 15 chữ số ngẫu nhiên (chuẩn Zalo Web).
// - Gửi kèm IMEI trong cả request generate và waiting-scan.
// - Thêm header X-Zalo-Web-Version để tương thích API.
// - Giao diện hiển thị yêu cầu đăng nhập từ MacBook Pro.
// - Sau khi xác nhận thành công, hiển thị Cookies (thu gọn) và IMEI.
// =====================================================================

const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;

// Thời gian chờ quét tối đa (5 phút)
const QR_TIMEOUT_MS = 5 * 60 * 1000;
// Timeout cho mỗi request fetch (30 giây)
const FETCH_TIMEOUT_MS = 30000;

// Giả lập User-Agent của MacBook Safari
const APPLE_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

let currentSession = {
    id: null,
    status: 'INITIALIZING', // INITIALIZING | WAITING | SUCCESS | ERROR
    qrData: null,
    imei: null,
    cookies: null,
    error: null
};

// Hàm trích xuất và lưu cookies từ response
function parseAndSaveCookies(res, jar) {
    let setCookies = [];
    if (typeof res.headers.getSetCookie === 'function') {
        setCookies = res.headers.getSetCookie();
    } else {
        const raw = res.headers.get('set-cookie');
        if (raw) setCookies = [raw];
    }

    for (const cookieStr of setCookies) {
        const part = cookieStr.split(';')[0];
        const eqIdx = part.indexOf('=');
        if (eqIdx !== -1) {
            const k = part.substring(0, eqIdx).trim();
            const v = part.substring(eqIdx + 1).trim();
            if (k) jar[k] = v;
        }
    }
}

// Chuyển cookie jar thành chuỗi header
function stringifyJar(jar) {
    return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

// Fetch có xử lý redirect thủ công để giữ cookie
async function safeFetchWithCookies(url, options = {}, jar = {}, timeoutMs = FETCH_TIMEOUT_MS) {
    let targetUrl = url;
    let redirectCount = 0;

    while (redirectCount < 5) {
        const headers = {
            ...(options.headers || {}),
            "User-Agent": APPLE_USER_AGENT,
            "Cookie": stringifyJar(jar)
        };

        const res = await fetch(targetUrl, {
            ...options,
            headers,
            redirect: 'manual',
            signal: AbortSignal.timeout(timeoutMs)
        });

        parseAndSaveCookies(res, jar);

        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
            let nextLoc = res.headers.get('location');
            if (nextLoc.startsWith('/')) {
                const u = new URL(targetUrl);
                nextLoc = `${u.origin}${nextLoc}`;
            }
            targetUrl = nextLoc;
            options.method = 'GET';
            delete options.body;
            redirectCount++;
            continue;
        }

        return res;
    }
    throw new Error("Quá nhiều lần chuyển hướng");
}

// Tạo mã QR với cơ chế retry
async function generateQRWithRetry(cookieJar, imei, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const qrRes = await safeFetchWithCookies("https://id.zalo.me/account/authen/qr/generate", {
                method: "POST",
                headers: {
                    "Accept": "application/json, text/javascript, */*; q=0.01",
                    "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8",
                    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                    "Origin": "https://id.zalo.me",
                    "Referer": "https://id.zalo.me/account?continue=https%3A%2F%2Fchat.zalo.me%2F",
                    "X-Requested-With": "XMLHttpRequest",
                    "X-Zalo-Web-Version": "2.0.0" // Header quan trọng để Zalo chấp nhận
                },
                body: new URLSearchParams({
                    continue: "https://chat.zalo.me/",
                    imei: imei
                }).toString()
            }, cookieJar, FETCH_TIMEOUT_MS);

            const qrJson = await qrRes.json();
            console.log(`[QR Generate] Lần ${attempt}:`, JSON.stringify(qrJson, null, 2));

            if (qrJson.error_code === 0 && qrJson.data) {
                return qrJson.data;
            } else {
                throw new Error(qrJson.error_message || "Zalo từ chối sinh mã QR");
            }
        } catch (err) {
            console.error(`[QR Generate] Lần ${attempt} thất bại:`, err.message);
            if (attempt === maxRetries) throw err;
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

async function runSingleSession() {
    currentSession.id = crypto.randomUUID().slice(0, 8);
    currentSession.status = 'INITIALIZING';
    currentSession.qrData = null;
    // Tạo IMEI 15 chữ số ngẫu nhiên (chuẩn Zalo Web)
    currentSession.imei = Math.floor(Math.random() * 9e14 + 1e14).toString();
    currentSession.cookies = null;
    currentSession.error = null;

    console.log(`\n========================================`);
    console.log(`[Phiên: ${currentSession.id}] Bắt đầu tạo mã QR...`);
    console.log(`[Phiên: ${currentSession.id}] IMEI: ${currentSession.imei}`);

    try {
        let cookieJar = {
            "_zlang": "vn",
            "has_actived": "1"
        };

        // 1. Khởi tạo phiên Zalo
        try {
            await safeFetchWithCookies("https://id.zalo.me/account?continue=https%3A%2F%2Fchat.zalo.me%2F", {
                method: "GET",
                headers: {
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8"
                }
            }, cookieJar, FETCH_TIMEOUT_MS);
        } catch (e) {
            console.warn(`[Phiên: ${currentSession.id}] Khởi tạo phiên thất bại (bỏ qua):`, e.message);
        }

        // 2. Tạo mã QR (truyền IMEI vào)
        const qrData = await generateQRWithRetry(cookieJar, currentSession.imei);

        // Lấy code từ response (code là chuỗi dùng để tạo QR)
        const qrCode = qrData.code || qrData.qr_code;
        if (!qrCode) {
            throw new Error("Không nhận được mã code từ Zalo");
        }
        
        currentSession.qrData = qrCode;
        currentSession.status = 'WAITING';
        console.log(`[Phiên: ${currentSession.id}] ✅ Đã tạo mã QR thành công! Chờ quét...`);

        // 3. Vòng lặp chờ quét
        const startTime = Date.now();
        let isDone = false;

        while (Date.now() - startTime < QR_TIMEOUT_MS) {
            await new Promise(r => setTimeout(r, 2000));

            try {
                const checkRes = await safeFetchWithCookies("https://id.zalo.me/account/authen/qr/waiting-scan", {
                    method: "POST",
                    headers: {
                        "Accept": "application/json, text/javascript, */*; q=0.01",
                        "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8",
                        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                        "Origin": "https://id.zalo.me",
                        "Referer": "https://id.zalo.me/account?continue=https%3A%2F%2Fchat.zalo.me%2F",
                        "X-Requested-With": "XMLHttpRequest",
                        "X-Zalo-Web-Version": "2.0.0"
                    },
                    body: new URLSearchParams({
                        code: qrCode,
                        continue: "https://chat.zalo.me/",
                        imei: currentSession.imei
                    }).toString()
                }, cookieJar, 10000);

                const checkJson = await checkRes.json();
                console.log(`[Waiting Scan]`, JSON.stringify(checkJson, null, 2));

                // status === 2 hoặc có url là đã xác nhận thành công
                if (checkJson.error_code === 0 && checkJson.data && (checkJson.data.status === 2 || checkJson.data.url)) {
                    console.log(`🎉 [Phiên: ${currentSession.id}] Đăng nhập thành công!`);

                    if (checkJson.data.url) {
                        await safeFetchWithCookies(checkJson.data.url, { method: "GET" }, cookieJar, FETCH_TIMEOUT_MS);
                    }

                    currentSession.status = 'SUCCESS';
                    currentSession.cookies = cookieJar;
                    currentSession.qrData = null;
                    isDone = true;
                    break;
                }
            } catch (err) {
                console.warn(`[Waiting Scan] Lỗi tạm thời (bỏ qua):`, err.message);
            }
        }

        if (!isDone) {
            console.log(`[Phiên: ${currentSession.id}] Hết hạn chờ quét.`);
            currentSession.status = 'ERROR';
            currentSession.error = 'Hết hạn chờ quét mã QR';
        }

    } catch (err) {
        console.error(`❌ [Phiên: ${currentSession.id}] Lỗi nghiêm trọng:`, err.message);
        currentSession.status = 'ERROR';
        currentSession.error = err.message;
    }
}

app.listen(PORT, async () => {
    console.log(`Server chạy tại cổng: ${PORT}`);
    await runSingleSession();
});

app.get('/api/status', (req, res) => {
    res.json(currentSession);
});

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="vi">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <title>MacBook Pro - Yêu cầu đăng nhập</title>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
        <style>
            * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
            body {
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                background-color: #f5f5f7; display: flex; justify-content: center; align-items: center;
                min-height: 100vh; padding: 16px;
            }
            .card {
                background: #fff; width: 100%; max-width: 380px;
                padding: 30px 20px; border-radius: 18px;
                box-shadow: 0 10px 30px rgba(0,0,0,0.08); text-align: center;
                border: 1px solid #e5e5e5;
            }
            .macbook-icon { font-size: 40px; margin-bottom: 10px; }
            h2 { color: #1d1d1f; margin-bottom: 6px; font-size: 20px; font-weight: 600; }
            .subtitle { font-size: 13px; color: #86868b; margin-bottom: 20px; }
            .badge {
                display: inline-block; font-size: 11px; background: #eef5ff;
                color: #0068ff; padding: 4px 10px; border-radius: 20px;
                margin-bottom: 15px; font-weight: 600;
            }
            .warning {
                background: #fff3cd; color: #856404; padding: 10px; border-radius: 8px;
                font-size: 12px; margin-bottom: 15px; text-align: left; border: 1px solid #ffeeba;
            }
            .qr-wrapper {
                width: 250px; height: 250px; margin: 0 auto 16px;
                border: 1px solid #e1e4ea; border-radius: 12px;
                display: flex; align-items: center; justify-content: center;
                background: #fafafa; position: relative; overflow: hidden;
            }
            .spinner {
                border: 3px solid #f3f3f3; border-top: 3px solid #0068ff;
                border-radius: 50%; width: 34px; height: 34px;
                animation: spin 0.8s linear infinite;
            }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            .status-text { font-size: 14px; font-weight: 500; color: #444; min-height: 24px; }
            .result-box {
                display: none; text-align: left; background: #f8f9fa;
                border: 1px solid #e9ecef; padding: 12px; border-radius: 8px;
                margin-top: 15px; font-size: 12px;
            }
            .result-box textarea {
                width: 100%; height: 70px; margin-top: 6px; font-family: monospace;
                font-size: 11px; padding: 6px; border: 1px solid #ccc; border-radius: 4px; resize: none;
            }
            .copy-btn {
                background: #0068ff; color: #fff; border: none; padding: 6px 12px;
                border-radius: 6px; font-size: 11px; cursor: pointer; margin-top: 4px;
            }
            .info-row { margin-bottom: 8px; }
            .info-label { font-weight: 600; color: #555; }
            details { margin-top: 8px; }
            summary { cursor: pointer; color: #0068ff; font-weight: 600; }
        </style>
    </head>
    <body>
        <div class="card">
            <div class="macbook-icon">💻</div>
            <h2>MacBook Pro</h2>
            <div class="subtitle">macOS 14.5 • Safari 17.5</div>
            <div class="badge">Yêu cầu đăng nhập Zalo</div>
            
            <div class="warning">
                ⚠️ <b>LƯU Ý QUAN TRỌNG:</b><br>
                KHÔNG sử dụng chức năng <b>"Mã QR của tôi"</b> để quét.<br>
                Hãy mở Zalo → chọn <b>"Đăng nhập bằng mã QR"</b> (hoặc dùng camera hệ thống quét).
            </div>

            <div class="qr-wrapper" id="qrContainer">
                <div class="spinner" id="spinner"></div>
                <div id="qrcode"></div>
            </div>

            <div class="status-text" id="statusText">Đang tạo mã QR...</div>

            <div class="result-box" id="resultBox">
                <div class="info-row">
                    <span class="info-label">Trạng thái:</span> <span style="color:#28a745;font-weight:bold;">✅ Đăng nhập thành công!</span>
                </div>
                <div class="info-row">
                    <span class="info-label">IMEI:</span> <span id="imeiDisplay"></span>
                </div>
                
                <details>
                    <summary>🍪 Xem Cookies (đã thu gọn)</summary>
                    <textarea id="resCookies" readonly></textarea>
                    <button class="copy-btn" onclick="copyCookies()">Sao chép Cookies</button>
                </details>
            </div>
        </div>

        <script>
            let lastSid = null;
            let stopped = false;

            async function pollStatus() {
                if (stopped) return;
                try {
                    const res = await fetch('/api/status');
                    const data = await res.json();

                    if (data.status === 'INITIALIZING') {
                        document.getElementById('spinner').style.display = 'block';
                        document.getElementById('qrcode').innerHTML = '';
                        document.getElementById('statusText').innerText = 'Đang yêu cầu mã từ Zalo...';
                        document.getElementById('statusText').style.color = '#555';
                        document.getElementById('resultBox').style.display = 'none';
                    } 
                    else if (data.status === 'WAITING' && data.qrData) {
                        if (lastSid !== data.id) {
                            lastSid = data.id;
                            document.getElementById('spinner').style.display = 'none';
                            const qrContainer = document.getElementById('qrcode');
                            qrContainer.innerHTML = '';

                            new QRCode(qrContainer, {
                                text: data.qrData,
                                width: 230,
                                height: 230
                            });

                            document.getElementById('statusText').innerText = 'Quét mã và bấm Xác nhận trên điện thoại';
                            document.getElementById('statusText').style.color = '#0068ff';
                        }
                    } 
                    else if (data.status === 'SUCCESS') {
                        stopped = true;
                        document.getElementById('spinner').style.display = 'none';
                        document.getElementById('qrcode').innerHTML = '<p style="color:#28a745;font-weight:bold;font-size:16px;">✔ Đã xác nhận!<br>Mã QR đã bị hủy.</p>';
                        document.getElementById('statusText').innerText = '🎉 Đăng nhập thành công!';
                        document.getElementById('statusText').style.color = '#28a745';
                        document.getElementById('resultBox').style.display = 'block';
                        
                        // Hiển thị IMEI
                        document.getElementById('imeiDisplay').innerText = data.imei;
                        
                        // Hiển thị Cookies dạng chuỗi key=value
                        const cookieStr = Object.entries(data.cookies).map(([k, v]) => k + '=' + v).join('; ');
                        document.getElementById('resCookies').value = cookieStr;
                    }
                    else if (data.status === 'ERROR') {
                        document.getElementById('spinner').style.display = 'none';
                        document.getElementById('statusText').innerText = data.error || 'Lỗi kết nối, đang thử lại...';
                        document.getElementById('statusText').style.color = '#dc3545';
                        if (data.error && data.error.includes('Hết hạn')) {
                            stopped = true;
                        }
                    }
                } catch (e) {}
                if (!stopped) setTimeout(pollStatus, 1200);
            }

            function copyCookies() {
                const textarea = document.getElementById('resCookies');
                textarea.select();
                document.execCommand('copy');
                alert('Đã sao chép Cookies!');
            }

            pollStatus();
        </script>
    </body>
    </html>
    `);
});
