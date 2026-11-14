const {DISCORD_TOKEN, DISCORD_APPLICATION_ID, DISCORD_GUILD_ID} = process.env;
if (![DISCORD_TOKEN, DISCORD_APPLICATION_ID, DISCORD_GUILD_ID].every(Boolean)) {
  console.error('Thiếu DISCORD_TOKEN, DISCORD_APPLICATION_ID hoặc DISCORD_GUILD_ID trong môi trường.');
  process.exit(1);
}
const url = `https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/guilds/${DISCORD_GUILD_ID}/commands`;
const response = await fetch(url, {
  method: 'POST',
  headers: {Authorization:`Bot ${DISCORD_TOKEN}`, 'Content-Type':'application/json'},
  body:JSON.stringify({name:'panel', description:'Tạo bảng điều khiển Netflix Simon', type:1})
});
if (!response.ok) {
  console.error('Không tạo được lệnh /panel:', response.status, await response.text());
  process.exit(1);
}
console.log('Đăng ký lệnh /panel thành công.');
