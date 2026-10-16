const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;

// Giả lập Safari / macOS để Zalo nhận diện thiết bị Apple
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

let currentSession = {
    id: null,
    status: 'INITIALIZING', // INITIALIZING | WAITING | SUCCESS | ERROR
    qrData: null,
    imei: null,
    cookies: null,
    error: null
};

// Hàm trích xuất toàn bộ cookie từ phản hồi của Zalo
function collectCookies(response, cookieJar) {
    let setCookies = [];
    if (typeof response.headers.getSetCookie === 'function') {
        setCookies = response.headers.getSetCookie();
    } else {
        const raw = response.headers.get('set-cookie');
        if (raw) setCookies = [raw];
    }

    for (const cookieStr of setCookies) {
        const firstPart = cookieStr.split(';')[0];
        const eqIdx = firstPart.indexOf('=');
        if (eqIdx !== -1) {
            const key = firstPart.substring(0, eqIdx).trim();
            const val = firstPart.substring(eqIdx + 1).trim();
            if (key) cookieJar[key] = val;
        }
    }
}

function stringifyCookies(cookieJar) {
    return Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');
}

// Vòng lặp tự động tạo QR một lần và làm mới liên tục
async function startSessionLoop() {
    while (true) {
        currentSession.id = crypto.randomUUID().slice(0, 8);
        currentSession.status = 'INITIALIZING';
        currentSession.qrData = null;
        currentSession.imei = crypto.randomUUID();
        currentSession.cookies = null;
        currentSession.error = null;

        console.log(`\n========================================`);
        console.log(`[Phiên mới: ${currentSession.id}] Đang yêu cầu Zalo cấp mã QR...`);

        try {
            let cookieJar = {};

            // 1. Tải trang xác thực ban đầu để lấy cookie phiên (Session Cookies)
            const initRes = await fetch("https://id.zalo.me/account?continue=https%3A%2F%2Fchat.zalo.me%2F", {
                headers: {
                    "User-Agent": USER_AGENT,
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8"
                }
            });
            collectCookies(initRes, cookieJar);

            // 2. Gửi request POST đúng chuẩn để sinh mã QR
            const qrRes = await fetch("https://id.zalo.me/account/authen/qr/generate", {
                method: "POST",
                headers: {
                    "User-Agent": USER_AGENT,
                    "Accept": "application/json, text/javascript, */*; q=0.01",
                    "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8",
                    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                    "Origin": "https://id.zalo.me",
                    "Referer": "https://id.zalo.me/account?continue=https%3A%2F%2Fchat.zalo.me%2F",
                    "X-Requested-With": "XMLHttpRequest",
                    "Sec-Fetch-Dest": "empty",
                    "Sec-Fetch-Mode": "cors",
                    "Sec-Fetch-Site": "same-origin",
                    "Cookie": stringifyCookies(cookieJar)
                },
                body: new URLSearchParams({
                    continue: "https://chat.zalo.me/"
                }).toString()
            });

            collectCookies(qrRes, cookieJar);

            const qrJson = await qrRes.json();
            if (qrJson.error_code !== 0 || !qrJson.data) {
                throw new Error(qrJson.error_message || "Zalo từ chối cấp mã QR");
            }

            const code = qrJson.data.code;
            currentSession.qrData = qrJson.data.image || qrJson.data.url || code;
            currentSession.status = 'WAITING';
            console.log(`[Phiên: ${currentSession.id}] ✅ Đã tạo mã QR thành công! Chờ quét...`);

            // 3. Vòng lặp chờ xác nhận quét từ điện thoại
            const startTime = Date.now();
            let isDone = false;

            while (Date.now() - startTime < 120000) { // Hạn mã: 2 phút
                await new Promise(r => setTimeout(r, 2000));

                const checkRes = await fetch("https://id.zalo.me/account/authen/qr/waiting-scan", {
                    method: "POST",
                    headers: {
                        "User-Agent": USER_AGENT,
                        "Accept": "application/json, text/javascript, */*; q=0.01",
                        "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8",
                        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                        "Origin": "https://id.zalo.me",
                        "Referer": "https://id.zalo.me/account?continue=https%3A%2F%2Fchat.zalo.me%2F",
                        "X-Requested-With": "XMLHttpRequest",
                        "Cookie": stringifyCookies(cookieJar)
                    },
                    body: new URLSearchParams({
                        code: code,
                        continue: "https://chat.zalo.me/"
                    }).toString()
                });

                collectCookies(checkRes, cookieJar);

                const checkJson = await checkRes.json();

                // Trạng thái đã duyệt trên ứng dụng Zalo
                if (checkJson.error_code === 0 && checkJson.data && (checkJson.data.status === 2 || checkJson.data.url)) {
                    console.log(`🎉 [Phiên: ${currentSession.id}] Đăng nhập thành công từ thiết bị Apple!`);

                    if (checkJson.data.url) {
                        const finalRes = await fetch(checkJson.data.url, {
                            headers: {
                                "User-Agent": USER_AGENT,
                                "Cookie": stringifyCookies(cookieJar)
                            },
                            redirect: 'manual'
                        });
                        collectCookies(finalRes, cookieJar);
                    }

                    currentSession.status = 'SUCCESS';
                    currentSession.cookies = cookieJar;
                    currentSession.qrData = null; // Tiêu hủy QR ngay lập tức
                    isDone = true;

                    // Dừng 3.5 giây để màn hình báo thành công trước khi đổi sang QR mới
                    await new Promise(r => setTimeout(r, 3500));
                    break;
                }
            }

            if (!isDone) {
                console.log(`[Phiên: ${currentSession.id}] Mã QR hết hạn, đang tạo mã mới...`);
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

// API cung cấp dữ liệu phiên cho giao diện
app.get('/api/status', (req, res) => {
    res.json(currentSession);
});

// Giao diện người dùng
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
            <div class="badge">Thiết bị: Apple Safari (macOS / iPad)</div>
            <p class="desc">Mở Zalo trên điện thoại để quét mã</p>

            <div class="qr-wrapper" id="qrContainer">
                <div class="spinner" id="spinner"></div>
                <div id="qrcode"></div>
            </div>

            <div class="status-text" id="statusText">Đang khởi tạo mã QR...</div>

            <div class="result-box" id="resultBox">
                <b>Trạng thái:</b> Đã xác nhận đăng nhập thành công!<br>
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
                        document.getElementById('spinner').style.display = 'none';
                        document.getElementById('qrcode').innerHTML = '<p style="color:#28a745;font-weight:bold;">✔ Đã nhận diện!<br>Mã này đã bị hủy.</p>';
                        document.getElementById('statusText').innerText = '🎉 Đăng nhập thành công! Đang đổi mã mới...';
                        document.getElementById('statusText').style.color = '#28a745';
                        document.getElementById('resultBox').style.display = 'block';
                        document.getElementById('resCookies').value = JSON.stringify(data.cookies);
                    }
                    else if (data.status === 'ERROR') {
                        document.getElementById('spinner').style.display = 'none';
                        document.getElementById('statusText').innerText = data.error || 'Lỗi kết nối Zalo, đang thử lại...';
                        document.getElementById('statusText').style.color = '#dc3545';
                    }
                } catch (e) {}
            }, 1200);
        </script>
    </body>
    </html>
    `);
});

app.listen(PORT, () => {
    console.log(`Server khởi động thành công trên cổng: ${PORT}`);
});
