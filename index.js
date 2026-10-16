// =====================================================================
// ZALO QR LOGIN - MACBOOK PRO / DESKTOP MODE
// =====================================================================

const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;

const QR_TIMEOUT_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30000;
// Sử dụng User-Agent chuẩn của Safari trên máy tính Mac để Zalo hiểu đây là máy tính yêu cầu đăng nhập
const DESKTOP_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

let currentSession = {
    id: null,
    status: 'INITIALIZING',
    qrData: null,      
    qrIsImage: false,  
    qrCode: null,      
    imei: null,
    cookies: null,
    error: null,
    scanned: false
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
            "User-Agent": DESKTOP_USER_AGENT,
            "Cookie": stringifyJar(jar)
        };
        const res = await fetch(targetUrl, {
            ...options, headers, redirect: 'manual',
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
            const qrRes = await safeFetchWithCookies("https://id.zalo.me/account/authen/qr/generate", {
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
                    continue: "https://chat.zalo.me/",
                    imei: imei
                }).toString()
            }, cookieJar, FETCH_TIMEOUT_MS);

            const qrJson = await qrRes.json();
            console.log(`[QR Generate] Lần ${attempt}:`, JSON.stringify(qrJson, null, 2));

            if (qrJson.error_code === 0 && qrJson.data && qrJson.data.code) {
                return qrJson.data;
            }
            throw new Error(qrJson.error_message || "Zalo từ chối sinh mã QR");
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
    currentSession.qrIsImage = false;
    currentSession.qrCode = null;
    currentSession.imei = Math.floor(Math.random() * 9e14 + 1e14).toString();
    currentSession.cookies = null;
    currentSession.error = null;
    currentSession.scanned = false;

    console.log(`\n========================================`);
    console.log(`[Phiên: ${currentSession.id}] Bắt đầu yêu cầu mã cho máy tính, IMEI: ${currentSession.imei}`);

    try {
        let cookieJar = { "_zlang": "vn", "has_actived": "1" };

        try {
            await safeFetchWithCookies(
                "https://id.zalo.me/account?continue=https%3A%2F%2Fchat.zalo.me%2F",
                { method: "GET", headers: {
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8"
                }},
                cookieJar, FETCH_TIMEOUT_MS
            );
        } catch (e) {
            console.warn(`[Khởi tạo] Bỏ qua lỗi:`, e.message);
        }

        const qrData = await generateQRWithRetry(cookieJar, currentSession.imei);
        const qrCode = qrData.code;

        if (qrData.image && typeof qrData.image === 'string' && qrData.image.startsWith('data:image')) {
            currentSession.qrData = qrData.image;
            currentSession.qrIsImage = true;
            console.log(`[Phiên ${currentSession.id}] Dùng ảnh base64 từ Zalo thành công.`);
        } else {
            currentSession.qrData = qrCode;
            currentSession.qrIsImage = false;
            console.log(`[Phiên ${currentSession.id}] Fallback: encode code thô.`);
        }
        currentSession.qrCode = qrCode;
        currentSession.status = 'WAITING';

        const startTime = Date.now();
        let isDone = false;

        while (Date.now() - startTime < QR_TIMEOUT_MS) {
            await new Promise(r => setTimeout(r, 2000));
            try {
                const checkRes = await safeFetchWithCookies(
                    "https://id.zalo.me/account/authen/qr/waiting-scan",
                    {
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
                    },
                    cookieJar, 10000
                );

                const checkJson = await checkRes.json();
                console.log(`[Waiting Scan]`, JSON.stringify(checkJson, null, 2));

                if (checkJson.error_code === 0 && checkJson.data) {
                    const st = checkJson.data.status;
                    if (st === 1) currentSession.scanned = true;

                    if (st === 2 || checkJson.data.url) {
                        console.log(`🎉 [Phiên: ${currentSession.id}] Đã xác nhận đăng nhập máy tính!`);
                        if (checkJson.data.url) {
                            await safeFetchWithCookies(checkJson.data.url, { method: "GET" }, cookieJar, FETCH_TIMEOUT_MS);
                        }
                        currentSession.status = 'SUCCESS';
                        currentSession.cookies = { ...cookieJar };
                        currentSession.qrData = null;
                        currentSession.qrCode = null;
                        isDone = true;
                        break;
                    }
                }
            } catch (err) {
                console.warn(`[Waiting Scan] Lỗi tạm:`, err.message);
            }
        }

        if (!isDone) {
            currentSession.status = 'ERROR';
            currentSession.error = 'Hết hạn chờ quét mã QR';
        }
    } catch (err) {
        console.error(`❌ Lỗi:`, err.message);
        currentSession.status = 'ERROR';
        currentSession.error = err.message;
    }
}

app.listen(PORT, async () => {
    console.log(`Server chạy tại cổng: ${PORT}`);
    await runSingleSession();
});

app.get('/api/status', (req, res) => res.json(currentSession));

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="vi">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Đăng nhập Zalo - Máy tính</title>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
        <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
                background: #f5f5f7; display: flex; justify-content: center;
                align-items: center; min-height: 100vh; padding: 16px; }
            .card { background: #fff; width: 100%; max-width: 420px; padding: 26px 20px;
                border-radius: 18px; box-shadow: 0 10px 30px rgba(0,0,0,0.08);
                text-align: center; border: 1px solid #e5e5e5; }
            .mac { font-size: 38px; }
            h2 { color: #1d1d1f; margin: 8px 0 4px; font-size: 20px; }
            .sub { font-size: 12px; color: #86868b; margin-bottom: 12px; }
            .warn { text-align: left; background: #fff3cd; border: 1px solid #ffeeba;
                border-radius: 10px; padding: 12px; margin-bottom: 14px;
                font-size: 12px; color: #856404; line-height: 1.7; }
            .warn b { color: #d63384; }
            .ok { text-align: left; background: #d1e7dd; border: 1px solid #a3cfbb;
                border-radius: 10px; padding: 12px; margin-bottom: 14px;
                font-size: 12px; color: #0f5132; line-height: 1.7; }
            .qr-wrapper { width: 250px; height: 250px; margin: 0 auto 14px;
                border: 1px solid #e1e4ea; border-radius: 12px; display: flex;
                align-items: center; justify-content: center; background: #fafafa; }
            .qr-wrapper img { width: 230px; height: 230px; }
            .spinner { border: 3px solid #f3f3f3; border-top: 3px solid #0068ff;
                border-radius: 50%; width: 34px; height: 34px;
                animation: spin .8s linear infinite; }
            @keyframes spin { to { transform: rotate(360deg); } }
            .status { font-size: 14px; font-weight: 500; min-height: 24px; color: #444; }
            .result { display: none; text-align: left; background: #f8f9fa;
                border: 1px solid #e9ecef; padding: 12px; border-radius: 8px;
                margin-top: 14px; font-size: 12px; }
            .result textarea { width: 100%; height: 70px; margin-top: 6px;
                font-family: monospace; font-size: 11px; padding: 6px;
                border: 1px solid #ccc; border-radius: 4px; resize: none; }
            .copy { background: #0068ff; color: #fff; border: none;
                padding: 6px 12px; border-radius: 6px; font-size: 11px;
                cursor: pointer; margin-top: 6px; }
            details { margin-top: 8px; }
            summary { cursor: pointer; color: #0068ff; font-weight: 600; }
        </style>
    </head>
    <body>
        <div class="card">
            <div class="mac">💻</div>
            <h2>Đăng nhập Máy tính</h2>
            <div class="sub">Yêu cầu quyền truy cập phiên bản Máy tính</div>

            <div class="warn">
                ⛔ <b>KHÔNG dùng "Mã QR của tôi"</b> để quét!<br>
                Nút đó chỉ đọc văn bản và sẽ in ra chuỗi mã lỗi.
            </div>

            <div class="ok">
                ✅ <b>Cách quét đúng:</b><br>
                1. Mở Zalo trên điện thoại<br>
                2. Bấm biểu tượng <b>quét QR</b> ở góc trên bên phải<br>
                3. Hướng camera vào mã QR bên dưới<br>
                4. Điện thoại sẽ hiện bảng <b>"Có thiết bị yêu cầu đăng nhập"</b> → Bấm <b>Đồng ý</b>
            </div>

            <div class="qr-wrapper" id="qrContainer">
                <div class="spinner" id="spinner"></div>
                <div id="qrcode"></div>
            </div>

            <div class="status" id="statusText">Đang tạo mã QR cho máy tính...</div>

            <div class="result" id="resultBox">
                <div><b>Trạng thái:</b> <span style="color:#28a745;">✅ Đã đăng nhập máy tính thành công</span></div>
                <div style="margin-top:6px;"><b>IMEI:</b> <span id="imeiDisplay"></span></div>
                <details open>
                    <summary>🍪 Cookies (thu gọn)</summary>
                    <textarea id="resCookies" readonly></textarea>
                    <button class="copy" onclick="copyCk()">Sao chép Cookies</button>
                </details>
            </div>
        </div>

        <script>
            let lastSid = null, stopped = false, lastScanned = false;

            async function poll() {
                if (stopped) return;
                try {
                    const r = await fetch('/api/status');
                    const d = await r.json();

                    if (d.status === 'INITIALIZING') {
                        spinner.style.display = 'block';
                        document.getElementById('qrcode').innerHTML = '';
                        statusText.innerText = 'Đang yêu cầu mã từ Zalo...';
                        statusText.style.color = '#555';
                        resultBox.style.display = 'none';
                    }
                    else if (d.status === 'WAITING' && d.qrData) {
                        if (lastSid !== d.id) {
                            lastSid = d.id;
                            spinner.style.display = 'none';
                            const box = document.getElementById('qrcode');
                            box.innerHTML = '';
                            if (d.qrIsImage) {
                                box.innerHTML = '<img src="' + d.qrData + '" />';
                            } else {
                                new QRCode(box, { text: d.qrData, width: 230, height: 230 });
                            }
                        }
                        if (d.scanned && !lastScanned) {
                            lastScanned = true;
                            statusText.innerText = '📱 Đã quét! Bấm Đồng ý trên điện thoại...';
                            statusText.style.color = '#ff9500';
                        } else if (!d.scanned) {
                            statusText.innerText = 'Mở Zalo → quét QR → bấm Đồng ý';
                            statusText.style.color = '#0068ff';
                        }
                    }
                    else if (d.status === 'SUCCESS') {
                        stopped = true;
                        spinner.style.display = 'none';
                        document.getElementById('qrcode').innerHTML =
                            '<p style="color:#28a745;font-weight:bold;font-size:15px;">✔ Đã xác nhận!<br>Mã QR đã được hủy.</p>';
                        statusText.innerText = '🎉 Đăng nhập thành công!';
                        statusText.style.color = '#28a745';
                        resultBox.style.display = 'block';
                        document.getElementById('imeiDisplay').innerText = d.imei;
                        const ck = Object.entries(d.cookies).map(([k,v])=>k+'='+v).join('; ');
                        document.getElementById('resCookies').value = ck;
                    }
                    else if (d.status === 'ERROR') {
                        spinner.style.display = 'none';
                        statusText.innerText = d.error || 'Lỗi, thử lại...';
                        statusText.style.color = '#dc3545';
                        if (d.error && d.error.includes('Hết hạn')) stopped = true;
                    }
                } catch(e) {}
                if (!stopped) setTimeout(poll, 1200);
            }

            function copyCk() {
                const t = document.getElementById('resCookies');
                t.select(); document.execCommand('copy');
                alert('Đã sao chép Cookies!');
            }

            poll();
        </script>
    </body>
    </html>
    `);
});
