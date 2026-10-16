const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;

// Giả lập Safari / macOS để Zalo nhận diện thiết bị Apple
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

let currentSession = {
    id: null,
    status: 'INITIALIZING', // INITIALIZING | WAITING | SUCCESS | ERROR
    qrData: null,          // Dữ liệu mã QR (Base64 hoặc URL)
    imei: null,
    cookies: null,
    error: null
};

// Đọc cookie từ phản hồi server
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

// Vòng lặp xoay vòng mã QR liên tục (Dùng 1 lần rồi hủy)
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

            // 1. Lấy phiên truy cập từ Zalo ID
            const initRes = await fetch("https://id.zalo.me/account?continue=https%3A%2F%2Fchat.zalo.me%2F", {
                headers: { "User-Agent": USER_AGENT }
            });
            Object.assign(cookieJar, parseCookies(initRes.headers));

            // 2. Yêu cầu tạo mã QR
            const qrRes = await fetch("https://id.zalo.me/account/authen/qr/generate", {
                headers: {
                    "User-Agent": USER_AGENT,
                    "Referer": "https://id.zalo.me/account?continue=https%3A%2F%2Fchat.zalo.me%2F",
                    "Cookie": stringifyCookies(cookieJar)
                }
            });
            Object.assign(cookieJar, parseCookies(qrRes.headers));

            const qrJson = await qrRes.json();
            if (qrJson.error_code !== 0 || !qrJson.data) {
                throw new Error(qrJson.error_message || "Zalo từ chối sinh mã QR");
            }

            const code = qrJson.data.code;
            // Sử dụng ảnh base64 trực tiếp từ Zalo hoặc chuỗi mã code
            currentSession.qrData = qrJson.data.image || qrJson.data.url || code;
            currentSession.status = 'WAITING';
            console.log(`[Phiên: ${currentSession.id}] QR sẵn sàng, đang đợi quét...`);

            // 3. Chờ xác nhận từ điện thoại
            const startTime = Date.now();
            let isDone = false;

            while (Date.now() - startTime < 120000) { // Hạn mã 2 phút
                await new Promise(r => setTimeout(r, 2000));

                const checkRes = await fetch(`https://id.zalo.me/account/authen/qr/waiting-scan?code=${encodeURIComponent(code)}`, {
                    headers: {
                        "User-Agent": USER_AGENT,
                        "Referer": "https://id.zalo.me/account?continue=https%3A%2F%2Fchat.zalo.me%2F",
                        "Cookie": stringifyCookies(cookieJar)
                    }
                });
                Object.assign(cookieJar, parseCookies(checkRes.headers));

                const checkJson = await checkRes.json();

                // Đã bấm Chấp nhận trên điện thoại
                if (checkJson.error_code === 0 && checkJson.data && (checkJson.data.status === 2 || checkJson.data.url)) {
                    console.log(`🎉 [Phiên: ${currentSession.id}] Đăng nhập thành công!`);

                    if (checkJson.data.url) {
                        const finalRes = await fetch(checkJson.data.url, {
                            headers: {
                                "User-Agent": USER_AGENT,
                                "Cookie": stringifyCookies(cookieJar)
                            },
                            redirect: 'manual'
                        });
                        Object.assign(cookieJar, parseCookies(finalRes.headers));
                    }

                    currentSession.status = 'SUCCESS';
                    currentSession.cookies = cookieJar;
                    currentSession.qrData = null; // Tiêu hủy QR ngay khi hoàn tất
                    isDone = true;

                    // Giữ 3.5 giây hiển thị thông báo rồi chuyển sang máy tiếp theo
                    await new Promise(r => setTimeout(r, 3500));
                    break;
                }
            }

            if (!isDone) {
                console.log(`[Phiên: ${currentSession.id}] Hết hạn chờ, đang sinh mã mới.`);
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

// API trạng thái
app.get('/api/status', (req, res) => {
    res.json(currentSession);
});

// Giao diện tự động render QR qua CDN (Không phụ thuộc module server)
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="vi">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <title>Zalo QR Login</title>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
        <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
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
                font-size: 11px; padding: 6px; border: 1px solid #ccc; border-radius: 4px;
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

            <div class="status-text" id="statusText">Đang khởi tạo mã...</div>

            <div class="result-box" id="resultBox">
                <b>Trạng thái:</b> Đã bắt phiên đăng nhập!<br>
                <textarea id="resCookies" readonly></textarea>
            </div>
        </div>

        <script>
            let lastSid = null;
            let qrCodeObj = null;

            setInterval(async () => {
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
                        document.getElementById('qrcode').innerHTML = '<p style="color:#28a745;font-weight:bold;">✔ Đã nhận diện!<br>Mã cũ đã bị hủy.</p>';
                        document.getElementById('statusText').innerText = '🎉 Thành công! Đang chuyển tiếp mã mới...';
                        document.getElementById('statusText').style.color = '#28a745';
                        document.getElementById('resultBox').style.display = 'block';
                        document.getElementById('resCookies').value = JSON.stringify(data.cookies);
                    }
                    else if (data.status === 'ERROR') {
                        document.getElementById('statusText').innerText = 'Lỗi kết nối Zalo, đang thử lại...';
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
