import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { byteRange, streamDownload } from '../native-download.mjs';

const source = Buffer.alloc(2 * 1024 * 1024 + 137);
for (let i = 0; i < source.length; i++) source[i] = (i * 17 + 13) % 251;
const etag = 'fixture-object-version';
const digest = value => createHash('sha256').update(value).digest('hex');

function rangeResponse(start, end, overrides = {}, body = source.subarray(start, end + 1)) {
  return new Response(body, { status: 206, headers: {
    'content-range': `bytes ${start}-${end}/${source.length}`,
    'content-length': String(end - start + 1), etag: `"${etag}"`, ...overrides,
  } });
}

async function fixture(options = {}) {
  const requests = [], grants = [], errors = [];
  const server = createServer(async (req, res) => {
    try {
      await streamDownload(req, res, {
        sizeBytes: source.length, etag, name: '中文文件.bin', completedAt: 1_700_000_000_123,
        chunkSize: 128 * 1024, retryDelayMs: 1,
        createGrant: async (_signal, { retry }) => {
          grants.push(retry);
          return { url: `https://fixture.invalid/signature-${grants.length}` };
        },
        fetchImpl: async (url, config) => {
          const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(config.headers.Range);
          requests.push({ url, start: Number(first), end: Number(last), signal: config.signal });
          assert.equal(config.headers['If-Match'], `"${etag}"`);
          return rangeResponse(Number(first), Number(last));
        }, ...options,
      });
    } catch (error) {
      errors.push(error.code || error.name);
      if (!res.headersSent && !res.destroyed) {
        if (error.status === 416) res.setHeader('content-range', `bytes */${source.length}`);
        res.writeHead(error.status || 503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: error.code }));
      }
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}/content`, requests, grants, errors,
    async close() { server.closeAllConnections(); server.close(); await once(server, 'close'); } };
}

test('native full download has a stable address, exact hash and attachment name', async () => {
  const f = await fixture();
  try {
    const response = await fetch(f.url);
    assert.equal(response.status, 200);
    assert.equal(response.url, f.url);
    assert.equal(response.headers.get('content-length'), String(source.length));
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.ok(response.headers.get('content-disposition').includes(encodeURIComponent('中文文件.bin')));
    assert.equal(digest(Buffer.from(await response.arrayBuffer())), digest(source));
    assert.equal(f.grants.length, Math.ceil(source.length / (128 * 1024)));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('browser resume, suffix and If-Range preserve HTTP byte semantics', async () => {
  const f = await fixture();
  try {
    for (const [range, start, end] of [['bytes=123-', 123, source.length - 1], ['bytes=-137', source.length - 137, source.length - 1], ['bytes=7-1029', 7, 1029]]) {
      const response = await fetch(f.url, { headers: { Range: range, 'If-Range': `"${etag}"` } });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${source.length}`);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), source.subarray(start, end + 1));
    }
    const changed = await fetch(f.url, { headers: { Range: 'bytes=123-', 'If-Range': '"old-version"' } });
    assert.equal(changed.status, 200);
    assert.equal(digest(Buffer.from(await changed.arrayBuffer())), digest(source));
    const date = await fetch(f.url, { headers: { Range: 'bytes=7-13', 'If-Range': new Date(1_700_000_000_000).toUTCString() } });
    assert.equal(date.status, 206);await date.arrayBuffer();
    const mismatch = await fetch(f.url, { headers: { 'If-Match': '"old-version"' } });
    assert.equal(mismatch.status, 412);
    const head = await fetch(f.url, { method: 'HEAD', headers: { Range: 'bytes=1-3' } });
    assert.equal(head.status, 200);assert.equal(head.headers.get('content-length'), String(source.length));
  } finally { await f.close(); }
});

test('expired authorization is retried privately with a fresh signature', async () => {
  let calls = 0;
  const urls = [];
  const f = await fixture({ fetchImpl: async (url, { headers }) => {
    urls.push(url);
    if (++calls === 1) return new Response('<Error>Request has expired</Error>', { status: 403 });
    const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(headers.Range);
    return rangeResponse(Number(first), Number(last));
  } });
  try {
    const response = await fetch(f.url);
    assert.equal(response.status, 200);assert.equal(response.url, f.url);
    assert.equal(digest(Buffer.from(await response.arrayBuffer())), digest(source));
    assert.notEqual(urls[0], urls[1]);assert.equal(f.grants[1], true);
  } finally { await f.close(); }
});

test('upstream interruption resumes from committed bytes without duplicates', async () => {
  const ranges = [];let attempts = 0;
  const f = await fixture({ fetchImpl: async (_url, { headers }) => {
    const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(headers.Range);
    const start = Number(first), end = Number(last);ranges.push(start);
    if (++attempts === 1) {
      let pulls = 0;
      const body = new ReadableStream({ pull(controller) {
        if (++pulls === 1) controller.enqueue(source.subarray(start, start + 73));
        else controller.error(new TypeError('connection reset'));
      } }, { highWaterMark: 0 });
      return rangeResponse(start, end, {}, body);
    }
    return rangeResponse(start, end);
  } });
  try {
    const response = await fetch(f.url);
    assert.equal(digest(Buffer.from(await response.arrayBuffer())), digest(source));
    assert.deepEqual(ranges.slice(0, 2), [0, 73]);
  } finally { await f.close(); }
});

for (const kind of ['headers', 'body', 'credentials']) test(`${kind} hang has bounded retries and no successful partial file`, async () => {
  const settings = { idleTimeoutMs: 5, attempts: 2 };
  let calls = 0;
  if (kind === 'credentials') settings.createGrant = async () => { calls++;return new Promise(() => {}); };
  else settings.fetchImpl = async (_url, { signal }) => {
    calls++;
    if (kind === 'headers') return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(source.subarray(0, 13));
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    } });
    return rangeResponse(calls === 1 ? 0 : 13, 128 * 1024 - 1, {}, body);
  };
  const f = await fixture(settings);
  try {
    if (kind === 'body') {
      const response = await fetch(f.url);
      await assert.rejects(response.arrayBuffer());
    } else assert.equal((await fetch(f.url)).status, 504);
    assert.equal(calls, 2);assert.deepEqual(f.errors, ['DOWNLOAD_TIMEOUT']);
  } finally { await f.close(); }
});

for (const [headers, code] of [
  [{ 'content-range': `bytes 1-131072/${source.length}` }, 'RANGE_MISMATCH'],
  [{ etag: '"changed-version"' }, 'OBJECT_CHANGED'],
  [{ 'content-length': '1' }, 'RANGE_LENGTH_MISMATCH'],
]) test(`invalid upstream ${code} never commits a download response`, async () => {
  const f = await fixture({ fetchImpl: async () => rangeResponse(0, 128 * 1024 - 1, headers) });
  try {
    const response = await fetch(f.url);
    assert.equal(response.headers.get('content-disposition'), null);
    assert.equal((await response.json()).error, code);
    assert.equal(f.grants.length, 1);
  } finally { await f.close(); }
});

test('retry exhaustion after data is sent fails the connection instead of closing a short file successfully', async () => {
  let calls = 0;
  const f = await fixture({ attempts: 2, fetchImpl: async (_url, { headers }) => {
    if (++calls > 1) return new Response('unavailable', { status: 503 });
    const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(headers.Range);
    return rangeResponse(Number(first), Number(last));
  } });
  try {
    const response = await fetch(f.url);
    await assert.rejects(response.arrayBuffer());
    assert.equal(calls, 3);assert.deepEqual(f.errors, ['UPSTREAM_HTTP_503']);
  } finally { await f.close(); }
});

test('client cancellation aborts the upstream and stops new authorizations', async () => {
  let upstream;
  const f = await fixture({ fetchImpl: async (_url, { signal }) => {
    upstream = signal;
    return rangeResponse(0, 128 * 1024 - 1, {}, new ReadableStream({ start(controller) {
      controller.enqueue(source.subarray(0, 13));
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    } }));
  } });
  try {
    const controller = new AbortController();
    const response = await fetch(f.url, { signal: controller.signal });
    const reader = response.body.getReader();await reader.read();controller.abort();
    for (let i = 0; i < 50 && !upstream.aborted; i++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(upstream.aborted, true);assert.equal(f.grants.length, 1);
  } finally { await f.close(); }
});

test('range parsing clamps valid bounds and rejects malformed or unsatisfiable requests', () => {
  assert.deepEqual(byteRange('bytes=7-999', 8), { start: 7, end: 7, partial: true });
  assert.deepEqual(byteRange('bytes=-999', 8), { start: 0, end: 7, partial: true });
  for (const value of ['bytes=8-', 'bytes=3-1', 'bytes=-0', 'bytes=-', 'bytes=0-1,3-4', 'bytes=9007199254740993-', 'items=0-1']) assert.throws(() => byteRange(value, 8), { status: 416 });
});

test('offsets beyond 4 GiB remain exact without allocating the entire file', async () => {
  const total = 16_299_462_480, start = 6_000_000_001, end = start + 136;
  const bytes = source.subarray(0, end - start + 1);
  const f = await fixture({ sizeBytes: total, fetchImpl: async (_url, { headers }) => {
    assert.equal(headers.Range, `bytes=${start}-${end}`);
    return new Response(bytes, { status: 206, headers: {
      'content-range': `bytes ${start}-${end}/${total}`,
      'content-length': String(bytes.length), etag: `"${etag}"`,
    } });
  } });
  try {
    const response = await fetch(f.url, { headers: { Range: `bytes=${start}-${end}` } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${total}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  } finally { await f.close(); }
});

test('a real upstream TCP reset resumes with the exact byte offset and hash', async () => {
  let calls = 0;const ranges = [];
  const upstream = createServer((req, res) => {
    const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range);
    const start = Number(first), end = Number(last);ranges.push(start);
    res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${source.length}`,
      'content-length': String(end - start + 1), etag: `"${etag}"` });
    if (++calls === 1) {
      res.write(source.subarray(start, start + 73));
      setTimeout(() => res.destroy(), 15);
    } else res.end(source.subarray(start, end + 1));
  });
  upstream.listen(0, '127.0.0.1');await once(upstream, 'listening');
  const f = await fixture({ fetchImpl: (url, options) => fetch(`http://127.0.0.1:${upstream.address().port}/${new URL(url).pathname}`, options) });
  try {
    const response = await fetch(f.url);
    assert.equal(digest(Buffer.from(await response.arrayBuffer())), digest(source));
    assert.deepEqual(ranges.slice(0, 2), [0, 73]);
  } finally {
    await f.close();upstream.closeAllConnections();upstream.close();await once(upstream, 'close');
  }
});

test('short upstream body retries from EOF; downstream backpressure and timeout remain bounded', async () => {
  let calls = 0;const ranges = [];
  const f = await fixture({ fetchImpl: async (_url, { headers }) => {
    const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(headers.Range);
    const start = Number(first), end = Number(last);ranges.push(start);
    return rangeResponse(start, end, {}, ++calls === 1 ? source.subarray(0, 73) : source.subarray(start, end + 1));
  } });
  try {
    const response = await fetch(f.url);
    assert.equal(digest(Buffer.from(await response.arrayBuffer())), digest(source));
    assert.deepEqual(ranges.slice(0, 2), [0, 73]);
  } finally { await f.close(); }
  const { EventEmitter } = await import('node:events');
  const req = new EventEmitter();req.method = 'GET';req.headers = {};
  const res = new EventEmitter();res.destroyed = false;res.headersSent = false;
  let writes = 0, pulls = 0;
  res.writeHead = () => { res.headersSent = true; };
  res.write = () => { writes++;return false; }; // deliberately never drains
  res.destroy = () => { res.destroyed = true; };
  await assert.rejects(streamDownload(req, res, { sizeBytes: source.length, etag, writeTimeoutMs: 5,
    createGrant: async () => ({ url: 'https://fixture.invalid/fresh' }),
    fetchImpl: async () => rangeResponse(0, source.length - 1, {}, new ReadableStream({ pull(controller) {
      pulls++;controller.enqueue(source.subarray(0, 13));
    } }, { highWaterMark: 0 })),
  }), { code: 'CLIENT_WRITE_TIMEOUT' });
  assert.equal(writes, 1);assert.equal(pulls, 1);assert.equal(res.destroyed, true);
});
