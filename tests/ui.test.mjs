import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expirationAttribute, remainingAt } from '../public/expiration.js';

const fixtureTimers = new Set();
test.afterEach(() => {
  for (const timer of fixtureTimers) clearTimeout(timer);
  fixtureTimers.clear();
});

const appSource = (await readFile(join(process.env.TRANSFER_TEST_ROOT || fileURLToPath(new URL('..',import.meta.url)), 'public/app.js'),'utf8')).replace(/^import .*;\n/gm,'').split("els.loginForm.addEventListener")[0];
function fixture(extra={}) {
  const nodes=new Map();const attrs=[];const navigations=[];const timers=[];
  const node=()=>({textContent:'',hidden:false,disabled:false,dataset:{},style:{},classList:{remove(){},toggle(){}},addEventListener(){},matches(){return true;},closest(){return true;}});
  const document={querySelector(selector){if(!nodes.has(selector))nodes.set(selector,node());return nodes.get(selector);},querySelectorAll(){return attrs;},createElement(){const n=node();Object.defineProperty(n,'innerHTML',{get(){return String(n.textContent).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');}});return n;}};
  const context=createContext({document,navigator:{hardwareConcurrency:8,userAgent:'test'},window:{location:{origin:'https://fixture.invalid',assign:v=>navigations.push(v)}},performance,AbortController,Headers,FormData,TypeError,console,expirationAttribute,remainingAt,
    setTimeout:(fn,ms)=>{const t=setTimeout(fn,ms);fixtureTimers.add(t);timers.push(t);return t;},clearTimeout,
    fetch:async()=>Response.json({url:'https://fixture.invalid/fresh',nativeUrl:'/transfer/api/share/token/content',sizeBytes:8,etag:'fixture',urlExpiresAt:Date.now()+600000}),
    downloadRanges:async()=>{},...extra});
  runInContext(appSource+'\nglobalThis.app={state,els,runDownload,renderRecent,renderResult,renderShareTarget,updateCountdowns,cancelActiveTransfer};',context);
  attrs.push(context.app.els.resultCountdown);
  return {app:context.app,nodes,attrs,navigations,timers,context};
}

test('all three UI paths retain null as permanent through countdown ticks',()=>{
  const {app,attrs}=fixture();const file={id:'id',name:'test',sizeBytes:8,expiresAt:null,remainingSeconds:null};
  app.renderResult(file,'CODE','https://fixture.invalid/share');
  assert.equal(app.els.resultCountdown.textContent,'永久保留');
  app.renderRecent([file]);app.renderShareTarget(file,'token');
  assert.match(app.els.recentList.innerHTML,/data-expires=""/);
  assert.match(app.els.shareTarget.innerHTML,/data-expires=""/);
  const legacy={dataset:{expires:'0'},textContent:'',classList:{remove(){},toggle(){}},matches(){return true;}};
  attrs.push(legacy);app.updateCountdowns();app.updateCountdowns();
  assert.equal(app.els.resultCountdown.textContent,'永久保留');
  assert.equal(legacy.textContent,'已过期');
});

test('authorization waits for picker; duplicate clicks do not start another task',async()=>{
  let resolvePicker;let pickerCalls=0;let requests=0;const events=[];
  const writable={async abort(){},async close(){},async write(){}};
  const f=fixture({fetch:async()=>{requests++;events.push('authorize');return Response.json({url:'https://fixture.invalid/fresh',nativeUrl:'/transfer/api/share/token/content',sizeBytes:8});}});
  f.context.window.showSaveFilePicker=()=>{pickerCalls++;events.push('picker');return new Promise(resolve=>{resolvePicker=resolve;});};
  const pending=f.app.runDownload('/share/token/download',{name:'file'});
  await f.app.runDownload('/share/token/download',{name:'file'});
  assert.equal(pickerCalls,1);assert.equal(requests,0);
  resolvePicker({async createWritable(){events.push('sink');return writable;}});
  await pending;
  assert.deepEqual(events,['picker','sink','authorize']);
  assert.equal(f.app.state.currentDownload,null);
  assert.equal(f.app.els.uploadButton.disabled,false);
});

test('picker cancel sends no authorization and releases task',async()=>{
  let requests=0;
  const f=fixture({fetch:async()=>{requests++;throw Error('unexpected');}});
  f.context.window.showSaveFilePicker=async()=>{throw new DOMException('cancel','AbortError');};
  await f.app.runDownload('/share/token/download',{name:'file'});
  assert.equal(requests,0);assert.equal(f.app.state.currentDownload,null);assert.equal(f.app.els.uploadProgress.hidden,true);
});

test('range fallback requests native authorization and never navigates to a signed URL',async()=>{
  let requests=0;const bodies=[];
  const f=fixture({fetch:async(_url,options)=>{bodies.push(JSON.parse(options.body));return Response.json({url:`https://fixture.invalid/grant-${++requests}`,nativeUrl:'/transfer/api/share/token/content',sizeBytes:8});},downloadRanges:async()=>{const error=Error('bad range');error.code='RANGE_MISMATCH';throw error;}});
  f.context.window.showSaveFilePicker=async()=>({async createWritable(){return {async abort(){}};}});
  await f.app.runDownload('/share/token/download',{name:'file'});
  assert.deepEqual(f.navigations,['/transfer/api/share/token/content']);
  assert.deepEqual(bodies,[{native:false,direct:true},{native:true,direct:false}]);
});

for(const code of ['OBJECT_CHANGED','DISK_WRITE_FAILED'])test(`${code} cannot silently start ordinary download`,async()=>{
  const f=fixture({downloadRanges:async()=>{const error=Error(code);error.code=code;throw error;}});
  f.context.window.showSaveFilePicker=async()=>({async createWritable(){return {async abort(){}};}});
  await f.app.runDownload('/share/token/download',{name:'file'});
  assert.equal(f.navigations.length,0);
});

test('cancel during pending picker keeps lock until dialog is settled',async()=>{
  let resolvePicker;let requests=0;let aborted=0;
  const f=fixture({fetch:async()=>{requests++;throw Error('unexpected');}});
  f.context.window.showSaveFilePicker=()=>new Promise(resolve=>{resolvePicker=resolve;});
  const pending=f.app.runDownload('/share/token/download',{name:'file'});
  await f.app.cancelActiveTransfer();
  assert.ok(f.app.state.currentDownload);
  resolvePicker({async createWritable(){return {async abort(){aborted++;}};}});
  await pending;
  assert.equal(requests,0);assert.equal(aborted,1);assert.equal(f.app.state.currentDownload,null);
});

test('temporary authorization failure retries; missing file never retries',async()=>{
  let calls=0;
  const f=fixture({fetch:async()=>++calls===1?Response.json({message:'temporary'},{status:503}):Response.json({url:'https://fixture.invalid/fresh',nativeUrl:'/transfer/api/share/token/content',sizeBytes:8})});
  await f.app.runDownload('/share/token/download',{name:'file'});
  assert.equal(calls,2);assert.deepEqual(f.navigations,['/transfer/api/share/token/content']);
  let missingCalls=0;
  const missing=fixture({fetch:async()=>{missingCalls++;return Response.json({error:'FILE_NOT_FOUND',message:'missing'},{status:404});}});
  await missing.app.runDownload('/share/token/download',{name:'file'});
  assert.equal(missingCalls,1);assert.equal(missing.navigations.length,0);
});

for (const name of ['NotAllowedError','SecurityError','NotSupportedError']) test(`createWritable ${name} falls back to fresh native download`,async()=>{
  let requests=0;let rangeCalls=0;
  const f=fixture({fetch:async()=>{requests++;return Response.json({url:'https://fixture.invalid/fresh',nativeUrl:'/transfer/api/share/token/content',sizeBytes:8});},downloadRanges:async()=>{rangeCalls++;}});
  f.context.window.showSaveFilePicker=async()=>({async createWritable(){throw new DOMException("Failed to execute 'createWritable' on 'FileSystemFileHandle': The request is not allowed by the user agent or the platform in the current context.",name);}});
  await f.app.runDownload('/share/token/download',{name:'file'});
  assert.equal(requests,1);assert.equal(rangeCalls,0);
  assert.deepEqual(f.navigations,['/transfer/api/share/token/content']);
  assert.match(f.app.els.toast.textContent,/已切换浏览器下载/);
  assert.equal(f.app.state.currentDownload,null);
});

test('picker synchronous SecurityError and missing writer also use native download',async()=>{
  const f=fixture();f.context.window.showSaveFilePicker=()=>{throw new DOMException('unsupported context','SecurityError');};
  await f.app.runDownload('/share/token/download',{name:'file'});
  assert.deepEqual(f.navigations,['/transfer/api/share/token/content']);
  const second=fixture();second.context.window.showSaveFilePicker=async()=>({});
  await second.app.runDownload('/share/token/download',{name:'file'});
  assert.deepEqual(second.navigations,['/transfer/api/share/token/content']);
});

test('createWritable disk full is displayed and does not launch another download',async()=>{
  let requests=0;
  const f=fixture({fetch:async()=>{requests++;throw Error('unexpected');}});
  f.context.window.showSaveFilePicker=async()=>({async createWritable(){throw new DOMException('disk full','QuotaExceededError');}});
  await f.app.runDownload('/share/token/download',{name:'file'});
  assert.equal(requests,0);assert.equal(f.navigations.length,0);
  assert.match(f.app.els.toast.textContent,/磁盘空间不足/);
});


test('native authorization needs no cloud signature and rejects unsafe fallback addresses',async()=>{
  const f=fixture({fetch:async()=>Response.json({nativeUrl:'/transfer/api/share/token/content',sizeBytes:8})});
  await f.app.runDownload('/share/token/download',{name:'file'});
  assert.deepEqual(f.navigations,['/transfer/api/share/token/content']);
  for (const nativeUrl of [undefined,'https://fixture.invalid/expired-signature','//other.invalid/file','/transfer/api/share/token/content?Expires=1']) {
    const invalid=fixture({fetch:async()=>Response.json({url:'https://fixture.invalid/expired',nativeUrl,sizeBytes:8})});
    await invalid.app.runDownload('/share/token/download',{name:'file'});
    assert.equal(invalid.navigations.length,0);
    assert.match(invalid.app.els.toast.textContent,/刷新页面/);
  }
});
