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
    cookies: null,
    error: null
};

// Cấu hình giả lập thiết bị máy tính Apple Safari chuẩn
const APPLE_DESKTOP_DEVICE = {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    isMobile: false,
    hasTouch: false
};

async function runZaloSessionLoop() {
    while (true) {
        const sessionId = crypto.randomUUID().slice(0, 8);
        const qrFileName = `qr_${sessionId}.png`;
        const qrFilePath = path.join(DATA_DIR, qrFileName);

        currentSession.id = sessionId;
        currentSession.status = 'INITIALIZING';
        currentSession.qrPath = `/qr-image/${sessionId}`;
        currentSession.cookies = null;
        currentSession.error = null;

        let browser = null;

        try {
            console.log(`\n========================================`);
            console.log(`[Máy tính - Phiên: ${sessionId}] Khởi chạy trình duyệt mô phỏng...`);

            browser = await chromium.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu'
                ]
            });

            const context = await browser.newContext(APPLE_DESKTOP_DEVICE);
            const page = await context.new_page();

            console.log(`[Phiên: ${sessionId}] Đang mở chat.zalo.me...`);
            await page.goto('https://chat.zalo.me/', { waitUntil: 'networkidle', timeout: 60000 });
            await page.waitForTimeout(4000);

            // Chuyển sang tab quét mã QR nếu cần
            try {
                const qrTab = await page.locator('text=/QR|Quét mã/i').first();
                if (await qrTab.isVisible()) {
                    await qrTab.click();
                    await page.waitForTimeout(2000);
                }
            } catch (e) {}

            // Chụp lại ảnh mã QR từ giao diện thực tế của Zalo
            const qrBox = await page.locator('.qrcode, canvas, img[alt*="QR"], .qr-img').first();
            if (await qrBox.isVisible()) {
                await qrBox.screenshot({ path: qrFilePath });
            } else {
                await page.screenshot({ path: qrFilePath, fullPage: false });
            }

            currentSession.status = 'WAITING';
            console.log(`[Phiên: ${sessionId}] ✅ Đã tạo mã QR máy tính hợp lệ! Đang đợi quét...`);

            // Vòng lặp chờ xác nhận từ điện thoại (Tối đa 2 phút)
            const startTime = Date.now();
            let success = false;

            while (Date.now() - startTime < 120000) {
                await page.waitForTimeout(1500);

                const cookies = await context.cookies();
                const ckMap = {};
                cookies.forEach(c => { ckMap[c.name] = c.value; });

                const currentUrl = page.url();

                // Nhận diện khi bấm xác nhận thành công trên điện thoại
                if (ckMap['zpw_sek'] || (currentUrl.includes('chat.zalo.me') && !currentUrl.includes('login'))) {
                    console.log(`🎉 [Phiên: ${sessionId}] Đăng nhập thành công từ máy tính!`);
                    await page.waitForTimeout(2000);

                    const finalCookies = await context.cookies();
                    const finalCkMap = {};
                    finalCookies.forEach(c => { finalCkMap[c.name] = c.value; });

                    currentSession.status = 'SUCCESS';
                    currentSession.cookies = finalCkMap;
                    success = true;

                    // Tiêu hủy ảnh QR ngay sau khi quét xong
                    if (fs.existsSync(qrFilePath)) {
                        fs.unlinkSync(qrFilePath);
                    }

                    await new Promise(r => setTimeout(r, 4000));
                    break;
                }
            }

            if (!success) {
                console.log(`[Phiên: ${sessionId}] Hết thời gian chờ, đang tạo mã mới...`);
                if (fs.existsSync(qrFilePath)) fs.unlinkSync(qrFilePath);
            }

        } catch (err) {
            console.error(`❌ [Phiên: ${sessionId}] Lỗi:`, err.message);
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

runZaloSessionLoop();

app.get('/qr-image/:sessionId', (req, res) => {
    const filePath = path.join(DATA_DIR, `qr_${req.params.sessionId}.png`);
    if (fs.existsSync(filePath)) {
        res.setHeader('Cache-Control', 'no-store');
        return res.sendFile(filePath);
    }
    res.status(404).send('Mã QR đã dùng hoặc không tồn tại.');
});

app.get('/api/status', (req, res) => {
    res.json({
        id: currentSession.id,
        status: currentSession.status,
        qrUrl: currentSession.qrPath,
        cookies: currentSession.cookies,
        error: currentSession.error
    });
});

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="vi">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Đăng nhập Zalo - Máy tính</title>
        <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body { font-family: -apple-system, sans-serif; background: #f0f2f5; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 16px; }
            .card { background: #fff; width: 100%; max-width: 380px; padding: 30px 20px; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.06); text-align: center; }
            h2 { color: #0068ff; margin-bottom: 6px; font-size: 20px; }
            .badge { display: inline-block; font-size: 11px; background: #eef5ff; color: #0068ff; padding: 4px 10px; border-radius: 20px; margin-bottom: 15px; font-weight: 600; }
            p.desc { font-size: 13px; color: #666; margin-bottom: 16px; }
            .qr-wrapper { width: 250px; height: 250px; margin: 0 auto 16px; border: 1px solid #e1e4ea; border-radius: 12px; display: flex; align-items: center; justify-content: center; background: #fafafa; position: relative; overflow: hidden; }
            .qr-wrapper img { width: 100%; height: 100%; object-fit: contain; }
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
            <div class="badge">💻 Phiên bản Máy tính (Apple Safari)</div>
            <p class="desc">Mở Zalo trên điện thoại để quét mã</p>
            <div class="qr-wrapper" id="qrContainer">
                <div class="spinner" id="spinner"></div>
                <img id="qrImg" style="display: none;" alt="QR Code">
            </div>
            <div class="status-text" id="statusText">Đang khởi tạo trình duyệt...</div>
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
                        document.getElementById('statusText').innerText = 'Đang tạo mã QR...';
                        document.getElementById('resultBox').style.display = 'none';
                    } else if (data.status === 'WAITING' && data.qrUrl) {
                        if (lastSid !== data.id) {
                            lastSid = data.id;
                            document.getElementById('spinner').style.display = 'none';
                            const img = document.getElementById('qrImg');
                            img.src = data.qrUrl + '?t=' + Date.now();
                            img.style.display = 'block';
                            document.getElementById('statusText').innerText = 'Quét mã → Bấm Đồng ý trên điện thoại';
                            document.getElementById('statusText').style.color = '#0068ff';
                        }
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
