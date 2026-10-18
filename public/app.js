import { downloadRanges } from './download.js?v=20261009-3';
import { expirationAttribute, remainingAt } from './expiration.js?v=20261009-3';

const API_BASE = '/transfer/api';
const RESUME_PREFIX = 'changyi-transfer-resume:';
const CHECKPOINT_PREFIX = 'changyi-transfer-checkpoint:';
const DIRECT_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
const MOBILE_MULTIPART_PARALLEL = 3;

const $ = selector => document.querySelector(selector);

const els = {
  accessPanel: $('#access-panel'),
  appPanel: $('#app-panel'),
  loginForm: $('#login-form'),
  accessCode: $('#access-code'),
  loginMessage: $('#login-message'),
  logout: $('#logout-button'),
  uploadButton: $('#upload-button'),
  copyCodeButton: $('#copy-code-button'),
  fileInput: $('#file-input'),
  pickupInput: $('#pickup-input'),
  resolveButton: $('#resolve-button'),
  refreshButton: $('#refresh-button'),
  recentList: $('#recent-list'),
  uploadProgress: $('#upload-progress'),
  progressName: $('#progress-name'),
  progressPercent: $('#progress-percent'),
  progressBar: $('#progress-bar'),
  progressMessage: $('#progress-message'),
  cancelUpload: $('#cancel-upload-button'),
  latestResult: $('#latest-result'),
  resultName: $('#result-name'),
  resultCode: $('#result-code'),
  resultLink: $('#result-link'),
  copyLinkButton: $('#copy-link-button'),
  resultCountdown: $('#result-countdown'),
  resultMessage: $('#result-message'),
  shareTarget: $('#share-target'),
  toast: $('#toast'),
};

const state = {
  loggedIn: false,
  publicOnly: false,
  config: null,
  latest: null,
  currentUpload: null,
  currentDownload: null,
  recentTimer: null,
  countdownTimer: null,
  toastTimer: null,
};

function showToast(message, tone = 'normal') {
  clearTimeout(state.toastTimer);
  els.toast.textContent = message;
  els.toast.dataset.tone = tone;
  els.toast.hidden = false;
  state.toastTimer = setTimeout(() => { els.toast.hidden = true; }, 3600);
}

function escapeHtml(value) {
  const node = document.createElement('span');
  node.textContent = String(value ?? '');
  return node.innerHTML;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let size = value;
  let index = -1;
  do { size /= 1024; index += 1; } while (size >= 1024 && index < units.length - 1);
  return `${size >= 100 ? size.toFixed(0) : size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${units[index]}`;
}

function formatThroughput(bytesPerSecond) {
  const value = Number(bytesPerSecond) || 0;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB/s`;
  return `${(value / 1024 / 1024).toFixed(value >= 100 * 1024 * 1024 ? 0 : 1)} MB/s`;
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function formatRemaining(seconds) {
  if (seconds === null) return '永久保留';
  if (seconds === undefined || !Number.isFinite(Number(seconds))) return '有效期未知';
  const value = Math.max(0, Number(seconds) || 0);
  if (value <= 0) return '已过期';
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  if (hours > 0) return `剩余 ${hours} 小时${minutes ? ` ${minutes} 分钟` : ''}`;
  return `剩余 ${Math.max(1, minutes)} 分钟`;
}

function formatCountdown(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  if (hours > 0) return `剩余 ${hours}小时 ${String(minutes).padStart(2, '0')}分`;
  return `剩余 ${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatTime(value) {
  if (!value) return '—';
  try { return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)); } catch { return '—'; }
}

function makeFingerprint(file) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function storageKey(prefix, file) {
  return `${prefix}${encodeURIComponent(makeFingerprint(file))}`;
}

function readStorage(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}

function writeStorage(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage can be unavailable in private mode. */ }
}

function removeStorage(key) {
  try { localStorage.removeItem(key); } catch { /* Best effort cleanup. */ }
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  let body = options.body;
  if (body !== undefined && body !== null && typeof body !== 'string' && !(body instanceof FormData)) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(body);
  }
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    body,
    headers,
    credentials: 'same-origin',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || `请求失败（${response.status}）`);
    error.status = response.status;
    error.code = data.error || 'REQUEST_FAILED';
    throw error;
  }
  return data;
}

function showLoggedIn(value) {
  state.loggedIn = value;
  if (!state.publicOnly) {
    els.accessPanel.hidden = value;
    els.appPanel.hidden = !value;
    els.logout.hidden = true;
  }
  if (!value) {
    els.latestResult.hidden = true;
    els.copyCodeButton.disabled = true;
  }
}

function showPublicMode() {
  state.publicOnly = true;
  els.accessPanel.hidden = true;
  els.appPanel.hidden = false;
  document.querySelector('.control-card').hidden = true;
  document.querySelector('.recent-section').hidden = true;
  els.logout.hidden = true;
}

function setLoginMessage(message = '') {
  els.loginMessage.textContent = message;
}

async function loadConfig() {
  state.config = await api('/config');
  return state.config;
}

async function loadRecent() {
  if (!state.loggedIn) return;
  try {
    const data = await api('/files/recent');
    renderRecent(data.files || []);
  } catch (error) {
    if (error.status === 401) showLoggedIn(false);
    else showToast(error.message, 'error');
  }
}

function renderRecent(files) {
  if (!files.length) {
    els.recentList.innerHTML = '<div class="empty-state">暂无文件</div>';
    return;
  }
  els.recentList.innerHTML = files.map(file => `
    <div class="file-row">
      <div class="file-info">
        <div class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
        <div class="file-meta"><span>${formatBytes(file.sizeBytes)}</span><span>上传于 ${formatTime(file.completedAt)}</span><span data-expires="${escapeHtml(expirationAttribute(file.expiresAt))}">${formatRemaining(remainingAt(file.expiresAt))}</span></div>
      </div>
      <div class="file-actions"><button class="text-button" type="button" data-download-id="${escapeHtml(file.id)}" data-download-name="${escapeHtml(file.name)}" data-download-size="${Number(file.sizeBytes) || 0}">下载</button><button class="text-button" type="button" data-copy-share="${escapeHtml(file.shareUrl)}">复制链接</button></div>
    </div>
  `).join('');
}

function renderResult(file, code, shareUrl) {
  state.latest = { file, code, shareUrl };
  els.latestResult.hidden = false;
  els.resultName.textContent = file.name;
  els.resultCode.textContent = code || '—';
  els.resultLink.textContent = shareUrl || '—';
  els.resultLink.title = shareUrl || '';
  els.resultCountdown.dataset.expires = expirationAttribute(file.expiresAt);
  updateCountdowns();
  els.resultMessage.textContent = '';
  els.copyCodeButton.disabled = !code;
}

function renderShareTarget(file, token, publicMode = false) {
  const shareUrl = `${window.location.origin}/transfer/f/${encodeURIComponent(token)}`;
  els.shareTarget.hidden = false;
  els.shareTarget.innerHTML = `<div class="share-layout"><div class="share-meta"><h3 class="share-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</h3><p>${formatBytes(file.sizeBytes)} · <span data-expires="${escapeHtml(expirationAttribute(file.expiresAt))}">${formatRemaining(remainingAt(file.expiresAt))}</span></p></div><button class="btn-primary" type="button" data-share-download="${escapeHtml(token)}" data-download-name="${escapeHtml(file.name)}" data-download-size="${Number(file.sizeBytes) || 0}">下载</button></div>`;
  els.shareTarget.dataset.shareUrl = shareUrl;
}

function renderShareError(message) {
  els.shareTarget.hidden = false;
  els.shareTarget.innerHTML = `<div class="share-layout"><div class="share-meta"><h3>${escapeHtml(message)}</h3></div><button class="btn-secondary" type="button" data-go-home="true">返回</button></div>`;
}

function updateCountdowns() {
  document.querySelectorAll('[data-expires]').forEach(node => {
    const remaining = remainingAt(node.dataset.expires);
    if (remaining == null) {
      node.textContent = formatRemaining(remaining);
      node.classList.remove('warning');
      return;
    }
    if (node === els.resultCountdown) node.textContent = remaining ? formatCountdown(remaining) : '已过期';
    else node.textContent = formatRemaining(remaining);
    node.classList.toggle('warning', remaining > 0 && remaining < 30 * 60);
  });
}

async function copyText(value) {
  if (!value) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  }
}

function safeDownloadName(value) {
  return String(value || 'download').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 220) || 'download';
}

async function requestDownloadDestination(file) {
  if (typeof window.showSaveFilePicker !== 'function') return null;
  try {
    const handle = await window.showSaveFilePicker({ suggestedName: safeDownloadName(file.name) });
    if (typeof handle.createWritable !== 'function') return { writable: null, canceled: false, nativeFallback: true };
    return { writable: await handle.createWritable(), canceled: false };
  } catch (error) {
    if (error?.name === 'AbortError') return { writable: null, canceled: true };
    // Some browsers expose the picker but disallow createWritable in the
    // current platform/context. The browser download manager is still usable.
    if (['NotAllowedError', 'SecurityError', 'NotSupportedError'].includes(error?.name)) {
      return { writable: null, canceled: false, nativeFallback: true };
    }
    throw error;
  }
}

function chooseDownloadParallel(size) {
  const cores = Number(navigator.hardwareConcurrency) || 4;
  const target = isMobileBrowser() ? 2 : Math.min(6, Math.max(2, cores));
  return Math.min(target, Math.max(1, Math.ceil(size / (8 * 1024 * 1024))));
}

function nativeDownloadUrl(grant) {
  // Accept only the fixed same-origin route. Never navigate to an expiring
  // cloud signature, including fallback from an older or malformed backend.
  if (!/^\/transfer\/api\/share\/[A-Za-z0-9_-]+\/content$/.test(grant.nativeUrl || '')) {
    throw new Error('下载服务版本不一致，请刷新页面后重试');
  }
  return grant.nativeUrl;
}

async function runDownload(path, file) {
  // Reserve the transfer before opening the picker, including pending dialogs.
  if (state.currentDownload || state.currentUpload) {
    showToast('当前已有传输任务', 'error');
    return;
  }
  const task = { controller: new AbortController(), canceled: false, writable: null };
  state.currentDownload = task;
  els.uploadButton.disabled = true;
  els.cancelUpload.hidden = false;
  els.cancelUpload.disabled = false;
  els.cancelUpload.textContent = '取消下载';
  setProgress(`下载 · ${file.name}`, 0, '请选择保存位置…');
  const requestGrant = async (signal = task.controller.signal, native = !task.writable) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal.aborted) throw signal.reason;
      const timeout = new AbortController();
      const stop = () => timeout.abort(signal.reason);
      signal.addEventListener('abort', stop, { once: true });
      const timer = setTimeout(() => timeout.abort(), 20_000);
      let retry = false;
      try {
        const data = await api(path, { method: 'POST', body: { native, direct: !native }, signal: timeout.signal });
        if ((!native && !data.url) || !Number.isSafeInteger(Number(data.sizeBytes)) || Number(data.sizeBytes) <= 0) throw new Error('下载授权信息不完整，请刷新页面后重试');
        return data;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        retry = error instanceof TypeError || timeout.signal.aborted || [408, 429].includes(error.status) || error.status >= 500;
        if (!retry || attempt === 2) {
          if (timeout.signal.aborted) throw new Error('获取下载链接超时，请检查网络后重试');
          throw error;
        }
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', stop);
      }
      if (retry) await wait(500 * 2 ** attempt);
    }
  };
  try {
    const destinationPromise = requestDownloadDestination(file);
    const destination = destinationPromise ? await destinationPromise : null;
    task.writable = destination?.writable;
    if (destination?.canceled || task.canceled) {
      task.canceled = true;
      if (task.writable) await task.writable.abort();
      return;
    }
    // Authorize after the user has chosen a directory, so dialog time cannot
    // consume the URL lifetime. Unsupported browsers use a stable same-origin address.
    setProgress(`下载 · ${file.name}`, 0, '正在获取下载授权…');
    const grant = await requestGrant();
    if (task.canceled) return;
    if (!task.writable) {
      window.location.assign(nativeDownloadUrl(grant));
      if (destination?.nativeFallback) showToast('已切换浏览器下载，请在浏览器下载列表查看进度');
      return;
    }
    const startedAt = performance.now();
    await downloadRanges({
      grant, refreshGrant: requestGrant, writable: task.writable,
      signal: task.controller.signal,
      parallel: chooseDownloadParallel(grant.sizeBytes),
      onProgress: (downloaded, total, parallel) => {
        const elapsed = Math.max(0.001, (performance.now() - startedAt) / 1000);
        setProgress(`下载 · ${file.name}`, Math.min(99, downloaded / total * 100),
          `${formatBytes(downloaded)} / ${formatBytes(total)} · ${formatThroughput(downloaded / elapsed)} · ${parallel} 路并发`);
      },
    });
    if (!task.canceled) showToast('下载完成');
  } catch (error) {
    if (task.writable) {
      try { await task.writable.abort(); } catch { /* Best effort. */ }
    }
    if (task.canceled) return;
    if (error.status === 401) {
      showLoggedIn(false);
      setLoginMessage('登录已过期，请重新输入访问口令');
    }
    // Never mask disk errors or changed objects by launching another download.
    const canFallback = error instanceof TypeError || /^RANGE_|DOWNLOAD_TIMEOUT/.test(error.code || '');
    if (canFallback) {
      try {
        const fresh = await requestGrant(task.controller.signal, true);
        if (task.canceled) return;
        window.location.assign(nativeDownloadUrl(fresh));
        showToast('已切换浏览器下载，请在浏览器下载列表查看进度');
      } catch (fallbackError) {
        if (!task.canceled) showToast(fallbackError.message || '下载授权失败，请重试', 'error');
      }
    } else {
      const messages = {
        OBJECT_CHANGED: '文件内容已变化，请刷新页面后重新下载',
        DISK_WRITE_FAILED: '无法写入文件，请检查磁盘空间和保存权限',
        QuotaExceededError: '磁盘空间不足，请更换保存位置后重试',
        NoModificationAllowedError: '文件可能被其他程序占用，请更换保存位置后重试',
        NotFoundError: '保存位置已不可用，请重新选择',
      };
      showToast(messages[error.code] || messages[error.name] || error.message || '下载失败，请重试', 'error');
    }
    if (error.code === 'FILE_NOT_FOUND') loadRecent();
  } finally {
    if (state.currentDownload === task) {
      state.currentDownload = null;
      els.uploadProgress.hidden = true;
      els.uploadButton.disabled = false;
      els.cancelUpload.disabled = false;
      els.cancelUpload.textContent = '取消上传';
    }
  }
}

async function downloadShare(token, file) {
  await runDownload(`/share/${encodeURIComponent(token)}/download`, file);
}

async function downloadById(id, file) {
  await runDownload(`/files/${encodeURIComponent(id)}/download`, file);
}

async function resolvePickup() {
  const value = els.pickupInput.value.trim();
  if (!value) {
    showToast('请粘贴取件链接或输入取件码', 'error');
    return;
  }
  els.resolveButton.disabled = true;
  try {
    const data = await api('/pickup/resolve', { method: 'POST', body: { value } });
    renderShareTarget(data.file, data.token);
    els.shareTarget.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    renderShareError(error.message);
  } finally {
    els.resolveButton.disabled = false;
  }
}

function setProgress(name, percent, message) {
  els.uploadProgress.hidden = false;
  els.progressName.textContent = name;
  const normalized = Math.max(0, Math.min(100, Math.round(percent)));
  els.progressPercent.textContent = `${normalized}%`;
  els.progressBar.style.width = `${normalized}%`;
  els.progressMessage.textContent = message;
}

function checkpointForStorage(checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object') return null;
  const copy = { ...checkpoint };
  delete copy.file;
  return copy;
}

function loadCheckpoint(file) {
  const value = readStorage(storageKey(CHECKPOINT_PREFIX, file));
  if (!value || Number(value.fileSize || value.size || 0) !== file.size || value.name !== file.name) return null;
  value.file = file;
  return value;
}

function persistCheckpoint(file, checkpoint) {
  const value = checkpointForStorage(checkpoint);
  if (value) writeStorage(storageKey(CHECKPOINT_PREFIX, file), value);
}

function clearUploadStorage(file) {
  removeStorage(storageKey(RESUME_PREFIX, file));
  removeStorage(storageKey(CHECKPOINT_PREFIX, file));
}

function choosePartSize(size) {
  const min = 8 * 1024 * 1024;
  const max = 256 * 1024 * 1024;
  const needed = Math.ceil(size / 9000);
  const aligned = Math.ceil(needed / (1024 * 1024)) * 1024 * 1024;
  return Math.min(max, Math.max(min, aligned));
}

function chooseParallel(size) {
  const gib = 1024 * 1024 * 1024;
  const cores = Math.max(4, Number(navigator.hardwareConcurrency) || 8);
  const connectionTarget = Math.min(8, Math.max(6, Math.floor(cores * 1.25)));
  if (size < 256 * 1024 * 1024) return Math.min(6, connectionTarget);
  if (size < 100 * gib) return connectionTarget;
  if (size < 500 * gib) return Math.min(6, connectionTarget);
  return 3;
}

function isMobileBrowser() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
}

function sampleUploadSpeed(task, fraction) {
  const timestamp = performance.now();
  const uploaded = Math.max(0, Math.min(task.file.size, fraction * task.file.size));
  if (!task.speedSample) {
    task.speedSample = { timestamp, uploaded, smoothed: 0 };
    return 0;
  }
  const elapsed = (timestamp - task.speedSample.timestamp) / 1000;
  if (elapsed < 0.25) return task.speedSample.smoothed;
  const instant = Math.max(0, uploaded - task.speedSample.uploaded) / elapsed;
  const smoothed = task.speedSample.smoothed ? task.speedSample.smoothed * 0.72 + instant * 0.28 : instant;
  task.speedSample = { timestamp, uploaded, smoothed };
  return smoothed;
}

function formatUploadStatus(task, fraction, bytesPerSecond, parallel, partSize) {
  const uploaded = Math.max(0, Math.min(task.file.size, fraction * task.file.size));
  const speed = bytesPerSecond > 0 ? ` · ${formatThroughput(bytesPerSecond)}` : '';
  return `${formatBytes(uploaded)} / ${formatBytes(task.file.size)}${speed} · ${parallel} 路并发 · ${Math.round(partSize / 1024 / 1024)} MB 分片`;
}

function formatDirectUploadStatus(task, uploaded, bytesPerSecond) {
  const speed = bytesPerSecond > 0 ? ` · ${formatThroughput(bytesPerSecond)}` : '';
  return `${formatBytes(uploaded)} / ${formatBytes(task.file.size)}${speed} · 单连接直传`;
}

function humanizeUploadError(error) {
  const raw = String(error?.message || error || '');
  if (/XHR error|RequestError|connected:\s*false|SMALL_UPLOAD_NETWORK/i.test(raw)) {
    return '网络连接中断，上传未完成。请保持页面在前台并重新选择文件。';
  }
  if (/timeout|SMALL_UPLOAD_TIMEOUT/i.test(raw)) {
    return '上传连接超时，请检查网络后重新选择文件。';
  }
  if (/cancel/i.test(raw)) return '上传已取消';
  return '上传失败，请检查网络后重试。';
}

function uploadSmallFile(task) {
  const file = task.file;
  const contentType = file.type || 'application/octet-stream';
  const signedUrl = task.client.signatureUrl(task.objectKey, {
    method: 'PUT',
    expires: 15 * 60,
    'Content-Type': contentType,
    'x-oss-forbid-overwrite': 'true',
  });
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    task.xhr = xhr;
    xhr.open('PUT', signedUrl, true);
    xhr.timeout = 10 * 60 * 1000;
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.setRequestHeader('x-oss-forbid-overwrite', 'true');
    xhr.upload.onprogress = event => {
      if (task.canceled || !event.lengthComputable) return;
      const fraction = Math.max(0, Math.min(1, event.loaded / file.size));
      const speed = sampleUploadSpeed(task, fraction);
      setProgress(file.name, fraction * 100, formatDirectUploadStatus(task, event.loaded, speed));
    };
    xhr.onload = () => {
      task.xhr = null;
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`SMALL_UPLOAD_HTTP_${xhr.status}`));
    };
    xhr.onerror = () => {
      task.xhr = null;
      reject(new Error('SMALL_UPLOAD_NETWORK'));
    };
    xhr.ontimeout = () => {
      task.xhr = null;
      reject(new Error('SMALL_UPLOAD_TIMEOUT'));
    };
    xhr.onabort = () => {
      task.xhr = null;
      reject(new Error('SMALL_UPLOAD_CANCELED'));
    };
    xhr.send(file);
  });
}

async function uploadSmallFileWithRetry(task) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (task.canceled) throw new Error('SMALL_UPLOAD_CANCELED');
    task.speedSample = null;
    try {
      await uploadSmallFile(task);
      return;
    } catch (error) {
      if (task.canceled || /CANCELED/.test(String(error?.message || ''))) throw error;
      lastError = error;
      if (attempt < 3) {
        setProgress(task.file.name, 0, `网络波动，正在自动重试（${attempt}/2）…`);
        await wait(attempt * 700);
      }
    }
  }
  throw lastError || new Error('SMALL_UPLOAD_NETWORK');
}

async function uploadMultipartWithRetry(task, partSize, parallel) {
  let checkpoint = task.checkpoint || undefined;
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (task.canceled) throw new Error('MULTIPART_UPLOAD_CANCELED');
    try {
      const result = await task.client.multipartUpload(task.objectKey, task.file, {
        partSize,
        parallel,
        checkpoint,
        headers: { 'x-oss-forbid-overwrite': 'true' },
        progress: (percent, nextCheckpoint) => {
          if (task.canceled) return;
          checkpoint = nextCheckpoint || checkpoint;
          task.checkpoint = checkpoint;
          task.uploadId = checkpoint?.uploadId || task.uploadId;
          reportUploadId(task);
          persistCheckpoint(task.file, checkpoint);
          const bytesPerSecond = sampleUploadSpeed(task, percent);
          setProgress(task.file.name, percent * 100, formatUploadStatus(task, percent, bytesPerSecond, parallel, partSize));
        },
      });
      return result;
    } catch (error) {
      if (task.canceled || /CANCELED/i.test(String(error?.message || ''))) throw error;
      lastError = error;
      checkpoint = loadCheckpoint(task.file) || checkpoint;
      task.checkpoint = checkpoint;
      if (attempt < 3) {
        setProgress(task.file.name, 0, `并行连接波动，正在从已完成分片重试（${attempt}/2）…`);
        await wait(attempt * 700);
      }
    }
  }
  throw lastError || new Error('MULTIPART_UPLOAD_NETWORK');
}

async function getUploadCredentials(fileId) {
  return api(`/uploads/${encodeURIComponent(fileId)}/credentials`, { method: 'POST', body: {} });
}

// Tell the server the OSS multipart uploadId as soon as the SDK knows it, so
// the server-side 6-hour timeout can abort the real multipart upload instead
// of leaving orphaned parts in OSS.
function reportUploadId(task) {
  if (!task.uploadId || task.uploadIdReported) return;
  void api(`/uploads/${encodeURIComponent(task.fileId)}/heartbeat`, {
    method: 'POST',
    body: { uploadId: task.uploadId },
  }).then(() => { task.uploadIdReported = true; }).catch(() => undefined);
}

function makeOssClient(task, credentialData) {
  const OSSLite = window.OSS;
  if (!OSSLite) throw new Error('浏览器上传组件尚未加载，请刷新后重试');
  const value = credentialData.credentials;
  return new OSSLite({
    region: credentialData.region,
    bucket: credentialData.bucket,
    endpoint: credentialData.endpoint,
    secure: true,
    accessKeyId: value.AccessKeyId,
    accessKeySecret: value.AccessKeySecret,
    stsToken: value.SecurityToken,
    timeout: 600000,
    retryMax: 3,
    refreshSTSToken: async () => {
      const refreshed = await getUploadCredentials(task.fileId);
      const next = refreshed.credentials;
      return { accessKeyId: next.AccessKeyId, accessKeySecret: next.AccessKeySecret, stsToken: next.SecurityToken };
    },
  });
}

async function createOrResumeTask(file) {
  const resumeKey = storageKey(RESUME_PREFIX, file);
  let saved = readStorage(resumeKey);
  if (saved?.fileId && saved?.objectKey && saved?.pickupCode) {
    try {
      await getUploadCredentials(saved.fileId);
      return { ...saved, resumed: true };
    } catch (error) {
      if (error.code !== 'UPLOAD_NOT_FOUND') throw error;
      removeStorage(resumeKey);
      removeStorage(storageKey(CHECKPOINT_PREFIX, file));
      saved = null;
    }
  }
  const created = await api('/uploads', { method: 'POST', body: { name: file.name, size: file.size, type: file.type } });
  const task = { fileId: created.id, objectKey: created.objectKey, pickupCode: created.pickupCode, token: created.token };
  writeStorage(resumeKey, task);
  return task;
}

async function startUpload(file) {
  if (state.currentUpload || state.currentDownload) {
    showToast('当前已有传输任务', 'error');
    return;
  }
  let task = null;
  try {
    if (!state.config) await loadConfig();
    if (file.size <= 0) throw new Error('不能上传空文件');
    if (file.size > Number(state.config.maxFileBytes)) throw new Error(`文件超过当前上限（${formatBytes(state.config.maxFileBytes)}）`);
    task = await createOrResumeTask(file);
    task.file = file;
    task.checkpoint = loadCheckpoint(file);
    task.canceled = false;
    state.currentUpload = task;
    els.uploadButton.disabled = true;
    els.cancelUpload.hidden = false;
    els.cancelUpload.disabled = false;
    els.cancelUpload.textContent = '取消上传';
    els.fileInput.value = '';
    setProgress(file.name, 0, task.resumed ? '已找到未完成任务，正在恢复…' : '正在准备临时上传凭证…');
    const credentials = await getUploadCredentials(task.fileId);
    task.client = makeOssClient(task, credentials);
    if (task.checkpoint?.uploadId) {
      task.uploadId = task.checkpoint.uploadId;
      reportUploadId(task);
    }
    const smallFile = file.size < DIRECT_UPLOAD_MAX_BYTES;
    if (smallFile) {
      clearUploadStorage(file);
      setProgress(file.name, 0, `0 B / ${formatBytes(file.size)} · 单连接直传`);
      await uploadSmallFileWithRetry(task);
    } else {
      const partSize = choosePartSize(file.size);
      const partCount = Math.max(1, Math.ceil(file.size / partSize));
      const requestedParallel = isMobileBrowser() ? MOBILE_MULTIPART_PARALLEL : chooseParallel(file.size);
      const parallel = Math.min(requestedParallel, partCount);
      if (task.checkpoint) task.checkpoint.file = file;
      setProgress(file.name, 0, task.checkpoint ? '正在续传已完成分片…' : '正在上传…');
      let result;
      try {
        result = await uploadMultipartWithRetry(task, partSize, parallel);
      } catch (error) {
        if (task.canceled || file.size >= 100 * 1024 * 1024) throw error;
        const failedUploadId = task.uploadId;
        if (failedUploadId) void task.client.abortMultipartUpload(task.objectKey, failedUploadId).catch(() => undefined);
        removeStorage(storageKey(CHECKPOINT_PREFIX, file));
        task.checkpoint = null;
        task.uploadId = null;
        task.speedSample = null;
        setProgress(file.name, 0, '并行上传不可用，正在自动切换兼容直传…');
        await uploadSmallFileWithRetry(task);
      }
      if (task.canceled) return;
      task.uploadId = result?.res?.requestUrls?.[0]?.uploadId || task.uploadId;
      reportUploadId(task);
    }
    if (task.canceled) return;
    setProgress(file.name, 100, '上传完成，正在校验 OSS 对象…');
    const completed = await api(`/uploads/${encodeURIComponent(task.fileId)}/complete`, { method: 'POST', body: { pickupCode: task.pickupCode } });
    clearUploadStorage(file);
    els.uploadProgress.hidden = true;
    renderResult(completed.file, completed.pickupCode || task.pickupCode, completed.shareUrl);
    await loadRecent();
    showToast('上传完成，取件码已生成');
  } catch (error) {
    if (!task?.canceled) {
      console.error('[upload]', error);
      if (error.status === 401) {
        showLoggedIn(false);
        setLoginMessage('登录已过期，请重新输入访问口令');
      }
      const message = error.code === 'STS_ROLE_NOT_CONFIGURED' || error.code === 'ECS_RAM_ROLE_MISSING' || error.code === 'ECS_RAM_CREDENTIALS_UNAVAILABLE'
        ? '服务器的 OSS 临时权限还未配置完成，请联系管理员。'
        : humanizeUploadError(error);
      setProgress(file.name, 0, message);
      els.cancelUpload.hidden = true;
      showToast(message, 'error');
    }
  } finally {
    if (state.currentUpload === task) {
      state.currentUpload = null;
      els.uploadButton.disabled = false;
    }
  }
}

async function cancelUpload() {
  const task = state.currentUpload;
  if (!task) {
    els.uploadProgress.hidden = true;
    return;
  }
  task.canceled = true;
  const multipartAbort = task.uploadId && task.client
    ? task.client.abortMultipartUpload(task.objectKey, task.uploadId).catch(() => undefined)
    : Promise.resolve();
  try { task.xhr?.abort(); } catch { /* Best effort. */ }
  try { task.client?.cancel(); } catch { /* Best effort. */ }
  clearUploadStorage(task.file);
  state.currentUpload = null;
  els.uploadButton.disabled = false;
  els.cancelUpload.disabled = false;
  els.uploadProgress.hidden = true;
  showToast('已取消上传');
  const serverAbort = api(`/uploads/${encodeURIComponent(task.fileId)}/abort`, {
    method: 'POST',
    body: { uploadId: task.uploadId || '' },
  }).catch(() => undefined);
  void Promise.race([
    Promise.allSettled([multipartAbort, serverAbort]),
    wait(5000),
  ]);
}

async function cancelActiveTransfer() {
  if (state.currentDownload) {
    const task = state.currentDownload;
    task.canceled = true;
    task.controller.abort();
    // The range engine drains workers before aborting the file sink.
    // Keep the reservation until runDownload's finally releases it.
    els.uploadProgress.hidden = true;
    els.cancelUpload.disabled = false;
    els.cancelUpload.textContent = '取消上传';
    showToast('已取消下载');
    return;
  }
  await cancelUpload();
}

async function login(event) {
  event.preventDefault();
  const code = els.accessCode.value.trim();
  if (!code) return;
  els.loginMessage.textContent = '正在验证…';
  try {
    await api('/auth/login', { method: 'POST', body: { code } });
    els.accessCode.value = '';
    setLoginMessage('');
    showLoggedIn(true);
    await loadConfig();
    await loadRecent();
  } catch (error) {
    setLoginMessage(error.message);
  }
}

async function logout() {
  try { await api('/auth/logout', { method: 'POST', body: {} }); } catch { /* Session may already be gone. */ }
  state.config = null;
  state.latest = null;
  showLoggedIn(false);
  if (state.recentTimer) clearInterval(state.recentTimer);
  els.recentList.innerHTML = '<div class="empty-state">登录后加载文件列表。</div>';
}

async function restoreSession() {
  try {
    await loadConfig();
    showLoggedIn(true);
    await loadRecent();
  } catch (error) {
    if (error.status !== 401) setLoginMessage(error.message);
    showLoggedIn(false);
  }
}

async function loadPublicShare(token) {
  showPublicMode();
  try {
    const data = await api(`/share/${encodeURIComponent(token)}`);
    renderShareTarget(data.file, token, true);
  } catch (error) {
    renderShareError(error.message);
  }
}

els.loginForm.addEventListener('submit', login);
els.logout.addEventListener('click', logout);
els.uploadButton.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => {
  const file = els.fileInput.files?.[0];
  if (file) startUpload(file);
});
els.cancelUpload.addEventListener('click', cancelActiveTransfer);
els.resolveButton.addEventListener('click', resolvePickup);
els.pickupInput.addEventListener('keydown', event => { if (event.key === 'Enter') resolvePickup(); });
els.pickupInput.addEventListener('paste', () => {
  setTimeout(() => {
    if (/\/transfer\/f\//.test(els.pickupInput.value)) resolvePickup();
  }, 0);
});
els.refreshButton.addEventListener('click', loadRecent);
els.copyCodeButton.addEventListener('click', async () => {
  if (!state.latest?.code) return;
  showToast(await copyText(state.latest.code) ? '取件码已复制' : '复制失败，请手动选择取件码', 'normal');
});
els.copyLinkButton.addEventListener('click', async () => {
  if (!state.latest?.shareUrl) return;
  showToast(await copyText(state.latest.shareUrl) ? '链接已复制' : '复制失败，请手动复制链接', 'normal');
});
els.recentList.addEventListener('click', async event => {
  const download = event.target.closest('[data-download-id]');
  if (download) await downloadById(download.dataset.downloadId, {
    name: download.dataset.downloadName,
    sizeBytes: Number(download.dataset.downloadSize) || 0,
  });
  const copy = event.target.closest('[data-copy-share]');
  if (copy) showToast(await copyText(copy.dataset.copyShare) ? '链接已复制' : '复制失败，请手动复制链接');
});
els.shareTarget.addEventListener('click', async event => {
  const download = event.target.closest('[data-share-download]');
  if (download) await downloadShare(download.dataset.shareDownload, {
    name: download.dataset.downloadName,
    sizeBytes: Number(download.dataset.downloadSize) || 0,
  });
  if (event.target.closest('[data-go-home]')) window.location.assign('/transfer/');
});

state.countdownTimer = setInterval(updateCountdowns, 1000);
state.recentTimer = setInterval(() => { if (state.loggedIn) loadRecent(); }, 15000);

const publicMatch = window.location.pathname.match(/^\/transfer\/f\/([^/]+)$/);
if (publicMatch) loadPublicShare(publicMatch[1]);
else restoreSession();
