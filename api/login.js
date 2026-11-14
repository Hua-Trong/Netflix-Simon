export default function handler(req, res) {
  // Chỉ nhận request GET
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { token } = req.query;
  if (!token) return res.status(400).send('Thiếu tham số token truy cập.');

  let cookieData;
  try {
    // Giải mã Base64 token thành mảng JSON
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    cookieData = JSON.parse(decoded);
  } catch (e) {
    return res.status(400).send('Token không hợp lệ hoặc đã bị hỏng.');
  }

  // Giao diện trang Landing Page trung chuyển
  const html = `
  <!DOCTYPE html>
  <html lang="vi">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Netflix Simon - Nhận Cookie</title>
    <style>
      body { background-color: #141414; color: white; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; text-align: center; padding: 40px 20px; }
      .container { max-width: 500px; margin: auto; background: #222; padding: 30px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.5); }
      .logo { color: #e50914; font-size: 28px; font-weight: bold; margin-bottom: 20px; }
      .btn { background: #e50914; color: white; border: none; padding: 12px 24px; font-size: 16px; font-weight: bold; border-radius: 6px; cursor: pointer; margin: 10px 5px; transition: 0.2s; }
      .btn:hover { background: #b20710; }
      .btn-secondary { background: #333; }
      .btn-secondary:hover { background: #444; }
      textarea { width: 90%; height: 120px; margin-top: 15px; background: #111; color: #0f0; border: 1px solid #444; padding: 15px; border-radius: 6px; font-family: monospace; resize: none; }
      .status { font-size: 14px; color: #aaa; margin-top: 15px; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="logo">NETFLIX SIMON</div>
      <h3>Dữ liệu đăng nhập đã sẵn sàng!</h3>
      <p class="status"><i>Nếu bạn có sử dụng Extension hệ thống, trình duyệt sẽ tự động cấy Cookie và đăng nhập ngay bây giờ.</i></p>
      
      <!-- Hộp thoại fallback cho người dùng thủ công -->
      <textarea id="cookie-data" readonly>${JSON.stringify(cookieData, null, 2)}</textarea>
      
      <br>
      <button class="btn" onclick="copyCookie()">1. Copy mã Cookie</button>
      <a href="https://www.netflix.com" target="_blank"><button class="btn btn-secondary">2. Mở Netflix</button></a>
    </div>

    <!-- Vùng dữ liệu ẩn để Extension đọc (Tương tự abcxy) -->
    <div id="extension-data" style="display:none;" data-cookie='${JSON.stringify(cookieData)}'></div>

    <script>
      function copyCookie() {
        const copyText = document.getElementById("cookie-data");
        copyText.select();
        document.execCommand("copy");
        alert("Đã Copy thành công! Hãy mở trang Netflix, bật tiện ích Cookie-Editor và nhấn Import.");
      }

      // Phát tín hiệu ra ngoài Window để Extension (nếu có) bắt được và tự động set cookie
      window.postMessage({ 
        type: "NETFLIX_SIMON_INJECT", 
        cookies: JSON.parse(document.getElementById("extension-data").getAttribute("data-cookie")) 
      }, "*");
    </script>
  </body>
  </html>
  `;

  res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8').send(html);
}
