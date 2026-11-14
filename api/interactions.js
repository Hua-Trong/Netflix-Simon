import { createPublicKey, verify, randomUUID } from 'node:crypto';
import { waitUntil } from '@vercel/functions';

export const config = { api: { bodyParser: false } };

const API = 'https://discord.com/api/v10';
const EPHEMERAL = 64;
const BUTTON_ID = 'netflix_simon_get_link_v1';
const PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const VAULT = 'netflix-simon:v1.3:links';
const LAST = 'netflix-simon:v1.3:last';
const REPORTS = 'netflix-simon:v1.5:cookie-reports'; // Giữ lại để xem thống kê cũ
const COOKIE_FILE_MAX_BYTES = 128 * 1024;

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

// --- FIXED FOR LOGIN LINKS ---
function validatedUrl(value) {
  if (typeof value !== 'string' || value.length > 4000) throw new Error('URL không hợp lệ hoặc quá dài.');
  let url;
  try { url = new URL(value); } catch { throw new Error('URL không hợp lệ.'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
    throw new Error('Chỉ hỗ trợ liên kết HTTPS thông thường.');
  }
  return url.toString();
}

function redisEnabled() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}
async function redis(...command) {
  if (!redisEnabled()) throw new Error('Chưa cấu hình UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.');
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
    throw new Error('Kho dữ liệu không khả dụng.');
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
    try { result.push({ ...JSON.parse(values[i + 1]), id: values[i] }); } catch { /* skip */ }
  }
  return result;
}

async function inspectAttachment(attachment) {
  if (!attachment || typeof attachment.url !== 'string' || typeof attachment.filename !== 'string')
    throw new Error('Không tìm thấy file đính kèm.');
  if (!/\.txt$/i.test(attachment.filename)) throw new Error('Chỉ nhận file .txt.');
  if (attachment.size > COOKIE_FILE_MAX_BYTES) throw new Error('File quá lớn (tối đa 128 KB).');
  const url = new URL(attachment.url);
  if (url.protocol !== 'https:' || !['cdn.discordapp.com','media.discordapp.net'].includes(url.hostname))
    throw new Error('File phải là attachment của Discord.');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('Không tải được file attachment.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Không đọc được dữ liệu file.');
  const chunks = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > COOKIE_FILE_MAX_BYTES) throw new Error('File vượt quá 128 KB.');
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  
  // Trả về raw text thay vì parsed metadata
  const text = Buffer.concat(chunks.map(v => Buffer.from(v))).toString('utf8');
  return text;
}

// --- NEW NFTOKEN LOGIC ---
function extractRequiredCookies(text, now = Math.floor(Date.now() / 1000)) {
  let netflixId = '', secureNetflixId = '', nfvdid = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) continue;
    const cols = line.split('\t');
    if (cols.length !== 7) continue;
    const [, , , , expiry, name, value] = cols;
    if (Number(expiry) !== 0 && Number(expiry) < now) continue;
    if (name === 'NetflixId') netflixId = value;
    if (name === 'SecureNetflixId') secureNetflixId = value;
    if (name === 'nfvdid') nfvdid = value;
  }
  if (!netflixId || !secureNetflixId || !nfvdid) throw new Error('File txt thiếu NetflixId, SecureNetflixId hoặc nfvdid.');
  return { netflixId, secureNetflixId, nfvdid };
}

async function generateNetflixLoginLink(cookies) {
  const cookieStr = `NetflixId=${cookies.netflixId}; SecureNetflixId=${cookies.secureNetflixId}; nfvdid=${cookies.nfvdid}`;
  const payload = {
    operationName: "CreateAutoLoginToken",
    variables: { scope: "WEB_STREAMING" },
    extensions: { persistedQuery: { version: 102, id: "76e97129-f4b5-41a0-a73c-12e674896849" } }
  };
  const response = await fetch("https://android13.prod.ftl.netflix.com/graphql", {
    method: "POST",
    headers: {
      "User-Agent": "com.netflix.mediaclient/63884 (Linux; U; Android 13; ro; M2007J3SG; Build/TQ1A.230205.001.A2; Cronet/143.0.7445.0)",
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Cookie": cookieStr
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  const token = data?.data?.createAutoLoginToken?.tokenValue || data?.data?.createAutoLoginToken?.token || data?.data?.createAutoLoginToken?.nftoken;
  if (!token) throw new Error(data?.errors?.[0]?.message || "Netflix từ chối cấp token.");
  return `https://www.netflix.com/?nftoken=${token}`;
}

async function saveCookieReport(i) {
  try {
    const attachmentId = String(opt(i, 'file') ?? '');
    const attachment = i.data?.resolved?.attachments?.[attachmentId];
    
    const text = await inspectAttachment(attachment);
    const cookies = extractRequiredCookies(text);
    const loginLink = await generateNetflixLoginLink(cookies);
    
    const id = randomUUID().slice(0, 8);
    const item = { 
      name: clean(attachment.filename, 80), 
      url: loginLink, 
      description: "Auto-login Link (NFToken API)", 
      tier: "Premium" 
    };
    await redis('HSET', VAULT, id, JSON.stringify(item));
    
    await editReply(i, `✅ **Thành công!** Đã lấy NFToken từ **${clean(attachment.filename, 80)}**.\nID: \`${id}\`.\n🔗 Liên kết đã được nạp thẳng vào kho chính để gửi qua DM.`);
  } catch (err) {
    console.error('Lỗi khi tạo NFToken:', err.message);
    await editReply(i, `❌ Lỗi: ${err.message}`);
  }
}

async function cookieReports() {
  const values = await redis('HGETALL', REPORTS);
  if (!values) return [];
  const items = [];
  for (let n = 0; n < values.length; n += 2) {
    try { items.push({id: values[n], ...JSON.parse(values[n + 1])}); } catch { /* skip */ }
  }
  return items;
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
  return {
    title: '🎬 Netflix Simon • Nhận Link', color: 0xe50914,
    description: `**${clean(entry.name, 80)}**\n${clean(entry.description, 300)}\n\n🔗 **Bấm vào Link đăng nhập dưới đây:**\n<${entry.url}>`,
    fields: [
      { name: '📦 Nguồn', value: 'Kho tự động', inline: true },
      { name: '🏷️ Phân loại', value: clean(entry.tier, 60) || 'Premium', inline: true }
    ], footer: { text: 'Netflix Simon v1.6' },
    timestamp: new Date().toISOString()
  };
}
async function sendLink(i) {
  let responseText;
  try {
    const links = await entries();
    if (!links.length) throw new Error('Kho đang trống. Hãy dùng /upload để nạp file txt mới.');
    const selected = await pick(links);
    const dm = await discordFetch('/users/@me/channels', 'POST', { recipient_id: userId(i) });
    await discordFetch(`/channels/${dm.id}/messages`, 'POST', {
      embeds: [embed(selected)], allowed_mentions: { parse: [] }
    });
    responseText = '✅ Đã gửi liên kết đăng nhập vào DM của bạn.';
  } catch (err) {
    console.error('Send link failed:', err.message);
    responseText = err.message.startsWith('Kho đang trống') ? `❌ ${err.message}` : '❌ Không gửi được DM. Vui lòng mở khoá DM từ máy chủ và thử lại.';
  }
  await editReply(i, responseText);
}
async function handleCommand(i) {
  const name = i.data.name;
  if (name === 'panel') return {
    type: 4,
    data: {
      embeds: [{ title: '🎬 Netflix Simon', color: 0xe50914,
        description: '🎁 Nhấn nút để nhận một liên kết đăng nhập tự động qua DM.\n🔒 Chỉ chủ bot có quyền nạp/xóa kho.',
        footer: { text: 'Netflix Simon v1.6' } }],
      components: [{ type: 1, components: [{ type: 2, style: 4,
        label: '🎁 Nhận Link (PC/Phone)', custom_id: BUTTON_ID }] }],
      allowed_mentions: { parse: [] }
    }
  };
  if (!redisEnabled()) return message('❌ Chưa kết nối Upstash Redis.');
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
    return message(`✅ Đã thêm Link thủ công **${title}** với ID \`${id}\`.`);
  }
  if (name === 'remove') {
    const id = String(opt(i, 'id') ?? '').trim();
    if (!/^[a-f0-9]{8}$/.test(id)) return message('❌ ID không hợp lệ. Dùng /list để xem ID.');
    const removedLink = await redis('HDEL', VAULT, id);
    const removedReport = await redis('HDEL', REPORTS, id);
    return message(removedLink || removedReport ? `✅ Đã xóa mục \`${id}\`.` : `❌ Không tìm thấy mục \`${id}\`.`);
  }
  if (name === 'list') {
    const links = await entries();
    const reports = await cookieReports();
    if (!links.length && !reports.length) return message('📭 Kho đang trống. Hãy /upload file mới.');
    const rows = [
      ...links.map(x => `🔗 \`${x.id}\` — **${clean(x.name, 80)}**`),
      ...reports.map(x => `📄 \`${x.id}\` — **${clean(x.name, 80)}** (Lịch sử)`)
    ].slice(0, 30);
    return message(`📦 **${links.length} liên kết, ${reports.length} báo cáo:**\n${rows.join('\n').slice(0, 1700)}${links.length + reports.length > 30 ? '\n…' : ''}`);
  }
  if (name === 'stats') {
    const reports = await cookieReports();
    const totals = reports.reduce((a, r) => {
      a.rows += Number(r.rows) || 0;
      a.valid += Number(r.valid) || 0;
      a.malformed += Number(r.malformed) || 0;
      a.expired += Number(r.expired) || 0;
      return a;
    }, { rows: 0, valid: 0, malformed: 0, expired: 0 });
    return message(`📊 **Thống kê Lịch sử file txt (metadata cũ):**\n` +
      `• Tổng dòng: ${totals.rows}\n• Đúng định dạng: ${totals.valid}\n` +
      `• Sai định dạng: ${totals.malformed}\n• Quá hạn: ${totals.expired}\n`);
  }
  return message('Lệnh không được hỗ trợ.');
}
export default async function handler(req, res) {
  if (req.method === 'GET') return json(res, { status: 'ok', service: 'Netflix Simon interactions', version: '1.6' });
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
  
  if (i.type === 2) {
    const name = i.data?.name;
    if (name !== 'panel') {
      const owner = process.env.DISCORD_OWNER_ID;
      if (!owner) return json(res, message('❌ Chưa cấu hình DISCORD_OWNER_ID.'));
      if (userId(i) !== owner) return json(res, message('🔒 Chỉ chủ bot mới được thao tác lệnh này.'));
    }
    if (name === 'upload') {
      if (!redisEnabled()) return json(res, message('❌ Chưa kết nối Redis.'));
      waitUntil(saveCookieReport(i));
      return json(res, { type: 5, data: { flags: EPHEMERAL } });
    }
    try { return json(res, await handleCommand(i)); }
    catch (err) { console.error('Command error:', err.message); return json(res, message('❌ Không thể truy cập kho dữ liệu. Hãy xem Vercel Logs.')); }
  }
  if (i.type === 3 && i.data?.custom_id === BUTTON_ID) {
    waitUntil(sendLink(i));
    return json(res, { type: 5, data: { flags: EPHEMERAL } });
  }
  return json(res, message('Lệnh hoặc nút không được hỗ trợ.'));
}
