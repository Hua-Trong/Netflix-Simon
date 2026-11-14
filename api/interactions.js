import { createPublicKey, verify } from 'node:crypto';
import { waitUntil } from '@vercel/functions';

export const config = { api: { bodyParser: false } };

const API = 'https://discord.com/api/v10';
const EPHEMERAL = 64;
const BUTTON_ID = 'netflix_simon_get_link_v1';
const ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function json(res, body, status = 200) {
  return res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').json(body);
}
function message(content, ephemeral = true) {
  return { type: 4, data: { content, ...(ephemeral ? { flags: EPHEMERAL } : {}) } };
}
function validSignature(body, signature, timestamp) {
  const keyHex = process.env.DISCORD_PUBLIC_KEY || '';
  if (!/^[0-9a-f]{64}$/i.test(keyHex) || !signature || !timestamp) return false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_PREFIX, Buffer.from(keyHex, 'hex')]),
      format: 'der',
      type: 'spki'
    });
    return verify(
      null,
      Buffer.concat([Buffer.from(timestamp), body]),
      publicKey,
      Buffer.from(signature, 'hex')
    );
  } catch {
    return false;
  }
}
function getUserId(interaction) {
  return interaction.member?.user?.id ?? interaction.user?.id;
}
function getLinks() {
  let raw;
  try {
    raw = JSON.parse(process.env.PERSONAL_LINKS_JSON || '[]');
  } catch {
    throw new Error('PERSONAL_LINKS_JSON is not valid JSON');
  }
  if (!Array.isArray(raw)) throw new Error('PERSONAL_LINKS_JSON must be an array');

  return raw.map((entry) => typeof entry === 'string'
    ? { name: 'Liên kết cá nhân', url: entry }
    : entry
  ).filter((entry) => {
    if (!entry || typeof entry.name !== 'string' || typeof entry.url !== 'string') return false;
    try {
      const url = new URL(entry.url);
      return url.protocol === 'https:' && Boolean(url.hostname);
    } catch {
      return false;
    }
  });
}
function safeText(value, limit) {
  if (typeof value !== 'string') return '';
  // Prevent mass mentions, Markdown link-label injection and excessive embed size.
  return value.replace(/@/g, '@\u200b').replace(/[\[\]]/g, '').slice(0, limit);
}
async function discordFetch(path, method, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
      'Content-Type': 'application/json'
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('Discord API Error:', {
      operation: path === '/users/@me/channels' ? 'CREATE_DM' : path.endsWith('/messages') ? 'SEND_MESSAGE' : 'OTHER',
      status: response.status,
      code: data.code ?? null,
      message: data.message ?? 'Unknown error'
    });
    throw new Error(`Discord API ${response.status} - ${data.code ?? 'unknown'}`);
  }
  return data;
}
async function editReply(interaction, content) {
  const response = await fetch(`${API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  });
  if (!response.ok) console.error('Failed to update interaction response:', response.status);
}
function makeEmbed(item) {
  const name = safeText(item.name, 150) || 'Liên kết cá nhân';
  const tier = safeText(item.tier, 100);
  const description = safeText(item.description, 700);
  return {
    title: '🎬 Netflix Simon • Kho liên kết',
    color: 0xe50914,
    description: [
      `**${name}**`,
      description,
      '',
      '🔗 **Liên kết:**',
      item.url
    ].filter((line) => line !== undefined).join('\n').slice(0, 4000),
    fields: [
      { name: '📦 Nguồn', value: 'Kho cá nhân', inline: true },
      { name: '🏷️ Phân loại', value: tier || 'Mặc định', inline: true }
    ],
    footer: { text: 'Chỉ chia sẻ liên kết thuộc quyền quản lý của bạn • Netflix Simon v1.2' },
    timestamp: new Date().toISOString()
  };
}
async function sendLink(interaction) {
  let result;
  try {
    if (!process.env.DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is missing');
    const links = getLinks();
    if (!links.length) throw new Error('PERSONAL_LINKS_JSON has no valid HTTPS links');
    const selected = links[Math.floor(Math.random() * links.length)];
    const channel = await discordFetch('/users/@me/channels', 'POST', {
      recipient_id: getUserId(interaction)
    });
    await discordFetch(`/channels/${channel.id}/messages`, 'POST', {
      embeds: [makeEmbed(selected)],
      allowed_mentions: { parse: [] }
    });
    result = '✅ Đã gửi một liên kết từ kho cá nhân vào DM của bạn.';
  } catch (error) {
    console.error('Send DM failed:', error.message);
    result = '❌ Không thể gửi DM. Kiểm tra cấu hình và Vercel Logs.';
  }
  await editReply(interaction, result);
}

export default async function handler(req, res) {
  if (req.method === 'GET') return json(res, {
    status: 'ok', service: 'Netflix Simon interactions', version: '1.2'
  });
  if (req.method !== 'POST') return json(res, { error: 'Method not allowed' }, 405);

  let rawBody;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    rawBody = Buffer.concat(chunks);
  } catch {
    return json(res, { error: 'Cannot read request body' }, 400);
  }
  if (!validSignature(rawBody, req.headers['x-signature-ed25519'], req.headers['x-signature-timestamp'])) {
    return json(res, { error: 'Invalid request signature' }, 401);
  }
  let interaction;
  try {
    interaction = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return json(res, { error: 'Invalid JSON' }, 400);
  }
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
          description: '🎁 Nhấn nút để nhận ngẫu nhiên một liên kết trong kho cá nhân qua DM.\n🔒 Chỉ dành cho chủ sở hữu.',
          color: 0xe50914,
          footer: { text: 'Netflix Simon v1.2' }
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
