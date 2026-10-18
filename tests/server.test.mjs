import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

test('real service: null expiry, versioned modules, public access and coherent download grants', async () => {
  const dataDir=await mkdtemp(join(tmpdir(),'transfer-regression-'));
  const secret='test-only-share-secret';
  const child=spawn(process.execPath,['server.mjs'],{cwd:process.env.TRANSFER_TEST_ROOT || fileURLToPath(new URL('..',import.meta.url)),env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dataDir,NODE_ENV:'development',SHARE_SECRET:secret,OSS_BUCKET:'fixture-bucket',TRANSFER_ACCESS_CODE_HASH:'',ALIYUN_ACCESS_KEY_ID:'test-only-id',ALIYUN_ACCESS_KEY_SECRET:'test-only-secret',ALIYUN_SECURITY_TOKEN:''},stdio:['ignore','pipe','pipe']});
  let db;
  try {
    const port=await new Promise((resolve,reject)=>{
      let output='';const timer=setTimeout(()=>reject(Error('service startup timeout')),10000);
      child.stdout.on('data',data=>{output+=data;const match=output.match(/listening on 127\.0\.0\.1:(\d+)/);if(match){clearTimeout(timer);resolve(Number(match[1]));}});
      child.once('exit',code=>{clearTimeout(timer);reject(Error(`service exited ${code}`));});
    });
    const base=`http://127.0.0.1:${port}/transfer`;
    const id='regression-file';
    const token=createHmac('sha256',secret).update(`share:${id}`).digest('base64url');
    const shareHash=createHmac('sha256',secret).update(`share-token:${token}`).digest('hex');
    db=new DatabaseSync(join(dataDir,'transfer.sqlite'));
    db.prepare(`INSERT INTO files(id,object_key,original_name,content_type,size_bytes,etag,status,share_token_hash,pickup_code_hash,created_at,completed_at,expires_at) VALUES(?,?,?,?,?,?,'AVAILABLE',?,?,?,?,NULL)`).run(id,'transfer/v1/test/payload','回归测试.txt','text/plain',8,'fixture-etag',shareHash,'test-pickup-hash',Date.now(),Date.now());
    const metadata=await (await fetch(`${base}/api/share/${token}`)).json();
    assert.equal(metadata.file.expiresAt,null);assert.equal(metadata.file.remainingSeconds,null);
    const response=await fetch(`${base}/api/share/${token}/download`,{method:'POST',body:JSON.stringify({direct:true})});
    assert.equal(response.status,200);
    const grant=await response.json();
    assert.equal(grant.nativeUrl,`/transfer/api/share/${token}/content`);
    const stable=await fetch(`http://127.0.0.1:${port}${grant.nativeUrl}`,{method:'HEAD',headers:{Range:'bytes=4-7'}});
    assert.equal(stable.status,200);assert.equal(stable.headers.get('content-length'),'8');assert.equal(stable.headers.get('accept-ranges'),'bytes');
    const nativeOnly=await (await fetch(`${base}/api/share/${token}/download`,{method:'POST',body:JSON.stringify({native:true})})).json();
    assert.equal(nativeOnly.url,undefined);assert.equal(nativeOnly.nativeUrl,grant.nativeUrl);
    const legacy=await (await fetch(`${base}/api/share/${token}/download`,{method:'POST',body:'{}'})).json();
    assert.equal(legacy.url,grant.nativeUrl);assert.equal(legacy.urlExpiresAt,null);
    const invalidRange=await fetch(`http://127.0.0.1:${port}${grant.nativeUrl}`,{headers:{Range:'bytes=8-'}});
    assert.equal(invalidRange.status,416);assert.equal(invalidRange.headers.get('content-range'),'bytes */8');
    assert.equal((await fetch(`${base}/api/share/invalid/content`)).status,404);
    assert.equal(grant.sizeBytes,8);assert.equal(grant.etag,'fixture-etag');assert.equal(grant.expiresAt,null);
    assert.ok(grant.urlExpiresAt>Date.now()+500000);
    const signed=new URL(grant.url);
    assert.equal(signed.searchParams.get('response-content-type'),null);
    assert.ok(signed.searchParams.get('response-content-disposition').includes(encodeURIComponent('回归测试.txt')));
    assert.ok(Math.abs(Number(signed.searchParams.get('Expires'))*1000-grant.urlExpiresAt)<1100);
    assert.equal((await fetch(`${base}/api/files/${id}/download`,{method:'POST'})).status,200);
    assert.equal((await fetch(`${base}/api/share/invalid/download`,{method:'POST'})).status,404);
    const login=await fetch(`${base}/api/auth/login`,{method:'POST',body:JSON.stringify({code:'local-dev-only'})});
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const byId=await fetch(`${base}/api/files/${id}/download`,{method:'POST',headers:{cookie}});
    assert.equal(byId.status,200);assert.equal((await byId.json()).sizeBytes,8);
    db.prepare('UPDATE files SET expires_at=? WHERE id=?').run(Date.now()-1000,id);
    assert.equal((await fetch(`${base}/api/share/${token}/download`,{method:'POST'})).status,404);
    const index=await (await fetch(`${base}/`)).text();assert.match(index,/app\.js\?v=20261009-3/);
    assert.match(index,/<section id="app-panel" hidden>/);
    assert.ok(index.indexOf('id="upload-progress"')<index.indexOf('class="control-card"'));
    for(const path of ['download.js','expiration.js']) {
      const response=await fetch(`${base}/${path}?v=20261009-3`);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/javascript/);
    }
  } finally {
    db?.close();
    if(child.exitCode===null && child.signalCode===null) {
      const exited=once(child,'exit');child.kill('SIGTERM');await exited;
    }
    await rm(dataDir,{recursive:true,force:true});
  }
});
