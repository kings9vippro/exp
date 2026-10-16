const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;

// User-Agent chuẩn của Firefox trên Windows 10/11
const FIREFOX_WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0";

let currentSession = {
    id: null,
    status: 'INITIALIZING', // INITIALIZING | WAITING | SCANNED | SUCCESS | ERROR
    qrData: null,          // Chuỗi code hoặc ảnh base64
    qrIsImage: false,
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

async function safeFetch(url, options = {}, jar = {}) {
    let targetUrl = url;
    let redirectCount = 0;
    while (redirectCount < 5) {
        const headers = {
            ...(options.headers || {}),
            "User-Agent": FIREFOX_WIN_UA,
            "Cookie": stringifyJar(jar)
        };
        const res = await fetch(targetUrl, {
            ...options,
            headers,
            redirect: 'manual',
            signal: AbortSignal.timeout(25000)
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

async function startSessionLoop() {
    while (true) {
        currentSession.id = crypto.randomUUID().slice(0, 8);
        currentSession.status = 'INITIALIZING';
        currentSession.qrData = null;
        currentSession.qrIsImage = false;
        currentSession.cookies = null;
        currentSession.error = null;

        console.log(`\n========================================`);
        console.log(`[Phiên: ${currentSession.id}] Khởi tạo kết nối Firefox - Windows...`);

        try {
            let cookieJar = {
                "_zlang": "vn",
                "has_actived": "1"
            };

            // 1. Handshake phiên với Zalo Account Portal
            await safeFetch("https://id.zalo.me/account?continue=https%3A%2F%2Fchat.zalo.me%2F", {
                method: "GET",
                headers: {
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                    "Accept-Language": "vi-VN,vi;q=0.8,en-US;q=0.5,en;q=0.3",
                    "Sec-Fetch-Dest": "document",
                    "Sec-Fetch-Mode": "navigate",
                    "Sec-Fetch-Site": "none",
                    "Upgrade-Insecure-Requests": "1"
                }
            }, cookieJar);

            // 2. Yêu cầu cấp mã QR đăng nhập
            const qrRes = await safeFetch("https://id.zalo.me/account/authen/qr/generate", {
                method: "POST",
                headers: {
                    "Accept": "application/json, text/javascript, */*; q=0.01",
                    "Accept-Language": "vi-VN,vi;q=0.8,en-US;q=0.5,en;q=0.3",
                    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                    "Origin": "https://id.zalo.me",
                    "Referer": "https://id.zalo.me/account?continue=https%3A%2F%2Fchat.zalo.me%2F",
                    "X-Requested-With": "XMLHttpRequest",
                    "Sec-Fetch-Dest": "empty",
                    "Sec-Fetch-Mode": "cors",
                    "Sec-Fetch-Site": "same-origin"
                },
                body: new URLSearchParams({
                    continue: "https://chat.zalo.me/"
                }).toString()
            }, cookieJar);

            const qrJson = await qrRes.json();
            if (qrJson.error_code !== 0 || !qrJson.data || !qrJson.data.code) {
                throw new Error(qrJson.error_message || "Zalo từ chối cấp mã QR");
            }

            const qrCode = qrJson.data.code;

            // Kiểm tra ảnh base64 từ Zalo hoặc sử dụng code thô
            if (qrJson.data.image && qrJson.data.image.startsWith('data:image')) {
                currentSession.qrData = qrJson.data.image;
                currentSession.qrIsImage = true;
            } else {
                currentSession.qrData = qrCode;
                currentSession.qrIsImage = false;
            }

            currentSession.status = 'WAITING';
            console.log(`[Phiên: ${currentSession.id}] ✅ Đã tạo QR Firefox - Windows! Đang chờ quét...`);

            // 3. Vòng lặp chờ xác nhận trên điện thoại (Hạn 2 phút)
            const startTime = Date.now();
            let isDone = false;

            while (Date.now() - startTime < 120000) {
                await new Promise(r => setTimeout(r, 2000));

                const checkRes = await safeFetch("https://id.zalo.me/account/authen/qr/waiting-scan", {
                    method: "POST",
                    headers: {
                        "Accept": "application/json, text/javascript, */*; q=0.01",
                        "Accept-Language": "vi-VN,vi;q=0.8,en-US;q=0.5,en;q=0.3",
                        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                        "Origin": "https://id.zalo.me",
                        "Referer": "https://id.zalo.me/account?continue=https%3A%2F%2Fchat.zalo.me%2F",
                        "X-Requested-With": "XMLHttpRequest",
                        "Sec-Fetch-Dest": "empty",
                        "Sec-Fetch-Mode": "cors",
                        "Sec-Fetch-Site": "same-origin"
                    },
                    body: new URLSearchParams({
                        code: qrCode,
                        continue: "https://chat.zalo.me/"
                    }).toString()
                }, cookieJar);

                const checkJson = await checkRes.json();

                if (checkJson.error_code === 0 && checkJson.data) {
                    const st = checkJson.data.status;
                    
                    if (st === 1) {
                        currentSession.status = 'SCANNED';
                    }

                    if (st === 2 || checkJson.data.url) {
                        console.log(`🎉 [Phiên: ${currentSession.id}] Thiết bị Firefox - Windows đã được duyệt!`);
                        if (checkJson.data.url) {
                            await safeFetch(checkJson.data.url, { method: "GET" }, cookieJar);
                        }
                        currentSession.status = 'SUCCESS';
                        currentSession.cookies = { ...cookieJar };
                        currentSession.qrData = null;
                        isDone = true;

                        // Hiển thị kết quả 4 giây rồi tự động xoay vòng tạo mã mới
                        await new Promise(r => setTimeout(r, 4000));
                        break;
                    }
                }
            }

            if (!isDone) {
                console.log(`[Phiên: ${currentSession.id}] Hết hạn chờ, đang làm mới...`);
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

app.get('/api/status', (req, res) => {
    res.json(currentSession);
});

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="vi">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Zalo Login — Firefox Windows</title>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
        <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f0f2f5; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 16px; }
            .card { background: #fff; width: 100%; max-width: 380px; padding: 30px 20px; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.06); text-align: center; }
            h2 { color: #0068ff; margin-bottom: 6px; font-size: 20px; }
            .badge { display: inline-block; font-size: 11px; background: #eef5ff; color: #0068ff; padding: 4px 10px; border-radius: 20px; margin-bottom: 15px; font-weight: 600; }
            p.desc { font-size: 13px; color: #666; margin-bottom: 16px; }
            .qr-wrapper { width: 250px; height: 250px; margin: 0 auto 16px; border: 1px solid #e1e4ea; border-radius: 12px; display: flex; align-items: center; justify-content: center; background: #fafafa; position: relative; overflow: hidden; }
            .qr-wrapper img { width: 230px; height: 230px; object-fit: contain; }
            .spinner { border: 3px solid #f3f3f3; border-top: 3px solid #0068ff; border-radius: 50%; width: 34px; height: 34px; animation: spin 0.8s linear infinite; }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            .status-text { font-size: 14px; font-weight: 500; color: #444; min-height: 24px; }
            .result-box { display: none; text-align: left; background: #f8f9fa; border: 1px solid #e9ecef; padding: 12px; border-radius: 8px; margin-top: 15px; font-size: 12px; }
            .result-box textarea { width: 100%; height: 80px; margin-top: 6px; font-family: monospace; font-size: 11px; padding: 6px; border: 1px solid #ccc; border-radius: 4px; resize: none; }
        </style>
    </head>
    <body>
        <div class="card">
            <h2>Zalo QR Login</h2>
            <div class="badge">🌐 Thiết bị: Firefox - Windows</div>
            <p class="desc">Mở Zalo trên điện thoại để quét mã</p>
            <div class="qr-wrapper" id="qrContainer">
                <div class="spinner" id="spinner"></div>
                <div id="qrcode"></div>
            </div>
            <div class="status-text" id="statusText">Đang khởi tạo mã...</div>
            <div class="result-box" id="resultBox">
                <b>Trạng thái:</b> Đã chấp nhận đăng nhập!<br>
                <textarea id="resCookies" readonly></textarea>
            </div>
        </div>
        <script>
            let lastSid = null;
            setInterval(async () => {
                try {
                    const res = await fetch('/api/status');
                    const data = await res.json();
                    if (data.status === 'INITIALIZING') {
                        document.getElementById('spinner').style.display = 'block';
                        document.getElementById('qrcode').innerHTML = '';
                        document.getElementById('statusText').innerText = 'Đang nhận diện phiên...';
                        document.getElementById('resultBox').style.display = 'none';
                    } else if (data.status === 'WAITING' && data.qrData) {
                        if (lastSid !== data.id) {
                            lastSid = data.id;
                            document.getElementById('spinner').style.display = 'none';
                            const box = document.getElementById('qrcode');
                            box.innerHTML = '';
                            if (data.qrIsImage) {
                                box.innerHTML = '<img src="' + data.qrData + '" style="width:230px;height:230px;" />';
                            } else {
                                new QRCode(box, {
                                    text: data.qrData,
                                    width: 230,
                                    height: 230
                                });
                            }
                            document.getElementById('statusText').innerText = 'Quét mã và bấm Xác nhận trên điện thoại';
                            document.getElementById('statusText').style.color = '#0068ff';
                        }
                    } else if (data.status === 'SCANNED') {
                        document.getElementById('statusText').innerText = '📱 Đã nhận diện! Bấm Đồng ý trên điện thoại';
                        document.getElementById('statusText').style.color = '#e67e22';
                    } else if (data.status === 'SUCCESS') {
                        document.getElementById('spinner').style.display = 'none';
                        document.getElementById('qrcode').innerHTML = '<p style="color:#28a745;font-weight:bold;">✔ Thành công!<br>Mã đã tiêu hủy.</p>';
                        document.getElementById('statusText').innerText = '🎉 Đăng nhập Firefox - Windows thành công!';
                        document.getElementById('statusText').style.color = '#28a745';
                        document.getElementById('resultBox').style.display = 'block';
                        document.getElementById('resCookies').value = JSON.stringify(data.cookies, null, 2);
                    }
                } catch (e) {}
            }, 1200);
        </script>
    </body>
    </html>
    `);
});

app.listen(PORT, () => {
    console.log(`Server chạy tại cổng: ${PORT}`);
});
