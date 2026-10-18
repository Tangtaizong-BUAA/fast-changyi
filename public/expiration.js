// null is permanent; zero is an actual timestamp, never a missing value.
export function expirationAttribute(value) {
  return value == null ? '' : String(value);
}

export function remainingAt(value, timestamp = Date.now()) {
  if (value == null || String(value).trim() === '') return null;
  const expires = Number(value);
  return Number.isFinite(expires) ? Math.max(0, Math.ceil((expires - timestamp) / 1000)) : undefined;
}
