import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { downloadRanges } from '../public/download.js';
import { downloadLifetime } from '../download-grant.mjs';
import { expirationAttribute, remainingAt } from '../public/expiration.js';

function sink(size) {
  const bytes = Buffer.alloc(size);
  return { bytes, writes: [], closed: false, aborted: false,
    async write({position, data}) { assert.equal(this.aborted, false); this.writes.push([position, data.byteLength]); bytes.set(data, position); },
    async truncate(length) { assert.equal(length, size); },
    async close() { this.closed = true; },
    async abort() { this.aborted = true; },
  };
}
const grant = (size = 8) => ({ url: 'https://fixture.invalid/old', sizeBytes: size, etag: 'fixture-etag', urlExpiresAt: Date.now() + 600_000 });
function response(start, end, total, body = Buffer.alloc(end-start+1, 7), extra = {}) {
  return new Response(body, { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${total}`, 'content-length': String(end-start+1), etag: '"fixture-etag"', ...extra } });
}
const options = (writable, extra = {}) => ({ grant: grant(writable.bytes.length), refreshGrant: async () => grant(writable.bytes.length), writable,
  signal: new AbortController().signal, retryDelayMs: 0, ...extra });

test('null permanent, zero expired, malformed unknown and future visible', () => {
  assert.equal(expirationAttribute(null), '');
  assert.equal(remainingAt(null, 10), null);
  assert.equal(remainingAt('', 10), null);
  assert.equal(remainingAt('0', 10), 0);
  assert.equal(remainingAt('broken', 10), undefined);
  assert.equal(remainingAt(11, 10), 1);
});

test('signature lifetime respects file expiry and credential expiry', () => {
  assert.equal(downloadLifetime(null, 2_000_000, 1_000_000), 600);
  assert.equal(downloadLifetime(null, 1_120_000, 1_000_000), 60);
  assert.equal(downloadLifetime(1_015_000, 2_000_000, 1_000_000), 15);
  assert.throws(() => downloadLifetime(null, 1_060_000, 1_000_000), /DOWNLOAD_AUTH_EXPIRED/);
  assert.throws(() => downloadLifetime(999_999, 2_000_000, 1_000_000), /DOWNLOAD_AUTH_EXPIRED/);
});

test('truncated response resumes from last committed byte; progress never double counts', async () => {
  const writable = sink(8); const ranges = []; const progress = [];
  await downloadRanges(options(writable, { fetchImpl: async (url, {headers}) => {
    ranges.push(headers.Range);
    if (ranges.length === 1) return response(0, 7, 8, Buffer.alloc(3, 7));
    return response(3, 7, 8);
  }, onProgress: value => progress.push(value) }));
  assert.deepEqual(ranges, ['bytes=0-7', 'bytes=3-7']);
  assert.deepEqual(progress, [3, 8]);
  assert.deepEqual(writable.bytes, Buffer.alloc(8, 7));
  assert.equal(writable.closed, true);
});

test('broken body retries suffix using renewed URL', async () => {
  const writable = sink(8); const calls = [];
  await downloadRanges(options(writable, { refreshGrant: async () => ({...grant(), url: 'https://fixture.invalid/fresh'}), fetchImpl: async (url, {headers}) => {
    calls.push([url, headers.Range]);
    if (calls.length === 1) {
      let pulls = 0;
      return response(0, 7, 8, new ReadableStream({ pull(c) { if (pulls++ === 0) c.enqueue(new Uint8Array(3).fill(7)); else c.error(new TypeError('network interrupted')); } }));
    }
    return response(3, 7, 8);
  } }));
  assert.deepEqual(calls.map(c => c[1]), ['bytes=0-7', 'bytes=3-7']);
  assert.match(calls[1][0], /fresh$/);
  assert.equal(writable.closed, true);
});

for (const [name, headers, code] of [
  ['wrong offset', {'content-range':'bytes 1-8/8'}, 'RANGE_MISMATCH'],
  ['wrong size', {'content-range':'bytes 0-7/9'}, 'RANGE_MISMATCH'],
  ['missing CORS range header', {'content-range':''}, 'RANGE_MISMATCH'],
  ['changed ETag', {etag:'"other"'}, 'OBJECT_CHANGED'],
  ['wrong length', {'content-length':'9'}, 'RANGE_LENGTH_MISMATCH'],
]) test(`rejects ${name} before writing`, async () => {
  const writable = sink(8);
  await assert.rejects(downloadRanges(options(writable, { fetchImpl: async () => response(0,7,8,undefined,headers) })), {code});
  assert.equal(writable.writes.length, 0);
  assert.equal(writable.closed, false);
  assert.equal(writable.aborted, true);
});

test('overflow never writes outside a range', async () => {
  const writable = sink(8);
  await assert.rejects(downloadRanges(options(writable, {fetchImpl: async () => response(0,7,8,Buffer.alloc(9))})), {code:'RANGE_OVERFLOW'});
  assert.equal(writable.writes.length, 0);
});

test('HTTP 403 refreshes authorization; changed-object HTTP 412 does not retry', async () => {
  const writable = sink(8); let calls = 0; let refreshes = 0;
  await downloadRanges(options(writable, {refreshGrant: async () => {refreshes++; return grant();}, fetchImpl: async () => ++calls === 1 ? new Response('', {status:403}) : response(0,7,8)}));
  assert.equal(refreshes, 1);
  const second = sink(8); let requests = 0;
  await assert.rejects(downloadRanges(options(second, {fetchImpl:async () => {requests++; return new Response('',{status:412});}})), {code:'OBJECT_CHANGED'});
  assert.equal(requests,1);
});

test('persistent 503 retries only four times', async () => {
  const writable = sink(8); let requests = 0;
  await assert.rejects(downloadRanges(options(writable, {fetchImpl:async () => {requests++; return new Response('',{status:503});}})), {code:'RANGE_HTTP_503'});
  assert.equal(requests,4);
  assert.equal(writable.closed,false);
});

test('stalled connection times out and stops after bounded retries', async () => {
  const writable = sink(8); let requests = 0;
  await assert.rejects(downloadRanges(options(writable, {idleTimeoutMs:5, attempts:2, fetchImpl: async (_url,{signal}) => {
    requests++; return new Promise((_resolve,reject) => signal.addEventListener('abort', () => reject(signal.reason), {once:true}));
  }})), {code:'DOWNLOAD_TIMEOUT'});
  assert.equal(requests,2);
});

test('stalled body times out, cancels reader and retries', async () => {
  const writable = sink(8); let calls = 0; let cancels = 0;
  await downloadRanges(options(writable, {idleTimeoutMs:5, fetchImpl:async (_url,{signal}) => {
    if (++calls > 1) return response(0,7,8);
    let streamController;
    signal.addEventListener('abort', () => streamController.error(signal.reason), {once:true});
    return response(0,7,8,new ReadableStream({start(c){streamController=c;},cancel(){cancels++;}}));
  }}));
  assert.equal(calls,2);
  assert.equal(writable.closed,true);
});

test('fatal range error drains concurrent peers before aborting sink', async () => {
  const writable = sink(8); let active = 0; let stopped = false;
  writable.abort = async () => {assert.equal(active,0); writable.aborted=true;};
  await assert.rejects(downloadRanges(options(writable, {chunkSize:4, parallel:2, fetchImpl:async (_url,{headers,signal}) => {
    if(headers.Range==='bytes=0-3') {await new Promise(r=>setTimeout(r,5)); return response(1,4,8);}
    active++;
    return new Promise((_resolve,reject) => signal.addEventListener('abort',()=>{active--;stopped=true;reject(signal.reason);},{once:true}));
  }})), {code:'RANGE_MISMATCH'});
  assert.equal(stopped,true);
  assert.equal(writable.aborted,true);
});

test('cancel drains all workers, aborts file and never commits', async () => {
  const writable = sink(8); const controller = new AbortController();
  const promise=downloadRanges(options(writable,{signal:controller.signal,fetchImpl:async (_url,{signal}) => new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))}));
  controller.abort();
  await assert.rejects(promise,{name:'AbortError'});
  assert.equal(writable.closed,false);
  assert.equal(writable.aborted,true);
});

test('disk error does not retry network', async () => {
  const writable = sink(8); let calls=0;
  writable.write=async()=>{throw new Error('disk full');};
  await assert.rejects(downloadRanges(options(writable,{fetchImpl:async()=>{calls++;return response(0,7,8);}})),{code:'DISK_WRITE_FAILED'});
  assert.equal(calls,1);
});

test('refresh detects object change; expired initial grant renews before first request', async () => {
  const writable = sink(8); let fetchedUrl;
  await downloadRanges(options(writable,{grant:{...grant(),urlExpiresAt:Date.now()-1}, refreshGrant:async()=>({...grant(),url:'https://fixture.invalid/fresh'}),fetchImpl:async url=>{fetchedUrl=url;return response(0,7,8);}}));
  assert.match(fetchedUrl,/fresh$/);
  const other=sink(8);
  await assert.rejects(downloadRanges(options(other,{grant:{...grant(),urlExpiresAt:0},refreshGrant:async()=>({...grant(),etag:'changed'})})),{code:'OBJECT_CHANGED'});
});

test('real HTTP range stream reconstructs 2 MiB exactly across parallel writes', async () => {
  const total=2*1024*1024+133; const source=Buffer.alloc(total);
  for(let i=0;i<total;i++)source[i]=(i*17+13)%251;
  let active=0;let peak=0;
  const server=createServer((req,res)=>{
    const [,startValue,endValue]=req.headers.range.match(/bytes=(\d+)-(\d+)/);
    const start=Number(startValue),end=Number(endValue);
    assert.equal(req.headers['if-match'],'"fixture-etag"');
    active++;peak=Math.max(peak,active);
    res.writeHead(206,{'content-range':`bytes ${start}-${end}/${total}`,'content-length':end-start+1,etag:'"fixture-etag"'});
    setTimeout(()=>{res.end(source.subarray(start,end+1));active--;},5);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const url=`http://127.0.0.1:${server.address().port}/object`;
    const writable=sink(total);
    await downloadRanges(options(writable,{grant:{...grant(total),url},chunkSize:128*1024,parallel:4}));
    assert.equal(createHash('sha256').update(writable.bytes).digest('hex'),createHash('sha256').update(source).digest('hex'));
    assert.equal(writable.closed,true);assert.ok(peak>1);
  } finally {await new Promise(resolve=>server.close(resolve));}
});
