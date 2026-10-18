function failure(code, retryable = false) {
  const error = new Error(code);
  error.code = code;
  error.retryable = retryable;
  return error;
}

function abortReason(signal) {
  return signal.reason || new DOMException('Aborted', 'AbortError');
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortReason(signal)); return; }
    const abort = () => { clearTimeout(timer); reject(abortReason(signal)); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

// Streams straight to disk. Failed reads resume from the last successfully
// written byte; one failing worker stops all peers before the sink is aborted.
export async function downloadRanges({ grant, refreshGrant, writable, signal,
  onProgress = () => {}, parallel = 6, chunkSize = 8 * 1024 * 1024,
  idleTimeoutMs = 30_000, attempts = 4, retryDelayMs = 500, fetchImpl = fetch }) {
  const total = Number(grant.sizeBytes);
  if (!Number.isSafeInteger(total) || total <= 0) throw failure('INVALID_DOWNLOAD_SIZE');
  const controller = new AbortController();
  const abort = () => controller.abort(abortReason(signal));
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  const taskSignal = controller.signal;
  const count = Math.ceil(total / chunkSize);
  const concurrency = Math.max(1, Math.min(parallel, count));
  let next = 0;
  let downloaded = 0;
  let currentGrant = grant;
  let refreshing;
  let writeChain = Promise.resolve();
  let firstError;
  const etag = grant.etag;

  const renew = () => {
    if (!refreshing) {
      refreshing = Promise.resolve().then(() => refreshGrant(taskSignal)).then(value => {
        if (Number(value.sizeBytes) !== total || (etag && value.etag !== etag)) {
          throw failure('OBJECT_CHANGED');
        }
        currentGrant = value;
        return value;
      }).finally(() => { refreshing = null; });
    }
    return refreshing;
  };

  const writeAt = (position, data) => {
    const write = writeChain.then(async () => {
      if (taskSignal.aborted) throw abortReason(taskSignal);
      try { await writable.write({ type: 'write', position, data }); }
      catch { throw failure('DISK_WRITE_FAILED'); }
    });
    writeChain = write;
    // The worker awaits the same promise, so attach an observer immediately.
    void write.catch(() => {});
    return write;
  };

  const worker = async () => {
    while (!taskSignal.aborted) {
      const index = next++;
      if (index >= count) return;
      let position = index * chunkSize;
      const end = Math.min(total - 1, position + chunkSize - 1);
      for (let attempt = 0; position <= end; attempt++) {
        if (taskSignal.aborted) throw abortReason(taskSignal);
        let reader;
        let response;
        let timer;
        let stop;
        const request = new AbortController();
        const touch = () => {
          clearTimeout(timer);
          timer = setTimeout(() => request.abort(failure('DOWNLOAD_TIMEOUT', true)), idleTimeoutMs);
        };
        try {
          // Refresh before expiry, and always obtain new authorization on retry.
          if (attempt > 0 || currentGrant.urlExpiresAt <= Date.now() + 15_000) await renew();
          if (taskSignal.aborted) throw abortReason(taskSignal);
          stop = () => request.abort(abortReason(taskSignal));
          taskSignal.addEventListener('abort', stop, { once: true });
          touch();
          const headers = { Range: `bytes=${position}-${end}` };
          if (etag) headers['If-Match'] = `"${etag.replaceAll('"', '')}"`;
          response = await fetchImpl(currentGrant.url, { headers, signal: request.signal, credentials: 'omit', cache: 'no-store' });
          if (response.status === 412) throw failure('OBJECT_CHANGED');
          if (response.status !== 206 || !response.body) {
            throw failure(`RANGE_HTTP_${response.status}`, [401, 403, 408, 429].includes(response.status) || response.status >= 500);
          }
          const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
          if (!range || Number(range[1]) !== position || Number(range[2]) !== end || Number(range[3]) !== total) {
            throw failure('RANGE_MISMATCH');
          }
          const responseEtag = response.headers.get('etag')?.replaceAll('"', '');
          if (etag && responseEtag !== etag.replaceAll('"', '')) throw failure('OBJECT_CHANGED');
          const length = response.headers.get('content-length');
          if (length !== null && Number(length) !== end - position + 1) throw failure('RANGE_LENGTH_MISMATCH');
          reader = response.body.getReader();
          while (true) {
            touch();
            const { done, value } = await reader.read();
            clearTimeout(timer);
            if (taskSignal.aborted) throw abortReason(taskSignal);
            if (done) break;
            if (position + value.byteLength > end + 1) throw failure('RANGE_OVERFLOW');
            await writeAt(position, value);
            position += value.byteLength;
            downloaded += value.byteLength;
            onProgress(downloaded, total, concurrency);
          }
          if (position !== end + 1) throw failure('RANGE_INCOMPLETE', true);
        } catch (error) {
          if (taskSignal.aborted) throw abortReason(taskSignal);
          const problem = request.signal.aborted ? request.signal.reason : error;
          // fetch network/stream failures are TypeErrors in browsers.
          if (attempt + 1 >= attempts || (!problem.retryable && !(problem instanceof TypeError))) throw problem;
          await pause(retryDelayMs * 2 ** attempt, taskSignal);
        } finally {
          clearTimeout(timer);
          if (stop) taskSignal.removeEventListener('abort', stop);
          request.abort();
          if (reader) {
            try { await reader.cancel(); } catch { /* Closed/error stream. */ }
            reader.releaseLock();
          } else if (response?.body) {
            try { await response.body.cancel(); } catch { /* Best effort. */ }
          }
        }
      }
    }
    throw abortReason(taskSignal);
  };

  try {
    const workers = Array.from({ length: concurrency }, () => worker().catch(error => {
      if (!firstError) firstError = error;
      controller.abort(error);
      throw error;
    }));
    await Promise.allSettled(workers);
    await writeChain.catch(error => { if (!firstError) firstError = error; });
    if (firstError) throw firstError;
    if (taskSignal.aborted) throw abortReason(taskSignal);
    await writable.truncate(total);
    if (taskSignal.aborted) throw abortReason(taskSignal);
    await writable.close();
  } catch (error) {
    controller.abort(error);
    try { await writable.abort(); } catch { /* Best effort. */ }
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
