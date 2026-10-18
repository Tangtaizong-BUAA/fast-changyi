import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { join, normalize, extname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createHmac,
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import OSS from 'ali-oss';
import { downloadLifetime } from './download-grant.mjs';
import { streamDownload } from './native-download.mjs';

let nativeDownloads = 0;

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(rootDir, 'public');

const ossRegion = process.env.OSS_REGION || 'oss-cn-beijing';

const cfg = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 8810),
  dataDir: process.env.DATA_DIR || join(rootDir, 'data'),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || 'http://127.0.0.1:8810/transfer').replace(/\/$/, ''),
  region: ossRegion,
  bucket: process.env.OSS_BUCKET || '',
  externalEndpoint: process.env.OSS_EXTERNAL_ENDPOINT || `https://${ossRegion}.aliyuncs.com`,
  internalEndpoint: process.env.OSS_INTERNAL_ENDPOINT || `https://${ossRegion}-internal.aliyuncs.com`,
  stsEndpoint: process.env.STS_ENDPOINT || `https://sts.${ossRegion.replace(/^oss-/, '')}.aliyuncs.com`,
  roleArn: process.env.STS_ROLE_ARN || '',
  maxFileBytes: Number(process.env.MAX_FILE_BYTES || 2_199_023_255_552),
  accessCodeHash: process.env.TRANSFER_ACCESS_CODE_HASH || '',
  shareSecret: process.env.SHARE_SECRET || 'local-development-share-secret-change-me',
};

if (process.env.NODE_ENV === 'production') {
  const invalid = [];
  if (!cfg.publicBaseUrl.startsWith('https://')) invalid.push('PUBLIC_BASE_URL');
  if (!cfg.roleArn || /<|>/.test(cfg.roleArn)) invalid.push('STS_ROLE_ARN');
  if (!cfg.bucket || cfg.bucket === 'your-oss-bucket') invalid.push('OSS_BUCKET');
  if (cfg.shareSecret === 'local-development-share-secret-change-me' || cfg.shareSecret.length < 32) invalid.push('SHARE_SECRET');
  if (invalid.length) throw new Error(`PRODUCTION_CONFIG_INVALID:${invalid.join(',')}`);
}

const teamSessions = new Map();
const loginFailures = new Map();
const publicRateBuckets = new Map();
let cachedServerCredentials = null;

await mkdir(cfg.dataDir, { recursive: true });
const db = new DatabaseSync(join(cfg.dataDir, 'transfer.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    object_key TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    etag TEXT,
    crc64 TEXT,
    status TEXT NOT NULL,
    share_token_hash TEXT NOT NULL UNIQUE,
    pickup_code_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    completed_at INTEGER,
    expires_at INTEGER,
    deleted_at INTEGER,
    delete_attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS files_recent_idx ON files(status, expires_at, completed_at);
  CREATE TABLE IF NOT EXISTS upload_sessions (
    id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL UNIQUE,
    oss_upload_id TEXT,
    expected_size INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    status TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    file_id TEXT,
    ip_hash TEXT,
    user_agent TEXT,
    created_at INTEGER NOT NULL
  );
`);

const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function now() {
  return Date.now();
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function hmacHex(value) {
  return createHmac('sha256', cfg.shareSecret).update(value).digest('hex');
}

function makeShareToken(fileId) {
  return base64url(createHmac('sha256', cfg.shareSecret).update(`share:${fileId}`).digest());
}

function makePickupCode() {
  const bytes = randomBytes(8);
  let code = '';
  for (const byte of bytes) code += alphabet[byte % alphabet.length];
  return formatPickupCode(code);
}

function normalizePickupCode(value) {
  return String(value || '').replace(/[\s-]/g, '').toUpperCase();
}

function formatPickupCode(value) {
  const code = normalizePickupCode(value);
  return `${code.slice(0, 4)}-${code.slice(4, 8)}`;
}

function pickupHash(value) {
  return hmacHex(`pickup:${normalizePickupCode(value)}`);
}

function shareHash(value) {
  return hmacHex(`share-token:${value}`);
}

function safeFileName(value) {
  const cleaned = String(value || '未命名文件').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  // Slice by Unicode code points and drop lone surrogates, so later
  // encodeURIComponent calls can never throw (URIError) on a split pair.
  const points = Array.from(cleaned).filter(point => {
    const code = point.codePointAt(0);
    return code < 0xD800 || code > 0xDFFF;
  });
  return points.slice(0, 240).join('') || '未命名文件';
}

function safeContentType(value) {
  const type = String(value || 'application/octet-stream').split(';', 1)[0].trim();
  return /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : 'application/octet-stream';
}

function isLoopbackIp(value) {
  const ip = String(value || '').trim();
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// Identity and rate-limit keys must not be spoofable: the x-real-ip header is
// only trusted when the TCP connection itself comes from our own loopback
// proxy. A direct client cannot fake its socket address.
function getClientIp(req) {
  const socketIp = String(req.socket.remoteAddress || '');
  if (isLoopbackIp(socketIp)) {
    const forwarded = String(req.headers['x-real-ip'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return socketIp || 'unknown';
}

function hashIp(ip) {
  return createHash('sha256').update(`${cfg.shareSecret}:ip:${ip}`).digest('hex').slice(0, 24);
}

function audit(req, action, fileId = null) {
  db.prepare(
    'INSERT INTO audit_events(action, file_id, ip_hash, user_agent, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(action, fileId, hashIp(getClientIp(req)), String(req.headers['user-agent'] || '').slice(0, 300), now());
}

function parseCookies(req) {
  const output = {};
  for (const item of String(req.headers.cookie || '').split(';')) {
    const index = item.indexOf('=');
    if (index < 0) continue;
    const name = item.slice(0, index).trim();
    let value = item.slice(index + 1).trim();
    try { value = decodeURIComponent(value); } catch { /* keep raw value on malformed percent-encoding */ }
    output[name] = value;
  }
  return output;
}

function isSecureRequest(req) {
  return process.env.NODE_ENV === 'production' || req.headers['x-forwarded-proto'] === 'https';
}

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, { ...jsonHeaders, ...headers });
  res.end(JSON.stringify(payload));
}

function sendError(res, status, message, code = 'ERROR') {
  sendJson(res, status, { error: code, message });
}

function setSessionCookie(res, token, secure) {
  res.setHeader(
    'set-cookie',
    `transfer_session=${encodeURIComponent(token)}; Path=/transfer; HttpOnly; SameSite=Strict; Max-Age=43200${secure ? '; Secure' : ''}`,
  );
}

function isAccessCodeValid(value) {
  if (!cfg.accessCodeHash) return process.env.NODE_ENV !== 'production' && value === 'local-dev-only';
  const [kind, saltText, digestText] = cfg.accessCodeHash.split('$');
  if (kind !== 'scrypt' || !saltText || !digestText) return false;
  try {
    const salt = Buffer.from(saltText, 'base64url');
    const expected = Buffer.from(digestText, 'base64url');
    const actual = scryptSync(String(value || ''), salt, expected.length, { N: 16384, r: 8, p: 1 });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function sessionFor(req) {
  const token = parseCookies(req).transfer_session;
  if (!token) return null;
  const session = teamSessions.get(token);
  if (!session || session.expiresAt <= now()) {
    teamSessions.delete(token);
    return null;
  }
  session.expiresAt = now() + 12 * 60 * 60 * 1000;
  return session;
}

function requireSession(req, res) {
  // Public transfer center: team entry operations are open to all visitors.
  // Object contents remain private in OSS and use short-lived signed URLs.
  return { public: true };
}

function isRateLimited(key) {
  const item = loginFailures.get(key);
  return Boolean(item && item.until > now());
}

function pruneMap(map, limit) {
  while (map.size > limit) map.delete(map.keys().next().value);
}

function recordLoginFailure(key) {
  const current = loginFailures.get(key) || { count: 0, until: 0 };
  if (current.until > 0 && current.until <= now()) current.count = 0; // fresh budget once a lock window expires
  current.count += 1;
  if (current.count >= 5) current.until = now() + 5 * 60 * 1000;
  loginFailures.set(key, current);
  pruneMap(loginFailures, 20_000);
}

function clearLoginFailures(key) {
  loginFailures.delete(key);
}

function allowPublicRate(key, limit, windowMs) {
  const timestamp = now();
  const current = publicRateBuckets.get(key);
  if (!current || current.resetAt <= timestamp) {
    publicRateBuckets.set(key, { count: 1, resetAt: timestamp + windowMs });
    pruneMap(publicRateBuckets, 50_000);
    return true;
  }
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
}

async function readJson(req, limit = 2 * 1024 * 1024) {
  let length = Number(req.headers['content-length'] || 0);
  if (length > limit) throw new Error('REQUEST_TOO_LARGE');
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error('REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function percentEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function isoTimestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function getServerCredentials() {
  const staticId = process.env.ALIYUN_ACCESS_KEY_ID;
  const staticSecret = process.env.ALIYUN_ACCESS_KEY_SECRET;
  if (staticId && staticSecret) {
    return {
      accessKeyId: staticId,
      accessKeySecret: staticSecret,
      securityToken: process.env.ALIYUN_SECURITY_TOKEN || '',
      expiresAt: now() + 10 * 60 * 1000,
    };
  }
  if (cachedServerCredentials && cachedServerCredentials.expiresAt > now() + 60_000) {
    return cachedServerCredentials;
  }
  const base = 'http://100.100.100.200/latest/meta-data/ram/security-credentials/';
  const roleResponse = await fetch(base, { signal: AbortSignal.timeout(3000) });
  if (!roleResponse.ok) throw new Error('ECS_RAM_ROLE_MISSING');
  const roleName = (await roleResponse.text()).trim();
  if (!roleName) throw new Error('ECS_RAM_ROLE_MISSING');
  const credentialsResponse = await fetch(`${base}${encodeURIComponent(roleName)}`, { signal: AbortSignal.timeout(3000) });
  if (!credentialsResponse.ok) throw new Error('ECS_RAM_CREDENTIALS_UNAVAILABLE');
  const data = await credentialsResponse.json();
  cachedServerCredentials = {
    accessKeyId: data.AccessKeyId,
    accessKeySecret: data.AccessKeySecret,
    securityToken: data.SecurityToken || '',
    expiresAt: Date.parse(data.Expiration) || now() + 30 * 60 * 1000,
  };
  return cachedServerCredentials;
}

async function assumeRoleForObject(objectKey) {
  if (!cfg.roleArn) throw new Error('STS_ROLE_NOT_CONFIGURED');
  const source = await getServerCredentials();
  const params = {
    AccessKeyId: source.accessKeyId,
    Action: 'AssumeRole',
    DurationSeconds: '900',
    Format: 'JSON',
    Policy: JSON.stringify({
      Version: '1',
      Statement: [{
        Effect: 'Allow',
        Action: ['oss:PutObject', 'oss:AbortMultipartUpload', 'oss:ListParts'],
        Resource: [`acs:oss:*:*:${cfg.bucket}/${objectKey}`],
      }],
    }),
    RoleArn: cfg.roleArn,
    RoleSessionName: `transfer-${randomUUID().slice(0, 12)}`,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: randomUUID(),
    SignatureVersion: '1.0',
    Timestamp: isoTimestamp(),
    Version: '2015-04-01',
  };
  if (source.securityToken) params.SecurityToken = source.securityToken;
  const canonical = Object.keys(params).sort().map(key => `${percentEncode(key)}=${percentEncode(params[key])}`).join('&');
  const stringToSign = `GET&%2F&${percentEncode(canonical)}`;
  params.Signature = createHmac('sha1', `${source.accessKeySecret}&`).update(stringToSign).digest('base64');
  const query = Object.keys(params).sort().map(key => `${percentEncode(key)}=${percentEncode(params[key])}`).join('&');
  const response = await fetch(`${cfg.stsEndpoint}/?${query}`, { signal: AbortSignal.timeout(8000) });
  const data = await response.json();
  if (!response.ok || data.Code) throw new Error(data.Message || data.Code || 'STS_ASSUME_ROLE_FAILED');
  return {
    accessKeyId: data.Credentials.AccessKeyId,
    accessKeySecret: data.Credentials.AccessKeySecret,
    securityToken: data.Credentials.SecurityToken,
    expiration: data.Credentials.Expiration,
  };
}

async function getOssClient(internal = false, credentials = null) {
  credentials ||= await getServerCredentials();
  return new OSS({
    region: cfg.region,
    bucket: cfg.bucket,
    endpoint: internal ? cfg.internalEndpoint : cfg.externalEndpoint,
    secure: true,
    accessKeyId: credentials.accessKeyId,
    accessKeySecret: credentials.accessKeySecret,
    stsToken: credentials.securityToken || undefined,
    timeout: 120_000,
  });
}

async function headObject(objectKey) {
  const client = await getOssClient(true);
  const result = await client.head(objectKey);
  const headers = result?.res?.headers || {};
  return {
    size: Number(headers['content-length'] || result?.meta?.size || 0),
    etag: String(headers.etag || result?.meta?.etag || '').replaceAll('"', ''),
    crc64: String(headers['x-oss-hash-crc64ecma'] || ''),
    encryption: String(headers['x-oss-server-side-encryption'] || ''),
  };
}

function publicFile(row, token = makeShareToken(row.id)) {
  const remainingSeconds = row.expires_at == null ? null : Math.max(0, Math.floor((row.expires_at - now()) / 1000));
  return {
    id: row.id,
    name: row.original_name,
    sizeBytes: Number(row.size_bytes),
    contentType: row.content_type,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
    remainingSeconds,
    sharePath: `/transfer/f/${token}`,
  };
}

function rowById(id) {
  return db.prepare('SELECT * FROM files WHERE id = ?').get(id);
}

function rowByShareToken(token) {
  return db.prepare('SELECT * FROM files WHERE share_token_hash = ?').get(shareHash(token));
}

function rowByPickupCode(code) {
  return db.prepare('SELECT * FROM files WHERE pickup_code_hash = ?').get(pickupHash(code));
}

function activeRow(row) {
  return row && row.status === 'AVAILABLE' && (row.expires_at == null || Number(row.expires_at) > now());
}

function shareUrlFor(row) {
  return `${cfg.publicBaseUrl}/f/${makeShareToken(row.id)}`;
}

function nativeDownloadGrant(row) {
  return { nativeUrl: `/transfer/api/share/${makeShareToken(row.id)}/content`,
    sizeBytes: Number(row.size_bytes), etag: row.etag, expiresAt: row.expires_at };
}

async function requestedDownloadGrant(req, row) {
  const body = await readJson(req, 4096);
  if (body.native === true) return nativeDownloadGrant(row);
  if (body.direct === true) return signedDownload(row);
  // Older open pages still read `url` and navigate to it on fallback. Keep
  // their requests stable too; only updated direct-download clients opt in.
  const grant = nativeDownloadGrant(row);
  return { ...grant, url: grant.nativeUrl, urlExpiresAt: null };
}

async function signedDownload(row, internal = false) {
  if (!activeRow(row)) throw new Error('FILE_EXPIRED');
  const credentials = await getServerCredentials();
  const client = await getOssClient(internal, credentials);
  const timestamp = now();
  const ttl = downloadLifetime(row.expires_at, credentials.expiresAt, timestamp);
  let encodedName;
  try {
    encodedName = encodeURIComponent(row.original_name).replaceAll("'", '%27');
  } catch {
    encodedName = 'download'; // defense in depth: never let a malformed name kill the download
  }
  const url = client.signatureUrl(row.object_key, {
    expires: ttl,
    response: {
      'content-disposition': `attachment; filename*=UTF-8''${encodedName}`,
    },
  });
  return { ...nativeDownloadGrant(row), url, urlExpiresAt: timestamp + ttl * 1000 };
}

async function cleanupExpired() {
  const timestamp = now();
  for (const [key, bucket] of publicRateBuckets) {
    if (bucket.resetAt <= timestamp) publicRateBuckets.delete(key);
  }
  for (const [key, item] of loginFailures) {
    if (item.until <= timestamp) loginFailures.delete(key);
  }
  for (const [key, session] of teamSessions) {
    if (session.expiresAt <= timestamp) teamSessions.delete(key);
  }
  const expired = db.prepare(
    "SELECT * FROM files WHERE status = 'AVAILABLE' AND expires_at <= ? ORDER BY expires_at LIMIT 100",
  ).all(now());
  for (const row of expired) {
    const result = db.prepare("UPDATE files SET status = 'DELETING', delete_attempts = delete_attempts + 1 WHERE id = ? AND status = 'AVAILABLE'").run(row.id);
    if (!result.changes) continue;
    try {
      const client = await getOssClient(true);
      await client.delete(row.object_key);
      db.prepare("UPDATE files SET status = 'DELETED', deleted_at = ? WHERE id = ?").run(now(), row.id);
    } catch (error) {
      db.prepare("UPDATE files SET status = 'AVAILABLE' WHERE id = ?").run(row.id);
      console.error(`[cleanup] ${row.id}: ${error.message}`);
    }
  }
  const staleUploads = db.prepare("SELECT * FROM files WHERE status = 'UPLOADING' AND created_at < ?").all(timestamp - 6 * 60 * 60 * 1000);
  for (const row of staleUploads) {
    const session = db.prepare('SELECT oss_upload_id FROM upload_sessions WHERE file_id = ?').get(row.id);
    const uploadId = session?.oss_upload_id;
    if (uploadId) {
      try {
        const client = await getOssClient(true);
        await client.abortMultipartUpload(row.object_key, uploadId);
        console.log(`[cleanup] aborted stale multipart upload ${row.id}`);
      } catch (error) {
        // Keep the row UPLOADING so the OSS abort is retried next cycle; a
        // failed abort would otherwise leak orphaned multipart storage forever.
        console.error(`[cleanup] multipart abort ${row.id}: ${error.message}`);
        continue;
      }
    }
    db.prepare("UPDATE files SET status = 'ABORTED' WHERE id = ? AND status = 'UPLOADING'").run(row.id);
    db.prepare('DELETE FROM upload_sessions WHERE file_id = ?').run(row.id);
  }
}

function parseShareValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return { kind: 'invalid' };
  try {
    const parsed = new URL(raw);
    const match = parsed.pathname.match(/\/transfer\/f\/([^/?#]+)/);
    if (match) return { kind: 'token', value: match[1] };
  } catch {
    // Treat it as a pickup code below.
  }
  const code = normalizePickupCode(raw);
  if (/^[A-Z2-9]{8}$/.test(code)) return { kind: 'code', value: code };
  return { kind: 'invalid' };
}

async function handleApi(req, res, pathname, url) {
  const path = pathname.startsWith('/transfer') ? pathname.slice('/transfer'.length) : pathname;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': 'same-origin', 'access-control-allow-headers': 'content-type' });
    res.end();
    return;
  }
  if (req.method === 'GET' && path === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      service: 'fast-changyi',
      ossConfigured: Boolean(cfg.bucket && cfg.roleArn),
      time: new Date().toISOString(),
    });
    return;
  }
  if (req.method === 'POST' && path === '/api/auth/login') {
    const key = getClientIp(req);
    if (isRateLimited(key)) {
      sendError(res, 429, '尝试次数过多，请稍后再试', 'RATE_LIMITED');
      return;
    }
    let body;
    try {
      body = await readJson(req);
    } catch {
      sendError(res, 400, '请求格式不正确', 'BAD_REQUEST');
      return;
    }
    if (!isAccessCodeValid(body.code)) {
      recordLoginFailure(key);
      sendError(res, 401, '访问口令不正确', 'INVALID_ACCESS_CODE');
      return;
    }
    clearLoginFailures(key);
    const token = randomBytes(32).toString('base64url');
    teamSessions.set(token, { expiresAt: now() + 12 * 60 * 60 * 1000 });
    pruneMap(teamSessions, 10_000);
    setSessionCookie(res, token, isSecureRequest(req));
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === 'POST' && path === '/api/auth/logout') {
    const token = parseCookies(req).transfer_session;
    if (token) teamSessions.delete(token);
    res.setHeader('set-cookie', 'transfer_session=; Path=/transfer; HttpOnly; SameSite=Strict; Max-Age=0');
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === 'GET' && path === '/api/config') {
    if (!requireSession(req, res)) return;
    sendJson(res, 200, {
      region: cfg.region,
      bucket: cfg.bucket,
      endpoint: cfg.externalEndpoint,
      maxFileBytes: cfg.maxFileBytes,
    });
    return;
  }
  if (req.method === 'GET' && path === '/api/files/recent') {
    if (!requireSession(req, res)) return;
    const rows = db.prepare(
      "SELECT * FROM files WHERE status = 'AVAILABLE' ORDER BY completed_at DESC LIMIT 50",
    ).all();
    sendJson(res, 200, { files: rows.map(row => ({ ...publicFile(row), shareUrl: shareUrlFor(row) })) });
    return;
  }
  if (req.method === 'POST' && path === '/api/uploads') {
    if (!requireSession(req, res)) return;
    if (!allowPublicRate(`create:${getClientIp(req)}`, 20, 60 * 60 * 1000)) {
      sendError(res, 429, '上传创建次数过多，请稍后再试', 'RATE_LIMITED');
      return;
    }
    let body;
    try {
      body = await readJson(req);
    } catch {
      sendError(res, 400, '请求格式不正确', 'BAD_REQUEST');
      return;
    }
    const size = Number(body.size);
    if (!Number.isSafeInteger(size) || size <= 0 || size > cfg.maxFileBytes) {
      sendError(res, 413, '文件大小超过当前业务上限', 'FILE_TOO_LARGE');
      return;
    }
    const id = randomUUID();
    const objectKey = `transfer/v1/${id.slice(0, 2)}/${id}/payload`;
    let pickupCode = makePickupCode();
    while (db.prepare('SELECT 1 FROM files WHERE pickup_code_hash = ?').get(pickupHash(pickupCode))) pickupCode = makePickupCode();
    const token = makeShareToken(id);
    const createdAt = now();
    db.prepare(`INSERT INTO files
      (id, object_key, original_name, content_type, size_bytes, status, share_token_hash, pickup_code_hash, created_at)
      VALUES (?, ?, ?, ?, ?, 'UPLOADING', ?, ?, ?)`).run(
      id,
      objectKey,
      safeFileName(body.name),
      safeContentType(body.type),
      size,
      shareHash(token),
      pickupHash(pickupCode),
      createdAt,
    );
    db.prepare(`INSERT INTO upload_sessions
      (id, file_id, expected_size, created_at, last_seen_at, status)
      VALUES (?, ?, ?, ?, ?, 'CREATED')`).run(randomUUID(), id, size, createdAt, createdAt);
    audit(req, 'UPLOAD_CREATED', id);
    sendJson(res, 201, { id, objectKey, pickupCode, token, sharePath: `/transfer/f/${token}` });
    return;
  }
  const credentialMatch = path.match(/^\/api\/uploads\/([^/]+)\/credentials$/);
  if (req.method === 'POST' && credentialMatch) {
    if (!requireSession(req, res)) return;
    if (!allowPublicRate(`credentials:${getClientIp(req)}`, 120, 10 * 60 * 1000)) {
      sendError(res, 429, '临时凭证请求过于频繁，请稍后再试', 'RATE_LIMITED');
      return;
    }
    const row = rowById(credentialMatch[1]);
    if (!row || row.status !== 'UPLOADING') {
      sendError(res, 404, '上传任务不存在或已结束', 'UPLOAD_NOT_FOUND');
      return;
    }
    try {
      const credentials = await assumeRoleForObject(row.object_key);
      db.prepare('UPDATE upload_sessions SET last_seen_at = ?, status = ? WHERE file_id = ?').run(now(), 'ACTIVE', row.id);
      sendJson(res, 200, {
        credentials: {
          AccessKeyId: credentials.accessKeyId,
          AccessKeySecret: credentials.accessKeySecret,
          SecurityToken: credentials.securityToken,
          Expiration: credentials.expiration,
        },
        region: cfg.region,
        bucket: cfg.bucket,
        endpoint: cfg.externalEndpoint,
      });
    } catch (error) {
      console.error(`[credentials] ${row.id}: ${error.message}`);
      sendError(res, 503, 'OSS 临时凭证尚未配置完成', error.message);
    }
    return;
  }
  const heartbeatMatch = path.match(/^\/api\/uploads\/([^/]+)\/heartbeat$/);
  if (req.method === 'POST' && heartbeatMatch) {
    if (!requireSession(req, res)) return;
    const row = rowById(heartbeatMatch[1]);
    if (!row || row.status !== 'UPLOADING') {
      sendError(res, 404, '上传任务不存在或已结束', 'UPLOAD_NOT_FOUND');
      return;
    }
    let body = {};
    try { body = await readJson(req); } catch { sendError(res, 400, '请求格式不正确', 'BAD_REQUEST'); return; }
    const uploadId = String(body.uploadId || '').slice(0, 512);
    if (/^[A-Za-z0-9\-_/=+.]+$/.test(uploadId)) {
      db.prepare('UPDATE upload_sessions SET oss_upload_id = ?, last_seen_at = ?, status = ? WHERE file_id = ?').run(uploadId, now(), 'ACTIVE', row.id);
    }
    sendJson(res, 200, { ok: true });
    return;
  }
  const completeMatch = path.match(/^\/api\/uploads\/([^/]+)\/complete$/);
  if (req.method === 'POST' && completeMatch) {
    if (!requireSession(req, res)) return;
    const row = rowById(completeMatch[1]);
    if (!row) {
      sendError(res, 404, '上传任务不存在', 'UPLOAD_NOT_FOUND');
      return;
    }
    if (row.status === 'AVAILABLE' && activeRow(row)) {
      const token = makeShareToken(row.id);
      sendJson(res, 200, { file: publicFile(row, token), shareUrl: shareUrlFor(row), pickupCode: null });
      return;
    }
    if (row.status !== 'UPLOADING') {
      sendError(res, 409, '上传任务已经结束', 'UPLOAD_CLOSED');
      return;
    }
    let body = {};
    try {
      body = await readJson(req);
    } catch {
      sendError(res, 400, '请求格式不正确', 'BAD_REQUEST');
      return;
    }
    const suppliedPickupCode = normalizePickupCode(body.pickupCode);
    if (!/^[A-Z2-9]{8}$/.test(suppliedPickupCode) || pickupHash(suppliedPickupCode) !== row.pickup_code_hash) {
      sendError(res, 403, '取件码校验失败，请从当前上传任务继续完成', 'PICKUP_CODE_MISMATCH');
      return;
    }
    try {
      const head = await headObject(row.object_key);
      if (head.size !== Number(row.size_bytes)) {
        sendError(res, 409, 'OSS 文件大小校验失败', 'SIZE_MISMATCH');
        return;
      }
      const completedAt = now();
      const expiresAt = null;
      db.prepare(`UPDATE files SET status = 'AVAILABLE', etag = ?, crc64 = ?, completed_at = ?, expires_at = ? WHERE id = ? AND status = 'UPLOADING'`).run(
        head.etag,
        head.crc64,
        completedAt,
        expiresAt,
        row.id,
      );
      const updated = rowById(row.id);
      audit(req, 'UPLOAD_COMPLETED', row.id);
      sendJson(res, 200, {
        file: publicFile(updated),
        shareUrl: shareUrlFor(updated),
        pickupCode: formatPickupCode(suppliedPickupCode),
      });
    } catch (error) {
      console.error(`[complete] ${row.id}: ${error.message}`);
      sendError(res, 503, '上传已完成，但服务端校验暂时失败，请稍后重试', error.message);
    }
    return;
  }
  const abortMatch = path.match(/^\/api\/uploads\/([^/]+)\/abort$/);
  if (req.method === 'POST' && abortMatch) {
    if (!requireSession(req, res)) return;
    const row = rowById(abortMatch[1]);
    if (!row) {
      sendJson(res, 200, { ok: true });
      return;
    }
    let body = {};
    try { body = await readJson(req); } catch { /* no body is acceptable */ }
    db.prepare("UPDATE files SET status = 'ABORTED' WHERE id = ? AND status = 'UPLOADING'").run(row.id);
    audit(req, 'UPLOAD_ABORTED', row.id);
    sendJson(res, 200, { ok: true });
    const uploadId = String(body.uploadId || '').slice(0, 512);
    if (/^[A-Za-z0-9\-_/=+.]+$/.test(uploadId)) {
      db.prepare('UPDATE upload_sessions SET oss_upload_id = ? WHERE file_id = ?').run(uploadId, row.id);
      void getOssClient(true)
        .then(client => client.abortMultipartUpload(row.object_key, uploadId))
        .catch(error => console.error(`[abort-background] ${row.id}: ${error.message}`));
    }
    return;
  }
  if (req.method === 'POST' && path === '/api/pickup/resolve') {
    if (!allowPublicRate(`pickup:${getClientIp(req)}`, 60, 10 * 60 * 1000)) {
      sendError(res, 429, '取件请求过于频繁，请稍后再试', 'RATE_LIMITED');
      return;
    }
    let body;
    try { body = await readJson(req); } catch { sendError(res, 400, '请求格式不正确', 'BAD_REQUEST'); return; }
    const parsed = parseShareValue(body.value);
    let row = null;
    let token = null;
    if (parsed.kind === 'token') {
      row = rowByShareToken(parsed.value);
      token = parsed.value;
    } else if (parsed.kind === 'code') {
      row = rowByPickupCode(parsed.value);
      if (row) token = makeShareToken(row.id);
    }
    if (!activeRow(row)) {
      sendError(res, 404, '取件码无效或文件已过期', 'FILE_NOT_FOUND');
      return;
    }
    sendJson(res, 200, { file: publicFile(row, token), token });
    return;
  }
  const shareMatch = path.match(/^\/api\/share\/([^/]+)$/);
  if (req.method === 'GET' && shareMatch) {
    const row = rowByShareToken(shareMatch[1]);
    if (!activeRow(row)) {
      sendError(res, 404, '文件已过期或不存在', 'FILE_NOT_FOUND');
      return;
    }
    sendJson(res, 200, { file: publicFile(row, shareMatch[1]) });
    return;
  }
  const nativeMatch = path.match(/^\/api\/share\/([^/]+)\/content$/);
  if (['GET', 'HEAD'].includes(req.method) && nativeMatch) {
    const row = rowByShareToken(nativeMatch[1]);
    if (!activeRow(row)) {
      sendError(res, 404, '文件不存在或已被删除', 'FILE_NOT_FOUND');
      return;
    }
    if (nativeDownloads >= 8) {
      res.setHeader('retry-after', '5');
      sendError(res, 429, '下载繁忙，请稍后重试', 'DOWNLOAD_BUSY');
      return;
    }
    nativeDownloads++;
    try {
      await streamDownload(req, res, {
        sizeBytes: row.size_bytes, etag: row.etag, name: row.original_name,
        completedAt: row.completed_at,
        createGrant: async (_signal, { retry }) => {
          if (retry) cachedServerCredentials = null;
          return signedDownload(row, true);
        },
      });
      audit(req, 'DOWNLOAD_STREAM_COMPLETED', row.id);
    } catch (error) {
      if (error.code !== 'CLIENT_DISCONNECTED') console.error(`[download-stream] ${row.id}: ${error.code || error.name}`);
      if (!res.headersSent && !res.destroyed) {
        if (error.status === 416) res.setHeader('content-range', `bytes */${row.size_bytes}`);
        const message = error.code === 'FILE_NOT_FOUND' ? '文件不存在或已被删除' :
          error.code === 'OBJECT_CHANGED' ? '文件内容已变化，请刷新后重新下载' : '下载暂时中断，请重试；浏览器可从已下载的位置继续';
        sendError(res, error.status || 503, message, error.code || 'DOWNLOAD_UNAVAILABLE');
      } else if (!res.destroyed) res.destroy();
    } finally {
      nativeDownloads--;
    }
    return;
  }
  const shareDownloadMatch = path.match(/^\/api\/share\/([^/]+)\/download$/);
  if (req.method === 'POST' && shareDownloadMatch) {
    const row = rowByShareToken(shareDownloadMatch[1]);
    if (!activeRow(row)) {
      sendError(res, 404, '文件已过期或不存在', 'FILE_NOT_FOUND');
      return;
    }
    try {
      const grant = await requestedDownloadGrant(req, row);
      audit(req, 'DOWNLOAD_URL_ISSUED', row.id);
      sendJson(res, 200, grant);
    } catch (error) {
      console.error(`[download] ${row.id}: ${error.message}`);
      sendError(res, 503, '下载链接暂时无法生成', error.message);
    }
    return;
  }
  const fileDownloadMatch = path.match(/^\/api\/files\/([^/]+)\/download$/);
  if (req.method === 'POST' && fileDownloadMatch) {
    if (!requireSession(req, res)) return;
    const row = rowById(fileDownloadMatch[1]);
    if (!activeRow(row)) {
      sendError(res, 404, '文件已过期或不存在', 'FILE_NOT_FOUND');
      return;
    }
    try {
      const grant = await requestedDownloadGrant(req, row);
      audit(req, 'DOWNLOAD_URL_ISSUED', row.id);
      sendJson(res, 200, grant);
    } catch (error) {
      console.error(`[download] ${row.id}: ${error.message}`);
      sendError(res, 503, '下载链接暂时无法生成', error.message);
    }
    return;
  }
  if (req.method === 'POST' && path === '/api/internal/cleanup') {
    // Local-only: the TCP peer must be loopback AND, when a reverse proxy has
    // stamped the real client into x-real-ip, that value must be loopback too.
    // (Behind nginx every socket address is 127.0.0.1, so the socket check
    // alone would let any external visitor through.)
    const socketIp = String(req.socket.remoteAddress || '');
    const forwarded = String(req.headers['x-real-ip'] || '').split(',')[0].trim();
    if (!isLoopbackIp(socketIp) || (forwarded && !isLoopbackIp(forwarded))) {
      sendError(res, 403, '仅允许本机调用', 'FORBIDDEN');
      return;
    }
    await cleanupExpired();
    sendJson(res, 200, { ok: true });
    return;
  }
  sendError(res, 404, '接口不存在', 'NOT_FOUND');
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function serveStatic(req, res, pathname) {
  if (pathname === '/transfer') {
    res.writeHead(308, { location: '/transfer/' });
    res.end();
    return;
  }
  let assetPath = null;
  if (pathname === '/transfer/' || /^\/transfer\/f\/[^/]+$/.test(pathname)) assetPath = join(publicDir, 'index.html');
  else if (pathname.startsWith('/transfer/')) assetPath = join(publicDir, normalize(pathname.slice('/transfer/'.length)));
  const relativeAsset = assetPath ? relative(publicDir, assetPath) : '';
  if (!assetPath || relativeAsset.startsWith('..') || isAbsolute(relativeAsset)) {
    sendError(res, 404, '页面不存在', 'NOT_FOUND');
    return;
  }
  try {
    const body = await readFile(assetPath);
    const type = mime[extname(assetPath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': assetPath.endsWith('index.html') ? 'no-store' : 'public, max-age=300' });
    res.end(body);
  } catch {
    sendError(res, 404, '页面不存在', 'NOT_FOUND');
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    if (url.pathname.includes('/api/')) {
      await handleApi(req, res, url.pathname, url);
      return;
    }
    if (req.method === 'GET') {
      await serveStatic(req, res, url.pathname);
      return;
    }
    sendError(res, 405, '方法不支持', 'METHOD_NOT_ALLOWED');
  } catch (error) {
    console.error(`[request] ${error.stack || error.message}`);
    if (!res.headersSent) sendError(res, 500, '服务暂时不可用', 'INTERNAL_ERROR');
    else res.end();
  }
});

server.listen(cfg.port, cfg.host, () => {
  console.log(`fast-changyi listening on ${cfg.host}:${server.address().port}`);
});

const cleanupTimer = setInterval(() => cleanupExpired().catch(error => console.error(`[cleanup-loop] ${error.message}`)), 60_000);
cleanupTimer.unref();

function shutdown(signal) {
  console.log(`${signal}: stopping fast-changyi`);
  clearInterval(cleanupTimer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
