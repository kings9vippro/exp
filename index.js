const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;

// Header chuẩn của trình duyệt máy tính macOS Safari
const DESKTOP_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

let currentSession = {
    id: null,
    status: 'INITIALIZING', // INITIALIZING | WAITING | SCANNED | SUCCESS | ERROR
    qrImage: null,          // Ảnh base64 trực tiếp từ Zalo
    cookies: null,
    error: null
};

// Thu thập toàn bộ cookie phản hồi
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
            "User-Agent": DESKTOP_USER_AGENT,
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
        currentSession.qrImage = null;
        currentSession.cookies = null;
        currentSession.error = null;

        console.log(`\n========================================`);
        console.log(`[Phiên máy tính: ${currentSession.id}] Đang yêu cầu Zalo cấp mã QR...`);

        try {
            let cookieJar = {
                "_zlang": "vn",
                "has_actived": "1"
            };

            // 1. Tải trang đăng nhập để lấy Session Handshake của Zalo
            await safeFetch("https://id.zalo.me/account?continue=https%3A%2F%2Fchat.zalo.me%2F", {
                method: "GET",
                headers: {
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8",
                    "Sec-Fetch-Dest": "document",
                    "Sec-Fetch-Mode": "navigate",
                    "Sec-Fetch-Site": "none"
                }
            }, cookieJar);

            // 2. Yêu cầu tạo mã QR (Đã bỏ hoàn toàn tham số imei giả lập)
            const qrRes = await safeFetch("https://id.zalo.me/account/authen/qr/generate", {
                method: "POST",
                headers: {
                    "Accept": "application/json, text/javascript, */*; q=0.01",
                    "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8",
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
                throw new Error(qrJson.error_message || "Zalo từ chối sinh mã QR");
            }

            const qrCode = qrJson.data.code;

            // Bắt buộc lấy ảnh Base64 do máy chủ Zalo tự render để không bị sai định dạng
            if (qrJson.data.image && qrJson.data.image.startsWith('data:image')) {
                currentSession.qrImage = qrJson.data.image;
            } else if (qrJson.data.url) {
                // Fallback nếu Zalo trả link url
                currentSession.qrImage = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(qrJson.data.url)}`;
            } else {
                throw new Error("Không nhận được ảnh QR hợp lệ từ Zalo");
            }

            currentSession.status = 'WAITING';
            console.log(`[Phiên: ${currentSession.id}] ✅ Đã tạo mã QR hợp lệ! Chờ quét...`);

            // 3. Vòng lặp kiểm tra trạng thái quét (Hạn mã 2 phút)
            const startTime = Date.now();
            let isDone = false;

            while (Date.now() - startTime < 120000) {
                await new Promise(r => setTimeout(r, 2000));

                const checkRes = await safeFetch("https://id.zalo.me/account/authen/qr/waiting-scan", {
                    method: "POST",
                    headers: {
                        "Accept": "application/json, text/javascript, */*; q=0.01",
                        "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8",
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
                    
                    // st = 1: Đã quét trên điện thoại, đang đợi bấm Đồng ý
                    if (st === 1) {
                        currentSession.status = 'SCANNED';
                    }

                    // st = 2 hoặc có url: Đã bấm Đồng ý trên điện thoại
                    if (st === 2 || checkJson.data.url) {
                        console.log(`🎉 [Phiên: ${currentSession.id}] Đăng nhập thành công!`);
                        if (checkJson.data.url) {
                            await safeFetch(checkJson.data.url, { method: "GET" }, cookieJar);
                        }
                        currentSession.status = 'SUCCESS';
                        currentSession.cookies = { ...cookieJar };
                        currentSession.qrImage = null; // Tiêu hủy mã ngay khi quét xong
                        isDone = true;

                        // Chờ 4 giây trước khi tự sinh mã mới cho người kế tiếp
                        await new Promise(r => setTimeout(r, 4000));
                        break;
                    }
                }
            }

            if (!isDone) {
                console.log(`[Phiên: ${currentSession.id}] Hết thời gian chờ, tạo mã mới...`);
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
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <title>Đăng nhập Zalo - Máy tính</title>
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
            <div class="badge">💻 Thiết bị: MacBook Safari (macOS)</div>
            <p class="desc">Mở Zalo trên điện thoại để quét mã</p>
            <div class="qr-wrapper" id="qrContainer">
                <div class="spinner" id="spinner"></div>
                <img id="qrImg" style="display: none;" alt="QR Code">
            </div>
            <div class="status-text" id="statusText">Đang khởi tạo mã QR...</div>
            <div class="result-box" id="resultBox">
                <b>Trạng thái:</b> Đăng nhập máy tính thành công!<br>
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
                        document.getElementById('qrImg').style.display = 'none';
                        document.getElementById('statusText').innerText = 'Đang yêu cầu mã từ Zalo...';
                        document.getElementById('statusText').style.color = '#555';
                        document.getElementById('resultBox').style.display = 'none';
                    } else if (data.status === 'WAITING' && data.qrImage) {
                        if (lastSid !== data.id) {
                            lastSid = data.id;
                            document.getElementById('spinner').style.display = 'none';
                            const img = document.getElementById('qrImg');
                            img.src = data.qrImage;
                            img.style.display = 'block';
                            document.getElementById('statusText').innerText = 'Quét mã bằng Zalo để nhận thông báo';
                            document.getElementById('statusText').style.color = '#0068ff';
                        }
                    } else if (data.status === 'SCANNED') {
                        document.getElementById('statusText').innerText = '📱 Đã nhận diện! Bấm Đồng ý trên điện thoại';
                        document.getElementById('statusText').style.color = '#e67e22';
                    } else if (data.status === 'SUCCESS') {
                        document.getElementById('spinner').style.display = 'none';
                        document.getElementById('qrImg').style.display = 'none';
                        document.getElementById('statusText').innerText = '🎉 Đăng nhập máy tính thành công!';
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
