// =====================================================================
// ZALO QR LOGIN - SỬA LỖI "MÃ QR ĐĂNG NHẬP KHÔNG HỢP LỆ"
// Nguyên nhân: Zalo yêu cầu tham số imei trong các request tạo mã QR.
// Nếu thiếu imei, mã QR sinh ra sẽ không hợp lệ khi quét.
// Giải pháp: Thêm imei vào body của cả 2 request: generate và waiting-scan.
// Đồng thời ưu tiên sử dụng trường "code" từ API thay vì "image" hoặc "url".
// =====================================================================

const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;

// Thời gian chờ quét tối đa (5 phút)
const QR_TIMEOUT_MS = 5 * 60 * 1000;
// Timeout cho mỗi request fetch (30 giây)
const FETCH_TIMEOUT_MS = 30000;

const APPLE_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

let currentSession = {
    id: null,
    status: 'INITIALIZING',
    qrData: null,
    imei: null,
    cookies: null,
    error: null
};

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

function stringifyJar(jar) {
    return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

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

async function generateQRWithRetry(cookieJar, imei, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // BẮT BUỘC: gửi kèm imei trong body
            const qrRes = await safeFetchWithCookies("https://id.zalo.me/account/authen/qr/generate", {
                method: "POST",
                headers: {
                    "Accept": "application/json, text/javascript, */*; q=0.01",
                    "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8",
                    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                    "Origin": "https://id.zalo.me",
                    "Referer": "https://id.zalo.me/account?continue=https%3A%2F%2Fchat.zalo.me%2F",
                    "X-Requested-With": "XMLHttpRequest"
                },
                body: new URLSearchParams({
                    continue: "https://chat.zalo.me/",
                    imei: imei // Tham số quan trọng
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
    currentSession.imei = crypto.randomUUID(); // Tạo imei duy nhất cho phiên
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

        // 1. Khởi tạo phiên Zalo (có thể bỏ qua nếu lỗi)
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

        // 2. Tạo mã QR với retry (truyền imei vào)
        const qrData = await generateQRWithRetry(cookieJar, currentSession.imei);

        // ƯU TIÊN trường code (chuỗi thực sự dùng để tạo QR), sau đó mới đến image/url
        const qrContent = qrData.code || qrData.qr_code || qrData.url || qrData.image;
        currentSession.qrData = qrContent;
        currentSession.status = 'WAITING';
        console.log(`[Phiên: ${currentSession.id}] ✅ Đã tạo mã QR thành công! Chờ quét...`);
        console.log(`[Phiên: ${currentSession.id}] Nội dung QR: ${qrContent}`);

        // 3. Vòng lặp chờ quét, bỏ qua mọi lỗi timeout
        const startTime = Date.now();
        let isDone = false;

        while (Date.now() - startTime < QR_TIMEOUT_MS) {
            await new Promise(r => setTimeout(r, 2000));

            try {
                // BẮT BUỘC: gửi kèm imei trong body
                const checkRes = await safeFetchWithCookies("https://id.zalo.me/account/authen/qr/waiting-scan", {
                    method: "POST",
                    headers: {
                        "Accept": "application/json, text/javascript, */*; q=0.01",
                        "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8",
                        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                        "Origin": "https://id.zalo.me",
                        "Referer": "https://id.zalo.me/account?continue=https%3A%2F%2Fchat.zalo.me%2F",
                        "X-Requested-With": "XMLHttpRequest"
                    },
                    body: new URLSearchParams({
                        code: qrData.code, // Dùng code từ bước generate
                        continue: "https://chat.zalo.me/",
                        imei: currentSession.imei // Tham số quan trọng
                    }).toString()
                }, cookieJar, 10000);

                const checkJson = await checkRes.json();
                console.log(`[Waiting Scan]`, JSON.stringify(checkJson, null, 2));

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
        <title>Zalo QR Login (Apple)</title>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
        <style>
            * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
            body {
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                background-color: #f0f2f5; display: flex; justify-content: center; align-items: center;
                min-height: 100vh; padding: 16px;
            }
            .card {
                background: #fff; width: 100%; max-width: 360px;
                padding: 30px 20px; border-radius: 16px;
                box-shadow: 0 4px 20px rgba(0,0,0,0.06); text-align: center;
            }
            h2 { color: #0068ff; margin-bottom: 6px; font-size: 20px; }
            .badge {
                display: inline-block; font-size: 11px; background: #eef5ff;
                color: #0068ff; padding: 4px 10px; border-radius: 20px;
                margin-bottom: 15px; font-weight: 600;
            }
            p.desc { font-size: 13px; color: #666; margin-bottom: 16px; }
            .qr-wrapper {
                width: 250px; height: 250px; margin: 0 auto 16px;
                border: 1px solid #e1e4ea; border-radius: 12px;
                display: flex; align-items: center; justify-content: center;
                background: #fafafa; position: relative; overflow: hidden;
            }
            .qr-wrapper img { max-width: 100%; max-height: 100%; }
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
                width: 100%; height: 80px; margin-top: 6px; font-family: monospace;
                font-size: 11px; padding: 6px; border: 1px solid #ccc; border-radius: 4px; resize: none;
            }
        </style>
    </head>
    <body>
        <div class="card">
            <h2>Zalo QR Login</h2>
            <div class="badge">🍎 Thiết bị: Apple macOS (Safari)</div>
            <p class="desc">Mở Zalo trên điện thoại để quét mã</p>

            <div class="qr-wrapper" id="qrContainer">
                <div class="spinner" id="spinner"></div>
                <div id="qrcode"></div>
            </div>

            <div class="status-text" id="statusText">Đang tạo mã QR...</div>

            <div class="result-box" id="resultBox">
                <b>Trạng thái:</b> Đã xác nhận đăng nhập thành công!<br>
                <textarea id="resCookies" readonly></textarea>
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

                            // Xử lý hiển thị QR: nếu là ảnh base64 thì hiển thị, ngược lại tạo QR từ chuỗi
                            if (data.qrData.startsWith('data:image')) {
                                qrContainer.innerHTML = '<img src="' + data.qrData + '" style="width:230px;height:230px;" />';
                            } else {
                                new QRCode(qrContainer, {
                                    text: data.qrData,
                                    width: 230,
                                    height: 230
                                });
                            }
                            document.getElementById('statusText').innerText = 'Quét mã và bấm Xác nhận trên điện thoại';
                            document.getElementById('statusText').style.color = '#0068ff';
                        }
                    } 
                    else if (data.status === 'SUCCESS') {
                        stopped = true;
                        document.getElementById('spinner').style.display = 'none';
                        document.getElementById('qrcode').innerHTML = '<p style="color:#28a745;font-weight:bold;">✔ Đã nhận diện!<br>Mã này đã bị hủy.</p>';
                        document.getElementById('statusText').innerText = '🎉 Đăng nhập thành công!';
                        document.getElementById('statusText').style.color = '#28a745';
                        document.getElementById('resultBox').style.display = 'block';
                        document.getElementById('resCookies').value = JSON.stringify(data.cookies);
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

            pollStatus();
        </script>
    </body>
    </html>
    `);
});
