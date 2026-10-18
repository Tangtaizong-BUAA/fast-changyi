export function downloadLifetime(fileExpiresAt, credentialsExpireAt, timestamp = Date.now()) {
  // Keep signatures inside the lifetime of the STS credentials that sign them.
  const end = Math.min(timestamp + 600_000, credentialsExpireAt - 60_000,
    fileExpiresAt == null ? Infinity : Number(fileExpiresAt));
  const seconds = Math.floor((end - timestamp) / 1000);
  if (!Number.isFinite(seconds) || seconds < 1) throw new Error('DOWNLOAD_AUTH_EXPIRED');
  return seconds;
}
