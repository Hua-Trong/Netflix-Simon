
const {
  DISCORD_TOKEN,
  DISCORD_APPLICATION_ID
} = process.env;

if (!DISCORD_TOKEN || !DISCORD_APPLICATION_ID) {
  console.error('Thiếu DISCORD_TOKEN hoặc DISCORD_APPLICATION_ID');
  process.exit(1);
}

const url = `https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/commands`;

const commands = [
  {
    name: 'panel',
    description: 'Tạo bảng điều khiển Netflix Simon',
    type: 1,
    default_member_permissions: '8',
    integration_types: [0],
    contexts: [0]
  }
];

const response = await fetch(url, {
  method: 'PUT',
  headers: {
    Authorization: `Bot ${DISCORD_TOKEN}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(commands)
});

if (!response.ok) {
  console.error(
    'Đăng ký lệnh thất bại:',
    response.status,
    await response.text()
  );
  process.exit(1);
}

console.log('Đăng ký Global Command /panel thành công!');
