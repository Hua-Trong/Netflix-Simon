# Netflix Simon — Discord Button Bot on Vercel

Bot cá nhân, dùng **Discord HTTP Interactions** (không dùng Gateway). Có `/panel`, button, DM và lựa chọn ngẫu nhiên từ danh sách liên kết **bạn sở hữu/được phép chia sẻ**.

## 1. Cài Discord

- Discord Developer Portal → chọn app Netflix Simon → **Bot** → lấy Bot Token (không chia sẻ).
- **General Information** → copy Application ID và Public Key.
- **Installation** → Guild Install, chọn scopes `bot` và `applications.commands`; quyền `View Channels`, `Send Messages`, `Embed Links`.
- Thêm app vào server Discord cá nhân của bạn.
- Discord Settings → Advanced → bật Developer Mode → Copy User ID của bạn và Server ID.

## 2. Deploy Vercel

1. Tải toàn bộ thư mục này lên GitHub repo **private** (đừng commit file `.env` hay token).
2. Vercel → Add New → Project → Import repo → Framework Preset: **Other** → Deploy.
3. Vercel → Project → Settings → Environment Variables, thêm:
   - `DISCORD_TOKEN`: bot token;
   - `DISCORD_PUBLIC_KEY`: public key từ General Information;
   - `DISCORD_APPLICATION_ID`: application ID;
   - `DISCORD_OWNER_ID`: Discord User ID của bạn;
   - `PERSONAL_LINKS_JSON`: mảng JSON các liên kết HTTPS được phép chia sẻ. Ví dụ: `[{"name":"Netflix website","url":"https://www.netflix.com/"}]`.
   - `DISCORD_GUILD_ID`: Server ID (dùng cho script đăng ký slash command, không bắt buộc tại runtime).
4. **Redeploy** production sau khi đặt biến môi trường.
5. Mở `https://TEN-DU-AN.vercel.app/api/interactions` trên trình duyệt. Phải thấy `status: ok`.
6. Discord Developer Portal → General Information → **Interactions Endpoint URL** = `https://TEN-DU-AN.vercel.app/api/interactions` → Save Changes. Discord sẽ kiểm tra chữ ký và ping.

## 3. Đăng ký /panel (một lần trên máy Windows)

- Cài Node.js 20+ nếu chưa có.
- Tại thư mục project, mở PowerShell rồi chạy:

```powershell
$env:DISCORD_TOKEN="TOKEN_CUA_BAN"
$env:DISCORD_APPLICATION_ID="APPLICATION_ID"
$env:DISCORD_GUILD_ID="SERVER_ID"
node scripts/register-command.js
```

**Đừng đăng ảnh hoặc gửi token cho ai.** Các biến PowerShell chỉ áp dụng cho terminal hiện tại. Bạn có thể xóa chúng sau khi chạy:

```powershell
Remove-Item Env:DISCORD_TOKEN,Env:DISCORD_APPLICATION_ID,Env:DISCORD_GUILD_ID
```

- Trong kênh Discord, nhập `/panel` rồi Enter. Bảng điều khiển xuất hiện.
- Nhấn nút `Netflix Free (PC/Phone)` bằng tài khoản chủ; bot gửi một liên kết cá nhân qua DM.

## Lưu ý

- Không bỏ mật khẩu, cookie Netflix, session token, link đăng nhập chứa bí mật hoặc thông tin thanh toán vào `PERSONAL_LINKS_JSON`.
- Không có kho account hoặc cơ chế đăng nhập Netflix; đây là bản nền an toàn để bạn triển khai và thử hành vi của bot.
- Nếu DM bị đóng, bot sẽ báo lỗi ở phản hồi riêng tư. Cần bật nhận DM từ thành viên server hoặc mở DM với bot.
- Vercel dùng function, không giữ trạng thái RAM sau các request; muốn có vòng quay account và hạn mức cần thêm database.
