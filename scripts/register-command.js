const { DISCORD_TOKEN, DISCORD_APPLICATION_ID } = process.env;
if (!DISCORD_TOKEN || !DISCORD_APPLICATION_ID) {
  console.error('Missing DISCORD_TOKEN or DISCORD_APPLICATION_ID');
  process.exit(1);
}

const commands = [
  {
    name: 'panel', description: 'Tao bang dieu khien Netflix Simon', type: 1,
    default_member_permissions: '8', integration_types: [0], contexts: [0]
  },
  {
    name: 'add', description: 'Them lien ket HTTPS vao kho rieng', type: 1,
    default_member_permissions: '8', integration_types: [0], contexts: [0],
    options: [
      { type: 3, name: 'name', description: 'Ten de nhan biet', required: true, max_length: 80 },
      { type: 3, name: 'url', description: 'Lien ket HTTPS khong chua token', required: true, max_length: 1500 },
      { type: 3, name: 'description', description: 'Ghi chu', required: false, max_length: 300 },
      { type: 3, name: 'tier', description: 'Phan loai', required: false, max_length: 60 }
    ]
  },
  {
    name: 'remove', description: 'Xoa lien ket theo ID trong /list', type: 1,
    default_member_permissions: '8', integration_types: [0], contexts: [0],
    options: [{ type: 3, name: 'id', description: 'ID cua muc can xoa', required: true, max_length: 40 }]
  },
  {
    name: 'list', description: 'Xem cac muc trong kho', type: 1,
    default_member_permissions: '8', integration_types: [0], contexts: [0]
  }
];

const response = await fetch(`https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/commands`, {
  method: 'PUT',
  headers: { Authorization: `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(commands)
});
if (!response.ok) {
  const body = await response.json().catch(() => ({}));
  console.error('Register failed:', response.status, body.code ?? '', body.message ?? '');
  process.exit(1);
}
console.log('Registered /panel, /add, /remove, /list globally.');
