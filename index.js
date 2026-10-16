const express = require('express');
const crypto = require('crypto');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 10000;

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

let currentSession = {
    id: null,
    status: 'INITIALIZING', // INITIALIZING | WAITING | SUCCESS | ERROR
    qrImage: null,
    imei: null,
    cookies: null,
    error: null
};

// Trích xuất cookie từ header Set-Cookie
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

// Vòng lặp tự động tạo QR từ API Zalo
async function runZaloQRLoop() {
    while (true) {
        currentSession.id = crypto.randomUUID().slice(0, 8);
        currentSession.status = 'INITIALIZING';
        currentSession.qrImage = null;
        currentSession.imei = crypto.randomUUID();
        currentSession.cookies = null;
        currentSession.error = null;

        console.log(`\n========================================`);
        console.log(`[Phiên mới: ${currentSession.id}] Đang yêu cầu Zalo cấp mã QR...`);

        try {
            let cookieJar = {};

            // 1. Lấy phiên khởi tạo ban đầu từ Zalo ID
            const initRes = await fetch("https://id.zalo.me/account?continue=https%3A%2F%2Fchat.zalo.me%2F", {
                headers: { "User-Agent": USER_AGENT }
            });
            Object.assign(cookieJar, parseCookies(initRes.headers));

            // 2. Gọi API Zalo tạo mã QR đăng nhập
            const qrRes = await fetch("https://id.zalo.me/account/authen/qr/generate", {
                headers: {
                    "User-Agent": USER_AGENT,
                    "Referer": "https://id.zalo.me/account?continue=https%3A%2F%2Fchat.zalo.me%2F",
                    "Cookie": stringifyCookies(cookieJar)
                }
            });
            Object.assign(cookieJar, parseCookies(qrRes.headers));

            const qrData = await qrRes.json();
            if (qrData.error_code !== 0 || !qrData.data) {
                throw new Error(qrData.error_message || "Zalo từ chối sinh mã QR");
            }

            const code = qrData.data.code;
            
            // Vẽ ảnh QR từ chuỗi mã code trả về
            if (qrData.data.image) {
                currentSession.qrImage = qrData.data.image;
            } else {
                currentSession.qrImage = await QRCode.toDataURL(code || qrData.data.url);
            }

            currentSession.status = 'WAITING';
            console.log(`[Phiên: ${currentSession.id}] Đã có mã QR! Đang đợi quét...`);

            // 3. Polling kiểm tra người dùng bấm chấp nhận trên điện thoại
            const startTime = Date.now();
            let isDone = false;

            while (Date.now() - startTime < 120000) { // Hạn mã: 2 phút
                await new Promise(r => setTimeout(r, 2000));

                const checkRes = await fetch(`https://id.zalo.me/account/authen/qr/waiting-scan?code=${encodeURIComponent(code)}`, {
                    headers: {
                        "User-Agent": USER_AGENT,
                        "Referer": "https://id.zalo.me/account?continue=https%3A%2F%2Fchat.zalo.me%2F",
                        "Cookie": stringifyCookies(cookieJar)
                    }
                });
                Object.assign(cookieJar, parseCookies(checkRes.headers));

                const checkData = await checkRes.json();

                // Trạng thái thành công khi điện thoại bấm Đồng ý
                if (checkData.error_code === 0 && checkData.data && (checkData.data.status === 2 || checkData.data.url)) {
                    console.log(`🎉 [Phiên: ${currentSession.id}] Đăng nhập thành công!`);
                    
                    // Nếu Zalo trả về URL xác nhận cuối cùng để lấy token/cookie
                    if (checkData.data.url) {
                        const finalRes = await fetch(checkData.data.url, {
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
                    currentSession.qrImage = null; // Tiêu hủy QR ngay lập tức
                    isDone = true;

                    // Nghỉ 4 giây hiển thị thông báo thành công rồi tự động tạo mã kế tiếp
                    await new Promise(r => setTimeout(r, 4000));
                    break;
                }
            }

            if (!isDone) {
                console.log(`[Phiên: ${currentSession.id}] QR hết hạn, tạo mã mới.`);
            }

        } catch (err) {
            console.error(`❌ Lỗi phiên ${currentSession.id}:`, err.message);
            currentSession.status = 'ERROR';
            currentSession.error = err.message;
            await new Promise(r => setTimeout(r, 3000));
        }
    }
}

runZaloQRLoop();

// API trạng thái cho giao diện
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
        <title>Zalo QR Login (Auto-Rotate)</title>
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
            p.desc { font-size: 13px; color: #666; margin-bottom: 16px; }
            .qr-wrapper {
                width: 250px; height: 250px; margin: 0 auto 16px;
                border: 1px solid #e1e4ea; border-radius: 12px;
                display: flex; align-items: center; justify-content: center;
                background: #fafafa; position: relative; overflow: hidden;
            }
            .qr-wrapper img { width: 100%; height: 100%; object-fit: contain; }
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
            <p class="desc">Mở Zalo trên điện thoại để quét mã</p>

            <div class="qr-wrapper" id="qrContainer">
                <div class="spinner" id="spinner"></div>
                <img id="qrImg" style="display: none;" alt="QR Code">
            </div>

            <div class="status-text" id="statusText">Đang kết nối Zalo...</div>

            <div class="result-box" id="resultBox">
                <b>Trạng thái:</b> Đã bắt phiên đăng nhập!<br>
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
                        document.getElementById('statusText').innerText = 'Đang tạo mã QR mới...';
                        document.getElementById('statusText').style.color = '#555';
                        document.getElementById('resultBox').style.display = 'none';
                    } 
                    else if (data.status === 'WAITING' && data.qrImage) {
                        if (lastSid !== data.id) {
                            lastSid = data.id;
                            document.getElementById('spinner').style.display = 'none';
                            const img = document.getElementById('qrImg');
                            img.src = data.qrImage;
                            img.style.display = 'block';
                            document.getElementById('statusText').innerText = 'Mở Zalo quét và bấm Xác nhận';
                            document.getElementById('statusText').style.color = '#0068ff';
                        }
                    } 
                    else if (data.status === 'SUCCESS') {
                        document.getElementById('spinner').style.display = 'none';
                        document.getElementById('qrImg').style.display = 'none';
                        document.getElementById('statusText').innerText = '🎉 Đăng nhập thành công! Đang sinh mã tiếp theo...';
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
    console.log(`Server chạy tại cổng: ${PORT}`);
});
