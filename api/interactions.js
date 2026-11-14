import { createPublicKey, verify, randomUUID } from 'node:crypto';
import { waitUntil } from '@vercel/functions';

export const config = { api: { bodyParser: false } };

const API = 'https://discord.com/api/v10';
const EPHEMERAL = 64;
const BUTTON_ID = 'netflix_simon_get_link_v1'; // Keep existing panels working.
const PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const VAULT = 'netflix-simon:v1.3:links';
const LAST = 'netflix-simon:v1.3:last';
const REPORTS = 'netflix-simon:v1.5:cookie-reports';
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
// Parse only structural cookie metadata. Never store or log cookie values.
function inspectNetscapeCookieText(text, now = Math.floor(Date.now() / 1000)) {
  const report = { format: 'Netscape HTTP Cookie File', rows: 0, valid: 0, malformed: 0,
    expired: 0, netflixDomainRows: 0, sessionCookieNamesPresent: false };
  const sessionNames = new Set(['NetflixId', 'SecureNetflixId', 'gsid']);
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) continue;
    report.rows++;
    const cols = line.split('\t');
    if (cols.length !== 7) { report.malformed++; continue; }
    let [domain, includeSubdomains, path, secure, expiry, name, value] = cols;
    domain = domain.replace(/^#HttpOnly_/, '');
    const valid = /^\.?[a-z0-9.-]+$/i.test(domain) &&
      (includeSubdomains === 'TRUE' || includeSubdomains === 'FALSE') &&
      path.startsWith('/') && (secure === 'TRUE' || secure === 'FALSE') &&
      /^\d{1,12}$/.test(expiry) && name.length > 0 && value.length > 0;
    if (!valid) { report.malformed++; continue; }
    report.valid++;
    if (Number(expiry) !== 0 && Number(expiry) < now) report.expired++;
    if (domain === '.netflix.com' || domain === 'netflix.com') report.netflixDomainRows++;
    if (sessionNames.has(name)) report.sessionCookieNamesPresent = true;
  }
  return report;
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
  const text = Buffer.concat(chunks.map(v => Buffer.from(v))).toString('utf8');
  // Raw content is discarded after parsing; session values never enter Redis or logs.
  return inspectNetscapeCookieText(text);
}
async function saveCookieReport(i) {
  try {
    const attachmentId = String(opt(i, 'file') ?? '');
    const attachment = i.data?.resolved?.attachments?.[attachmentId];
    const report = await inspectAttachment(attachment);
    const id = randomUUID().slice(0, 8);
    const item = { name: clean(attachment.filename, 80), checkedAt: new Date().toISOString(), ...report };
    await redis('HSET', REPORTS, id, JSON.stringify(item));
    await editReply(i, `✅ Đã phân tích cấu trúc file **${clean(attachment.filename, 80)}**. ID: \`${id}\`.\n` +
      `• Tổng dòng: ${report.rows}; đúng định dạng: ${report.valid}; sai định dạng: ${report.malformed}; hết hạn theo timestamp: ${report.expired}.\n` +
      '🔒 Không lưu giá trị cookie, không đăng nhập hay kiểm tra LIVE/DEAD. Dùng /stats để xem thống kê.');
  } catch (err) {
    console.error('Cookie metadata inspection failed:', err.message);
    await editReply(i, `❌ ${['File quá lớn (tối đa 128 KB).','File vượt quá 128 KB.','Chỉ nhận file .txt.',
      'Không tìm thấy file đính kèm.','File phải là attachment của Discord.','Không tải được file attachment.',
      'Không đọc được dữ liệu file.'].includes(err.message) ? err.message : 'Không phân tích được file hoặc Redis chưa sẵn sàng.'}`);
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
  // Angle brackets prevent link-preview unfurling in Discord.
  return {
    title: '🎬 Netflix Simon • Kho liên kết', color: 0xe50914,
    description: `**${clean(entry.name, 80)}**\n${clean(entry.description, 300)}\n\n🔗 **Liên kết:**\n<${entry.url}>`,
    fields: [
      { name: '📦 Nguồn', value: 'Kho cá nhân', inline: true },
      { name: '🏷️ Phân loại', value: clean(entry.tier, 60) || 'Mặc định', inline: true }
    ], footer: { text: 'Liên kết thuộc quyền quản lý của bạn • Netflix Simon v1.5' },
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
        description: '🎁 Nhấn nút để nhận một liên kết được phép chia sẻ qua DM.\n🔒 Chỉ chủ bot có quyền quản lý kho.',
        footer: { text: 'Netflix Simon v1.5' } }],
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
    const removedLink = await redis('HDEL', VAULT, id);
    const removedReport = await redis('HDEL', REPORTS, id);
    return message(removedLink || removedReport ? `✅ Đã xóa mục \`${id}\`.` : `❌ Không tìm thấy mục \`${id}\`.`);
  }
  if (name === 'list') {
    const links = await entries();
    const reports = await cookieReports();
    if (!links.length && !reports.length) return message('📭 Kho đang trống. Dùng /add hoặc /upload.');
    const rows = [
      ...links.map(x => `🔗 \`${x.id}\` — **${clean(x.name, 80)}**`),
      ...reports.map(x => `📄 \`${x.id}\` — **${clean(x.name, 80)}** (chỉ metadata)`)
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
    return message(`📊 **Thống kê ${reports.length} file (metadata):**\n` +
      `• Tổng dòng: ${totals.rows}\n• Đúng định dạng: ${totals.valid}\n` +
      `• Sai định dạng: ${totals.malformed}\n• Đã quá hạn theo timestamp khi kiểm tra: ${totals.expired}\n` +
      'Không xác minh cookie đang đăng nhập được (LIVE/DEAD).');
  }
  return message('Lệnh không được hỗ trợ.');
}
export default async function handler(req, res) {
  if (req.method === 'GET') return json(res, { status: 'ok', service: 'Netflix Simon interactions', version: '1.5' });
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
  // Everyone can use /panel and the public link button.
  // Management commands are verified server-side, not merely hidden in Discord UI.
  if (i.type === 2) {
    const name = i.data?.name;
    if (name !== 'panel') {
      const owner = process.env.DISCORD_OWNER_ID;
      if (!owner) return json(res, message('❌ Chưa cấu hình DISCORD_OWNER_ID.'));
      if (userId(i) !== owner) return json(res, message('🔒 Chỉ chủ bot mới được quản lý kho liên kết.'));
    }
    if (name === 'upload') {
      if (!redisEnabled()) return json(res, message('❌ Chưa kết nối Redis.'));
      waitUntil(saveCookieReport(i));
      return json(res, { type: 5, data: { flags: EPHEMERAL } });
    }
    try { return json(res, await handleCommand(i)); }
    catch (err) { console.error('Command error:', err.message); return json(res, message('❌ Không thể truy cập kho dữ liệu. Kiểm tra Vercel Logs.')); }
  }
  if (i.type === 3 && i.data?.custom_id === BUTTON_ID) {
    waitUntil(sendLink(i));
    return json(res, { type: 5, data: { flags: EPHEMERAL } });
  }
  return json(res, message('Lệnh hoặc nút không được hỗ trợ.'));
}
