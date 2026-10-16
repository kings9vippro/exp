const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 10000;

const DATA_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let currentSession = {
    id: null,
    status: 'INITIALIZING', // INITIALIZING | WAITING | SUCCESS | ERROR
    qrPath: null,
    imei: null,
    cookies: null,
    error: null
};

const LOGGED_DEVICES = [];

// Cấu hình định danh thiết bị iPhone 18 Pro Max chính xác
const iPhone18ProMaxDevice = {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true
};

async function runZaloSessionLoop() {
    while (true) {
        const sessionId = crypto.randomUUID().slice(0, 8);
        const qrFileName = `qr_${sessionId}.png`;
        const qrFilePath = path.join(DATA_DIR, qrFileName);

        currentSession.id = sessionId;
        currentSession.status = 'INITIALIZING';
        currentSession.qrPath = `/qr-image/${sessionId}`;
        currentSession.imei = crypto.randomUUID();
        currentSession.cookies = null;
        currentSession.error = null;

        let browser = null;

        try {
            console.log(`\n========================================`);
            console.log(`[iPhone 18 Pro Max - Phiên: ${sessionId}] Khởi tạo phiên trình duyệt di động...`);

            browser = await chromium.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--single-process'
                ]
            });

            const context = await browser.newContext(iPhone18ProMaxDevice);
            const page = await context.new_page();

            console.log(`[Phiên: ${sessionId}] Đang kết nối Zalo Web...`);
            await page.goto('https://chat.zalo.me/', { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForTimeout(4000);

            // Chuyển sang tab mã QR nếu giao diện yêu cầu
            try {
                const qrTab = await page.locator('text=/QR|Quét mã/i').first();
                if (await qrTab.isVisible()) {
                    await qrTab.click();
                    await page.waitForTimeout(2000);
                }
            } catch (e) {}

            // Chụp lại màn hình mã QR
            await page.screenshot({ path: qrFilePath, fullPage: false });
            currentSession.status = 'WAITING';
            console.log(`[Phiên: ${sessionId}] ✅ Đã tạo mã QR iPhone 18 Pro Max thành công! Đang đợi quét...`);

            // Vòng lặp chờ quét từ điện thoại (Thời hạn tối đa 2 phút)
            const startTime = Date.now();
            let success = false;

            while (Date.now() - startTime < 120000) {
                await page.waitForTimeout(1500);

                const cookies = await context.cookies();
                const ckMap = {};
                cookies.forEach(c => { ckMap[c.name] = c.value; });

                const currentUrl = page.url();

                // Nhận diện trạng thái đã bấm xác nhận trên điện thoại
                if (ckMap['zpw_sek'] || (currentUrl.includes('chat.zalo.me') && !currentUrl.includes('login'))) {
                    console.log(`🎉 [Phiên: ${sessionId}] Đã quét thành công dưới danh nghĩa iPhone 18 Pro Max!`);
                    await page.waitForTimeout(2000);

                    const finalCookies = await context.cookies();
                    const finalCkMap = {};
                    finalCookies.forEach(c => { finalCkMap[c.name] = c.value; });

                    currentSession.status = 'SUCCESS';
                    currentSession.cookies = finalCkMap;
                    success = true;

                    LOGGED_DEVICES.push({
                        sessionId,
                        device: 'iPhone 18 Pro Max (iOS 18)',
                        time: new Date().toLocaleTimeString(),
                        cookies: finalCkMap
                    });

                    // Tiêu hủy file QR ngay lập tức (Cơ chế dùng 1 lần)
                    if (fs.existsSync(qrFilePath)) {
                        fs.unlinkSync(qrFilePath);
                    }

                    // Giữ thông báo thành công trong 4 giây trước khi tự động chuyển sang mã mới
                    await new Promise(r => setTimeout(r, 4000));
                    break;
                }
            }

            if (!success) {
                console.log(`[Phiên: ${sessionId}] Hết thời gian chờ QR, đang tự làm mới...`);
                if (fs.existsSync(qrFilePath)) fs.unlinkSync(qrFilePath);
            }

        } catch (err) {
            console.error(`❌ [Phiên: ${sessionId}] Lỗi hệ thống:`, err.message);
            currentSession.status = 'ERROR';
            currentSession.error = err.message;
            if (fs.existsSync(qrFilePath)) fs.unlinkSync(qrFilePath);
            await new Promise(r => setTimeout(r, 3000));
        } finally {
            if (browser) {
                await browser.close().catch(() => {});
            }
        }
    }
}

// Chạy vòng lặp tiến trình ngầm
runZaloSessionLoop();

// Cung cấp file ảnh QR
app.get('/qr-image/:sessionId', (req, res) => {
    const filePath = path.join(DATA_DIR, `qr_${req.params.sessionId}.png`);
    if (fs.existsSync(filePath)) {
        res.setHeader('Cache-Control', 'no-store');
        return res.sendFile(filePath);
    }
    res.status(404).send('Mã QR đã dùng hoặc không tồn tại.');
});

// API trả về trạng thái giao diện
app.get('/api/status', (req, res) => {
    res.json({
        id: currentSession.id,
        status: currentSession.status,
        qrUrl: currentSession.qrPath,
        cookies: currentSession.cookies,
        error: currentSession.error,
        totalLogged: LOGGED_DEVICES.length
    });
});

// Giao diện web tối ưu trực quan
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="vi">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <title>Zalo Login — iPhone 18 Pro Max</title>
        <style>
            * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
            body {
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                background-color: #f0f2f5; display: flex; justify-content: center; align-items: center;
                min-height: 100vh; padding: 16px;
            }
            .card {
                background: #fff; width: 100%; max-width: 380px;
                padding: 32px 20px; border-radius: 20px;
                box-shadow: 0 10px 30px rgba(0,0,0,0.08); text-align: center;
            }
            h2 { color: #0068ff; margin-bottom: 6px; font-size: 22px; font-weight: 800; }
            .badge {
                display: inline-block; font-size: 12px; background: #eef5ff;
                color: #0068ff; padding: 6px 14px; border-radius: 20px;
                margin-bottom: 16px; font-weight: 700;
            }
            p.desc { font-size: 13px; color: #666; margin-bottom: 18px; }
            .qr-wrapper {
                width: 250px; height: 250px; margin: 0 auto 16px;
                border: 2px solid #e1e4ea; border-radius: 16px;
                display: flex; align-items: center; justify-content: center;
                background: #fafafa; position: relative; overflow: hidden;
            }
            .qr-wrapper img { width: 100%; height: 100%; object-fit: contain; }
            .spinner {
                border: 3px solid #f3f3f3; border-top: 3px solid #0068ff;
                border-radius: 50%; width: 40px; height: 40px;
                animation: spin 0.8s linear infinite;
            }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            .status-text { font-size: 14px; font-weight: 600; color: #444; min-height: 28px; }
            .result-box {
                display: none; text-align: left; background: #f8f9fa;
                border: 1px solid #e9ecef; padding: 14px; border-radius: 12px;
                margin-top: 18px; font-size: 12px;
            }
            .result-box textarea {
                width: 100%; height: 90px; margin-top: 6px; font-family: monospace;
                font-size: 11px; padding: 8px; border: 1px solid #ccc; border-radius: 6px; resize: none;
            }
        </style>
    </head>
    <body>
        <div class="card">
            <h2>Zalo QR Login</h2>
            <div class="badge">📱 Thiết bị: iPhone 18 Pro Max (iOS 18)</div>
            <p class="desc">Mở Zalo trên điện thoại để quét mã định danh</p>

            <div class="qr-wrapper" id="qrContainer">
                <div class="spinner" id="spinner"></div>
                <img id="qrImg" style="display: none;" alt="QR Code">
            </div>

            <div class="status-text" id="statusText">Đang khởi tạo thiết bị Apple...</div>

            <div class="result-box" id="resultBox">
                <b>✅ Đăng nhập thành công!</b><br>
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
                        document.getElementById('statusText').innerText = 'Đang khởi tạo iPhone 18 Pro Max...';
                        document.getElementById('statusText').style.color = '#555';
                        document.getElementById('resultBox').style.display = 'none';
                    } 
                    else if (data.status === 'WAITING' && data.qrUrl) {
                        if (lastSid !== data.id) {
                            lastSid = data.id;
                            document.getElementById('spinner').style.display = 'none';
                            const img = document.getElementById('qrImg');
                            img.src = data.qrUrl + '?t=' + Date.now();
                            img.style.display = 'block';
                            document.getElementById('statusText').innerText = 'Mở Zalo quét mã và bấm Xác nhận';
                            document.getElementById('statusText').style.color = '#0068ff';
                        }
                    } 
                    else if (data.status === 'SUCCESS') {
                        document.getElementById('spinner').style.display = 'none';
                        document.getElementById('qrImg').style.display = 'none';
                        document.getElementById('statusText').innerText = '🎉 Đăng nhập iPhone 18 Pro Max thành công! Đang đổi mã mới...';
                        document.getElementById('statusText').style.color = '#28a745';
                        document.getElementById('resultBox').style.display = 'block';
                        document.getElementById('resCookies').value = JSON.stringify(data.cookies, null, 2);
                    }
                    else if (data.status === 'ERROR') {
                        document.getElementById('spinner').style.display = 'none';
                        document.getElementById('statusText').innerText = 'Lỗi kết nối, đang thử lại...';
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
