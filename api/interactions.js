import { createPublicKey, verify, randomUUID } from 'node:crypto';
import { waitUntil } from '@vercel/functions';

export const config = { api: { bodyParser: false } };

const API = 'https://discord.com/api/v10';
const EPHEMERAL = 64;
const BUTTON_ID = 'netflix_simon_get_link_v1'; // Keep existing panels working.
const PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const VAULT = 'netflix-simon:v1.3:links';
const LAST = 'netflix-simon:v1.3:last';

function json(res, body, status = 200) {
  return res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').json(body);
}
function message(content, ephemeral = true) {
  return { type: 4, data: { content, ...(ephemeral ? { flags: EPHEMERAL } : {}), allowed_mentions: { parse: [] } } };
}
function validSignature(raw, signature, timestamp) {
  const hex = process.env.DISCORD_PUBLIC_KEY ?? '';
  if (!/^[a-f\d]{64}$/i.test(hex) || !/^[a-f\d]{128}$/i.test(signature ?? '') || !timestamp) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([PREFIX, Buffer.from(hex, 'hex')]), format: 'der', type: 'spki'
    });
    return verify(null, Buffer.concat([Buffer.from(timestamp), raw]), key, Buffer.from(signature, 'hex'));
  } catch { return false; }
}
function userId(i) { return i.member?.user?.id ?? i.user?.id; }
function clean(value, max) {
  return String(value ?? '').replace(/[\r\n\t]/g, ' ').replace(/@/g, '@\u200b')
    .replace(/[\[\]`*_~|>]/g, '').trim().slice(0, max);
}
function opt(i, name) { return i.data?.options?.find(o => o.name === name)?.value; }
function validatedUrl(value) {
  if (typeof value !== 'string' || value.length > 1500) throw new Error('URL khong hop le.');
  let url;
  try { url = new URL(value); } catch { throw new Error('URL khong hop le.'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
    throw new Error('Chi ho tro lien ket HTTPS thong thuong.');
  }
  // Avoid accidentally storing login/session capabilities in the shared vault.
  const sensitive = /(?:token|cookie|session|auth(?:orization)?|ticket|access_key|refresh|password|passwd|key)/i;
  if ([...url.searchParams.keys()].some(k => sensitive.test(k)) || url.hash) {
    throw new Error('Khong luu URL co token, tham so phien dang nhap hoac fragment.');
  }
  return url.toString();
}
function redisEnabled() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}
async function redis(...command) {
  if (!redisEnabled()) throw new Error('Chua cau hinh UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.');
  const response = await fetch(process.env.UPSTASH_REDIS_REST_URL.replace(/\/$/, ''), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    console.error('Redis command failed:', command[0], response.status);
    throw new Error('Kho du lieu khong kha dung.');
  }
  return data.result;
}
function legacyLinks() {
  let parsed;
  try { parsed = JSON.parse(process.env.PERSONAL_LINKS_JSON || '[]'); }
  catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry, index) => {
    try {
      const value = typeof entry === 'string' ? { name: 'Liên kết cá nhân', url: entry } : entry;
      if (!value || typeof value.name !== 'string') return [];
      return [{ id: `old-${index + 1}`, name: clean(value.name, 80),
        url: validatedUrl(value.url), description: clean(value.description, 300), tier: clean(value.tier, 60) }];
    } catch { return []; }
  });
}
async function entries() {
  if (!redisEnabled()) return legacyLinks();
  const values = await redis('HGETALL', VAULT);
  if (!values) return [];
  const result = [];
  for (let i = 0; i < values.length; i += 2) {
    try { result.push({ ...JSON.parse(values[i + 1]), id: values[i] }); } catch { /* skip corrupt row */ }
  }
  return result;
}
async function pick(links) {
  if (!redisEnabled() || links.length < 2) return links[Math.floor(Math.random() * links.length)];
  const last = await redis('GET', LAST);
  const candidates = links.filter(x => x.id !== last);
  const selected = (candidates.length ? candidates : links)[Math.floor(Math.random() * (candidates.length || links.length))];
  await redis('SET', LAST, selected.id);
  return selected;
}
async function discordFetch(path, method, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('Discord API error:', {
      operation: path === '/users/@me/channels' ? 'CREATE_DM' : path.endsWith('/messages') ? 'SEND_MESSAGE' : 'OTHER',
      status: response.status, code: data.code ?? null, message: data.message ?? 'Unknown'
    });
    throw new Error('Discord API rejected request');
  }
  return data;
}
async function editReply(i, content) {
  const response = await fetch(`${API}/webhooks/${i.application_id}/${i.token}/messages/@original`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } })
  });
  if (!response.ok) console.error('Cannot update deferred reply:', response.status);
}
function embed(entry) {
  // Angle brackets prevent link-preview unfurling in Discord.
  return {
    title: '🎬 Netflix Simon • Kho liên kết', color: 0xe50914,
    description: `**${clean(entry.name, 80)}**\n${clean(entry.description, 300)}\n\n🔗 **Liên kết:**\n<${entry.url}>`,
    fields: [
      { name: '📦 Nguồn', value: 'Kho cá nhân', inline: true },
      { name: '🏷️ Phân loại', value: clean(entry.tier, 60) || 'Mặc định', inline: true }
    ], footer: { text: 'Liên kết thuộc quyền quản lý của bạn • Netflix Simon v1.3' },
    timestamp: new Date().toISOString()
  };
}
async function sendLink(i) {
  let responseText;
  try {
    const links = await entries();
    if (!links.length) throw new Error('Kho đang trống. Hãy dùng /add để thêm liên kết.');
    const selected = await pick(links);
    const dm = await discordFetch('/users/@me/channels', 'POST', { recipient_id: userId(i) });
    await discordFetch(`/channels/${dm.id}/messages`, 'POST', {
      embeds: [embed(selected)], allowed_mentions: { parse: [] }
    });
    responseText = '✅ Đã gửi liên kết vào DM của bạn.';
  } catch (err) {
    console.error('Send link failed:', err.message);
    responseText = err.message.startsWith('Kho đang trống') ? `❌ ${err.message}` : '❌ Không gửi được DM. Kiểm tra cấu hình và Vercel Logs.';
  }
  await editReply(i, responseText);
}
async function handleCommand(i) {
  const name = i.data.name;
  if (name === 'panel') return {
    type: 4,
    data: {
      embeds: [{ title: '🎬 Netflix Simon', color: 0xe50914,
        description: '🎁 Nhấn nút để nhận một liên kết cá nhân qua DM.\n🔒 Chỉ dành cho chủ sở hữu.',
        footer: { text: 'Netflix Simon v1.3' } }],
      components: [{ type: 1, components: [{ type: 2, style: 4,
        label: '🎁 Netflix Free (PC/Phone)', custom_id: BUTTON_ID }] }],
      allowed_mentions: { parse: [] }
    }
  };
  if (!redisEnabled()) return message('❌ Chưa kết nối Upstash Redis. /add, /remove và /list cần Redis.');
  if (name === 'add') {
    const title = clean(opt(i, 'name'), 80);
    if (!title) return message('❌ Tên không được trống.');
    let url;
    try { url = validatedUrl(opt(i, 'url')); }
    catch (err) { return message(`❌ ${err.message}`); }
    const item = { name: title, url,
      description: clean(opt(i, 'description'), 300), tier: clean(opt(i, 'tier'), 60) };
    const id = randomUUID().slice(0, 8);
    await redis('HSET', VAULT, id, JSON.stringify(item));
    return message(`✅ Đã thêm **${title}** với ID \`${id}\`. Dùng /list để xem kho.`);
  }
  if (name === 'remove') {
    const id = String(opt(i, 'id') ?? '').trim();
    if (!/^[a-f0-9]{8}$/.test(id)) return message('❌ ID không hợp lệ. Dùng /list để xem ID.');
    const removed = await redis('HDEL', VAULT, id);
    return message(removed ? `✅ Đã xóa mục \`${id}\`.` : `❌ Không tìm thấy mục \`${id}\`.`);
  }
  if (name === 'list') {
    const links = await entries();
    if (!links.length) return message('📭 Kho đang trống. Dùng /add để thêm liên kết.');
    const rows = links.slice(0, 30).map(x => `• \`${x.id}\` — **${clean(x.name, 80)}** (${clean(x.tier, 40) || 'Mặc định'})`);
    return message(`📦 **Kho có ${links.length} mục:**\n${rows.join('\n').slice(0, 1700)}${links.length > 30 ? '\n… và các mục khác' : ''}`);
  }
  return message('Lệnh không được hỗ trợ.');
}
export default async function handler(req, res) {
  if (req.method === 'GET') return json(res, { status: 'ok', service: 'Netflix Simon interactions', version: '1.3' });
  if (req.method !== 'POST') return json(res, { error: 'Method not allowed' }, 405);
  let raw;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    raw = Buffer.concat(chunks);
  } catch { return json(res, { error: 'Cannot read request body' }, 400); }
  if (!validSignature(raw, req.headers['x-signature-ed25519'], req.headers['x-signature-timestamp'])) {
    return json(res, { error: 'Invalid request signature' }, 401);
  }
  let i;
  try { i = JSON.parse(raw.toString('utf8')); }
  catch { return json(res, { error: 'Invalid JSON' }, 400); }
  if (i.type === 1) return json(res, { type: 1 });
  const owner = process.env.DISCORD_OWNER_ID;
  if (!owner) return json(res, message('❌ Chưa cấu hình DISCORD_OWNER_ID.'));
  if (userId(i) !== owner) return json(res, message('🔒 Bot này chỉ dành cho chủ sở hữu.'));
  if (i.type === 2) {
    try { return json(res, await handleCommand(i)); }
    catch (err) { console.error('Command error:', err.message); return json(res, message('❌ Không thể truy cập kho dữ liệu. Kiểm tra Vercel Logs.')); }
  }
  if (i.type === 3 && i.data?.custom_id === BUTTON_ID) {
    waitUntil(sendLink(i));
    return json(res, { type: 5, data: { flags: EPHEMERAL } });
  }
  return json(res, message('Lệnh hoặc nút không được hỗ trợ.'));
}
