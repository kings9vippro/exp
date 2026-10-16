const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Zalo } = require('zca-js');

const app = express();
const PORT = process.env.PORT || 10000;

let currentSession = {
    id: null,
    status: 'INITIALIZING', // INITIALIZING | WAITING | SUCCESS | ERROR
    qrPath: path.join(__dirname, 'qr.png'),
    imei: null,
    cookies: null
};

// Xóa file QR trên ổ đĩa
function clearQR() {
    if (fs.existsSync(currentSession.qrPath)) {
        try { fs.unlinkSync(currentSession.qrPath); } catch (e) {}
    }
}

// Vòng lặp tự động tạo QR mới liên tục
async function startSessionLoop() {
    while (true) {
        clearQR();
        currentSession.id = crypto.randomUUID().slice(0, 8);
        currentSession.status = 'INITIALIZING';
        currentSession.imei = crypto.randomUUID();
        currentSession.cookies = null;

        console.log(`\n--- Khởi tạo phiên mới: ${currentSession.id} ---`);

        const zalo = new Zalo({
            selfListen: false,
            checkUpdate: false,
            imei: currentSession.imei
        });

        // Đợi file qr.png xuất hiện
        const checkExist = setInterval(() => {
            if (fs.existsSync(currentSession.qrPath)) {
                currentSession.status = 'WAITING';
                clearInterval(checkExist);
            }
        }, 400);

        try {
            // Chờ người dùng quét và bấm Xác nhận trên điện thoại
            const api = await zalo.loginQR();
            clearInterval(checkExist);

            console.log(`✅ [${currentSession.id}] Đăng nhập thành công!`);
            currentSession.status = 'SUCCESS';
            currentSession.cookies = api.getCookie ? api.getCookie() : "Đã cấp quyền truy cập";

            // Tiêu hủy mã QR ngay lập tức (dùng 1 lần rồi vứt)
            clearQR();

            // Nghỉ 4 giây hiển thị thông báo thành công trước khi đổi sang mã mới
            await new Promise(r => setTimeout(r, 4000));
        } catch (err) {
            clearInterval(checkExist);
            console.error(`❌ [${currentSession.id}] Lỗi hoặc hết hạn:`, err.message);
            clearQR();
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

// Chạy tiến trình nền
startSessionLoop();

// Trả ảnh QR
app.get('/qr.png', (req, res) => {
    if (currentSession.status === 'WAITING' && fs.existsSync(currentSession.qrPath)) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        return res.sendFile(currentSession.qrPath);
    }
    res.status(404).send('QR chưa sẵn sàng hoặc đã được sử dụng.');
});

// API kiểm tra trạng thái
app.get('/api/status', (req, res) => {
    res.json({
        sessionId: currentSession.id,
        status: currentSession.status,
        imei: currentSession.imei,
        cookies: currentSession.cookies
    });
});

// Giao diện người dùng
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="vi">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <title>Zalo QR Login</title>
        <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body {
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                background-color: #f0f2f5;
                display: flex; justify-content: center; align-items: center;
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

            <div class="status-text" id="statusText">Đang khởi tạo mã QR...</div>
        </div>

        <script>
            let currentSid = null;

            setInterval(async () => {
                try {
                    const res = await fetch('/api/status');
                    const data = await res.json();

                    if (data.status === 'INITIALIZING') {
                        document.getElementById('spinner').style.display = 'block';
                        document.getElementById('qrImg').style.display = 'none';
                        document.getElementById('statusText').innerText = 'Đang sinh mã mới...';
                        document.getElementById('statusText').style.color = '#555';
                    } 
                    else if (data.status === 'WAITING') {
                        if (currentSid !== data.sessionId) {
                            currentSid = data.sessionId;
                            document.getElementById('spinner').style.display = 'none';
                            const img = document.getElementById('qrImg');
                            img.src = '/qr.png?t=' + Date.now();
                            img.style.display = 'block';
                            document.getElementById('statusText').innerText = 'Quét mã và bấm Xác nhận trên điện thoại';
                            document.getElementById('statusText').style.color = '#0068ff';
                        }
                    } 
                    else if (data.status === 'SUCCESS') {
                        document.getElementById('spinner').style.display = 'none';
                        document.getElementById('qrImg').style.display = 'none';
                        document.getElementById('statusText').innerText = '🎉 Đăng nhập thành công! Đang chuyển mã tiếp theo...';
                        document.getElementById('statusText').style.color = '#28a745';
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
