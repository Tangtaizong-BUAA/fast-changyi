function problem(code, status = 502, retryable = false) {
  return Object.assign(new Error(code), { code, status, retryable });
}

export function byteRange(value, total) {
  if (!Number.isSafeInteger(total) || total <= 0) throw problem('INVALID_DOWNLOAD_SIZE', 503);
  if (!value) return { start: 0, end: total - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw problem('INVALID_RANGE', 416);
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) throw problem('INVALID_RANGE', 416);
  const start = first === null ? Math.max(0, total - last) : first;
  const end = first === null || last === null ? total - 1 : Math.min(last, total - 1);
  if (start >= total || end < start) throw problem('INVALID_RANGE', 416);
  return { start, end, partial: true };
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    signal.addEventListener('abort', stop, { once: true });
  });
}

function withSignal(operation, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    Promise.resolve().then(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

function write(res, value, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (signal.aborted || res.destroyed) { reject(signal.reason || problem('CLIENT_DISCONNECTED')); return; }
    const finish = error => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      if (error) reject(error); else resolve();
    };
    const stop = () => finish(signal.reason);
    const timer = setTimeout(() => finish(problem('CLIENT_WRITE_TIMEOUT')), timeoutMs);
    signal.addEventListener('abort', stop, { once: true });
    // Await every write callback: downstream backpressure bounds memory even
    // when an OSS connection is much faster than the user's connection.
    try { res.write(value, finish); } catch (error) { finish(error); }
  });
}

// A stable same-origin address for the browser's download manager. Signed
// upstream addresses never reach the browser; every chunk/retry renews them.
export async function streamDownload(req, res, { sizeBytes, etag, name,
  completedAt, createGrant, fetchImpl = fetch, chunkSize = 8 * 1024 * 1024,
  attempts = 4, idleTimeoutMs = 15_000, writeTimeoutMs = 60_000, retryDelayMs = 250 }) {
  const total = Number(sizeBytes);
  const tag = String(etag || '').replaceAll('"', '');
  if (!tag || /[\r\n]/.test(tag)) throw problem('INVALID_OBJECT_ETAG', 503);
  const quotedTag = `"${tag}"`;
  const modified = Math.floor(Number(completedAt || 0) / 1000) * 1000;
  let rangeHeader = req.method === 'HEAD' ? null : req.headers.range;
  if (rangeHeader && req.headers['if-range']) {
    const condition = req.headers['if-range'];
    const date = Date.parse(condition);
    if (condition !== quotedTag && (!Number.isFinite(date) || !modified || modified > date)) rangeHeader = null;
  }
  const range = byteRange(rangeHeader, total);
  if (req.headers['if-match'] && req.headers['if-match'] !== '*' && !req.headers['if-match'].split(',').map(s => s.trim()).includes(quotedTag)) throw problem('OBJECT_CHANGED', 412);
  let encodedName;
  try { encodedName = encodeURIComponent(name || 'download').replaceAll("'", '%27'); } catch { encodedName = 'download'; }
  const headers = {
    'content-type': 'application/octet-stream',
    'content-disposition': `attachment; filename*=UTF-8''${encodedName}`,
    'content-length': String(range.end - range.start + 1),
    'accept-ranges': 'bytes', etag: quotedTag,
    'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
    'x-accel-buffering': 'no',
  };
  if (modified) headers['last-modified'] = new Date(modified).toUTCString();
  if (range.partial) headers['content-range'] = `bytes ${range.start}-${range.end}/${total}`;
  if (req.method === 'HEAD') { res.writeHead(200, headers); res.end(); return; }
  const controller = new AbortController();
  const signal = controller.signal;
  const disconnect = () => controller.abort(problem('CLIENT_DISCONNECTED'));
  res.once('close', disconnect);
  req.once('aborted', disconnect);
  // Prevent an unhandled response error while a reader or write is pending.
  res.once('error', disconnect);
  let position = range.start;
  try {
    while (position <= range.end) {
      const end = Math.min(range.end, position + chunkSize - 1);
      for (let attempt = 0; position <= end; attempt++) {
        if (signal.aborted) throw signal.reason;
        let response, reader, timer;
        const request = new AbortController();
        const stop = () => request.abort(signal.reason);
        signal.addEventListener('abort', stop, { once: true });
        const touch = () => {
          clearTimeout(timer);
          timer = setTimeout(() => request.abort(problem('DOWNLOAD_TIMEOUT', 504, true)), idleTimeoutMs);
        };
        let retry;
        try {
          touch();
          const grant = await withSignal(() => createGrant(request.signal, { retry: attempt > 0 }), request.signal);
          if (request.signal.aborted) throw request.signal.reason;
          if (signal.aborted) throw signal.reason;
          response = await fetchImpl(grant.url, { headers: { Range: `bytes=${position}-${end}`, 'If-Match': quotedTag }, signal: request.signal, redirect: 'error' });
          if (response.status === 404) throw problem('FILE_NOT_FOUND', 404);
          if (response.status === 412) throw problem('OBJECT_CHANGED', 409);
          if (response.status !== 206 || !response.body) throw problem(`UPSTREAM_HTTP_${response.status}`, 502, [401,403,408,429].includes(response.status) || response.status >= 500);
          const contentRange = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
          if (!contentRange || Number(contentRange[1]) !== position || Number(contentRange[2]) !== end || Number(contentRange[3]) !== total) throw problem('RANGE_MISMATCH');
          if (response.headers.get('etag')?.replaceAll('"', '') !== tag) throw problem('OBJECT_CHANGED', 409);
          const length = response.headers.get('content-length');
          if (length !== null && Number(length) !== end - position + 1) throw problem('RANGE_LENGTH_MISMATCH');
          // Only commit headers after verifying the first real OSS response.
          // A failed authorization cannot become an XML/HTML file download.
          if (!res.headersSent) res.writeHead(range.partial ? 206 : 200, headers);
          reader = response.body.getReader();
          while (true) {
            touch();
            const { done, value } = await reader.read();
            clearTimeout(timer);
            if (signal.aborted) throw signal.reason;
            if (done) break;
            if (position + value.byteLength > end + 1) throw problem('RANGE_OVERFLOW');
            await write(res, value, signal, writeTimeoutMs);
            position += value.byteLength;
          }
          if (position !== end + 1) throw problem('RANGE_INCOMPLETE', 502, true);
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          const cause = request.signal.aborted ? request.signal.reason : error;
          retry = cause.retryable || cause instanceof TypeError || /^ECS_RAM_|DOWNLOAD_AUTH_EXPIRED/.test(cause.message);
          if (!retry || attempt + 1 >= attempts) throw cause;
        } finally {
          clearTimeout(timer);
          signal.removeEventListener('abort', stop);
          request.abort();
          if (reader) {
            try { await reader.cancel(); } catch { /* Closed/error stream. */ }
            reader.releaseLock();
          } else if (response?.body) {
            try { await response.body.cancel(); } catch { /* Best effort. */ }
          }
        }
        if (retry) await delay(retryDelayMs * 2 ** attempt, signal);
      }
    }
    if (signal.aborted) throw signal.reason;
    res.end();
  } catch (error) {
    // A partial transfer must fail visibly, allowing the download manager to
    // resume this stable URL. Never mark truncated bytes as a successful file.
    if (res.headersSent && !res.destroyed) res.destroy();
    throw error;
  } finally {
    res.removeListener('close', disconnect);
    req.removeListener('aborted', disconnect);
    res.removeListener('error', disconnect);
  }
}
