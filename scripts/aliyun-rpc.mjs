import { createHmac, randomUUID } from 'node:crypto';

const accessKeyId = process.env.ALIYUN_ACCESS_KEY_ID;
const accessKeySecret = process.env.ALIYUN_ACCESS_KEY_SECRET;
if (!accessKeyId || !accessKeySecret) throw new Error('ALIYUN_ACCESS_KEY_ID/SECRET are required');

function encode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function timestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function call(service, action, input) {
  const isEcs = service === 'ecs';
  const endpoint = isEcs ? 'https://ecs.cn-beijing.aliyuncs.com/' : 'https://ram.aliyuncs.com/';
  const version = isEcs ? '2014-05-26' : '2015-05-01';
  const params = {
    AccessKeyId: accessKeyId,
    Action: action,
    Format: 'JSON',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: randomUUID(),
    SignatureVersion: '1.0',
    SignatureType: '',
    Timestamp: timestamp(),
    Version: version,
    ...input,
  };
  if (!params.SignatureType) delete params.SignatureType;
  const canonical = Object.keys(params).sort().map(key => `${encode(key)}=${encode(params[key])}`).join('&');
  const stringToSign = `GET&%2F&${encode(canonical)}`;
  params.Signature = createHmac('sha1', `${accessKeySecret}&`).update(stringToSign).digest('base64');
  const query = Object.keys(params).sort().map(key => `${encode(key)}=${encode(params[key])}`).join('&');
  const response = await fetch(`${endpoint}?${query}`, { signal: AbortSignal.timeout(20_000) });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok || data.Code) {
    const error = new Error(`${data.Code || response.status}: ${data.Message || text}`);
    error.data = data;
    throw error;
  }
  return data;
}

const [, , service, action, inputText = '{}'] = process.argv;
if (!service || !action) throw new Error('Usage: node scripts/aliyun-rpc.mjs <ram|ecs> <Action> <json-input>');
const result = await call(service, action, JSON.parse(inputText));
console.log(JSON.stringify(result, null, 2));
