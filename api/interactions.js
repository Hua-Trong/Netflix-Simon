import { createPublicKey, verify } from 'node:crypto';
import { waitUntil } from '@vercel/functions';

// Discord signatures must be checked against the exact raw request body.
export const config = { api: { bodyParser: false } };

const API = 'https://discord.com/api/v10';
const EPHEMERAL = 64;
const BUTTON_ID = 'netflix_simon_get_link_v1';
const ed25519SpkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');

function json(res, body, status = 200) {
  return res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').json(body);
}
function message(content, ephemeral = true) {
  return { type: 4, data: { content, ...(ephemeral ? { flags: EPHEMERAL } : {}) } };
}
function validSignature(body, signature, timestamp) {
  if (!/^[a-f\d]{64}$/i.test(process.env.DISCORD_PUBLIC_KEY || '') || !signature || !timestamp) return false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([ed25519SpkiPrefix, Buffer.from(process.env.DISCORD_PUBLIC_KEY, 'hex')]),
      format: 'der', type: 'spki'
    });
    return verify(null, Buffer.concat([Buffer.from(timestamp), body]), publicKey, Buffer.from(signature, 'hex'));
  } catch { return false; }
}
function getUserId(interaction) {
  return interaction.member?.user?.id ?? interaction.user?.id;
}
function getLinks() {
  let value;
  try { value = JSON.parse(process.env.PERSONAL_LINKS_JSON || '[]'); }
  catch { throw new Error('PERSONAL_LINKS_JSON phải là JSON hợp lệ.'); }
  if (!Array.isArray(value)) throw new Error('PERSONAL_LINKS_JSON phải là mảng.');
  return value.map((x) => typeof x === 'string' ? { name: 'Liên kết cá nhân', url: x } : x)
    .filter((x) => x && typeof x.name === 'string' && typeof x.url === 'string' && /^https:\/\//i.test(x.url));
}
async function discordFetch(path, method, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`Discord API HTTP ${response.status}`);
  return response.json();
}
async function editReply(interaction, content) {
  const response = await fetch(`${API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content })
  });
  if (!response.ok) console.error('Không thể cập nhật phản hồi:', response.status);
}
async function sendLink(interaction) {
  let result;
  try {
    if (!process.env.DISCORD_TOKEN) throw new Error('Chưa cấu hình DISCORD_TOKEN.');
    const links = getLinks();
    if (!links.length) throw new Error('Chưa có liên kết nào trong PERSONAL_LINKS_JSON.');
    const choice = links[Math.floor(Math.random() * links.length)];
    const channel = await discordFetch('/users/@me/channels', 'POST', { recipient_id: getUserId(interaction) });
    await discordFetch(`/channels/${channel.id}/messages`, 'POST', {
      embeds: [{
        title: '🎬 Netflix Simon — Liên kết cá nhân',
        description: `**${choice.name.slice(0, 100)}**\n${choice.url}`,
        color: 0xe50914,
        footer: { text: 'Chỉ dùng liên kết bạn sở hữu và được phép chia sẻ.' }
      }],
      allowed_mentions: { parse: [] }
    });
    result = '✅ Đã gửi một liên kết vào DM của bạn.';
  } catch (error) {
    console.error('Send DM failed:', error.message);
    result = '❌ Không gửi được DM hoặc cấu hình chưa đúng. Hãy kiểm tra quyền nhận DM và biến môi trường.';
  }
  await editReply(interaction, result);
}

// Vercel Node.js Functions use an exported (req, res) handler.
export default async function handler(req, res) {
  if (req.method === 'GET') return json(res, { status: 'ok', service: 'Netflix Simon interactions', version: '1.1' });
  if (req.method !== 'POST') return json(res, { error: 'Method not allowed' }, 405);

  let body;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    body = Buffer.concat(chunks);
  } catch {
    return json(res, { error: 'Cannot read request body' }, 400);
  }
  if (!validSignature(body, req.headers['x-signature-ed25519'], req.headers['x-signature-timestamp'])) {
    return json(res, { error: 'Invalid request signature' }, 401);
  }
  let interaction;
  try { interaction = JSON.parse(body.toString('utf8')); }
  catch { return json(res, { error: 'Invalid JSON' }, 400); }

  if (interaction.type === 1) return json(res, { type: 1 });
  const owner = process.env.DISCORD_OWNER_ID;
  if (!owner) return json(res, message('❌ Chưa cấu hình DISCORD_OWNER_ID.'));
  if (getUserId(interaction) !== owner) return json(res, message('🔒 Bot này chỉ dành cho chủ sở hữu.'));

  if (interaction.type === 2 && interaction.data?.name === 'panel') {
    return json(res, {
      type: 4,
      data: {
        embeds: [{
          title: '🎬 Netflix Simon',
          description: 'Nhấn nút dưới đây để nhận một liên kết cá nhân qua DM.',
          color: 0xe50914
        }],
        components: [{
          type: 1,
          components: [{ type: 2, style: 4, label: '🎁 Netflix Free (PC/Phone)', custom_id: BUTTON_ID }]
        }],
        allowed_mentions: { parse: [] }
      }
    });
  }
  if (interaction.type === 3 && interaction.data?.custom_id === BUTTON_ID) {
    waitUntil(sendLink(interaction));
    return json(res, { type: 5, data: { flags: EPHEMERAL } });
  }
  return json(res, message('Lệnh hoặc nút không được hỗ trợ.'));
}
