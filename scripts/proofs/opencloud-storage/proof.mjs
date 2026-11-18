// Synthetic integration proof; never connects to the Quantself application/database.
import {chromium} from 'playwright';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import assert from 'node:assert/strict';
const dir=new URL('.',import.meta.url).pathname;
const base='https://localhost:19200';
const project=process.env.PROOF_PROJECT;
assert(project?.startsWith('qs-storage-proof-'),'Use run.sh to allocate an isolated project');
const compose=['compose','-p',project,'-f',dir+'compose.yaml'];
const docker=(args,input)=>execFileSync('docker',args,{input,encoding:'utf8',stdio:['pipe','pipe','pipe']});
const sql=s=>docker([...compose,'exec','-T','postgres','psql','-U','postgres','-d','storage_proof','-v','ON_ERROR_STOP=1','-At'],s);
const q=s=>"'"+String(s).replaceAll("'","''")+"'";
const hash=b=>createHash('sha256').update(b).digest('hex');
const report={startedAt:new Date().toISOString(),checks:[],requests:[],files:[],limitations:['Synthetic proof harness, not the Quantself application','Mac Docker, not Keep VMs; local timings only','Self-signed localhost TLS; verification bypass limited to this proof']};
function pass(name,details={}){report.checks.push({name,...details});writeFileSync(dir+'results.json',JSON.stringify(report,null,2));console.log('PASS',name,JSON.stringify(details));}
const browser=await chromium.launch({headless:true});
const contexts=[];
let server;
async function login(name,password){
 const c=await browser.newContext({ignoreHTTPSErrors:true}); contexts.push(c);
 const p=await c.newPage(); let token;
 p.on('response',async r=>{if(r.url().includes('/konnect/v1/token')&&r.status()===200)token=(await r.json()).access_token;});
 await p.goto(base); await p.locator('#oc-login-username').fill(name); await p.locator('#oc-login-password').fill(password);
 await p.getByRole('button',{name:'Log in',exact:true}).click(); await p.waitForURL('**/files/**');
 assert(token); return {c,p,token};
}
async function req(auth,method,path,body,headers={}){
 const start=performance.now();
 const r=await (auth?.c??contexts[0]).request.fetch(path.startsWith('http')?path:base+path,{method,data:body,headers:{...(auth?{Authorization:auth.authorization??('Bearer '+auth.token)}:{}),...headers},timeout:30000});
 report.requests.push({method,path:path.replace(base,'').replace(/token=[^&]+/g,'token=REDACTED'),status:r.status(),ms:Math.round((performance.now()-start)*10)/10});return r;
}
async function json(auth,method,path,body,expected=200){const r=await req(auth,method,path,body,{'Content-Type':'application/json'});if(r.status()!==expected)throw Error(`${method} ${path}: ${r.status()} ${await r.text()}`);return r.json();}
try {
const admin=await login('admin',readFileSync(dir+'.env','utf8').trim().split('=')[1]);
pass('OIDC browser authentication; password Basic auth disabled');
const suffix=Date.now().toString(36);
const identities={};
for(const role of ['app','owner','outsider']){
 const name='proof-'+role+'-'+suffix,password=randomBytes(24).toString('base64url');
 const u=await json(admin,'POST','/graph/v1.0/users',{displayName:'Proof '+role,onPremisesSamAccountName:name,mail:name+'@example.invalid',passwordProfile:{password}},201);
 identities[role]={...await login(name,password),id:u.id,name};
}
const app=identities.app, owner=identities.owner, outsider=identities.outsider;
const space=await json(admin,'POST','/graph/v1.0/drives',{name:'Quantself proof '+suffix,driveType:'project',quota:{total:1073741824}},201);
const root=space.root.webDavUrl;
const permissions=await json(admin,'GET',`/graph/v1beta1/drives/${space.id}/root/permissions`);
const roles=permissions['@libre.graph.permissions.roles.allowedValues'];

for(const [identity,role] of [[app,roles.find(r=>r.displayName==='Can edit').id],[owner,roles.find(r=>r.displayName==='Can view').id]]){
 await json(admin,'POST',`/graph/v1beta1/drives/${space.id}/root/invite`,{recipients:[{objectId:identity.id,'@libre.graph.recipient.type':'user'}],roles:[role]},200);
}
pass('Dedicated original-files space; application Editor and Owner Viewer');
const appToken=await json(app,'POST','/auth-app/tokens?expiry=1h&label=storage-proof');
assert(appToken.token);
app.authorization='Basic '+Buffer.from(app.name+':'+appToken.token).toString('base64');
pass('Application uses expiring app token; account password Basic authentication remains disabled');
const personal=(await json(owner,'GET','/graph/v1.0/me/drives')).value.find(d=>d.driveType==='personal');
const sentinel=personal.root.webDavUrl+'/private-document.txt';
assert.equal((await req(owner,'PUT',sentinel,Buffer.from('Synthetic private document'))).status(),201);
assert([403,404].includes((await req(app,'GET',sentinel)).status()));
assert([401,403,404].includes((await req(null,'GET',root)).status()));
assert([403,404].includes((await req(outsider,'PROPFIND',root,undefined,{Depth:'1'})).status()));
pass('Application cannot read personal documents; anonymous/outsider cannot access originals');
for(const folder of ['Receipts','Recordings','Pending'])assert.equal((await req(app,'MKCOL',root+'/'+folder)).status(),201);
const receiptPage=await owner.c.newPage();
await receiptPage.setContent('<html><body style="font:20px monospace;padding:30px;background:white"><h1>TEST RECEIPT — SYNTHETIC</h1><p>Storage proof shop</p><p>2026-11-13</p><p>Notebook: CAD 10.00</p><p>Tax: CAD 1.50</p><h2>Total: CAD 11.50</h2><p>No real purchase or personal information.</p></body></html>');
await receiptPage.screenshot({path:dir+'receipt.png'});await receiptPage.close();
execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','sine=frequency=440:duration=8','-c:a','libopus',dir+'recording.webm']);
sql('CREATE TABLE IF NOT EXISTS proof_original (id text PRIMARY KEY, kind text, space_id text, file_id text, path text, mime text, bytes bigint, sha256 text, state text, details jsonb); TRUNCATE proof_original;');
for(const [kind,path,mime,details] of [['receipt','Receipts/receipt.png','image/png',{totalCents:1150,currency:'CAD'}],['recording','Recordings/recording.webm','audio/webm',{transcript:'Synthetic eight-second tone'}]]){
 const bytes=readFileSync(dir+(kind==='receipt'?'receipt.png':'recording.webm')),sha=hash(bytes);
 sql(`INSERT INTO proof_original VALUES (${q(kind)},${q(kind)},${q(space.id)},NULL,${q(path)},${q(mime)},${bytes.length},${q(sha)},'pending',${q(JSON.stringify(details))});`);
 const temporary=root+'/Pending/'+randomBytes(16).toString('hex');
 const r=await req(app,'PUT',temporary,bytes,{'Content-Type':mime});assert.equal(r.status(),201);
 assert.equal((await req(app,'MOVE',temporary,undefined,{Destination:root+'/'+path,Overwrite:'F'})).status(),201);
 // Simulate an ambiguous success: file exists but database still says pending.
 const retryTemporary=root+'/Pending/'+randomBytes(16).toString('hex');
 assert.equal((await req(app,'PUT',retryTemporary,bytes,{'Content-Type':mime})).status(),201);
 const retried=await req(app,'MOVE',retryTemporary,undefined,{Destination:root+'/'+path,Overwrite:'F'});assert.equal(retried.status(),412);
 assert.equal((await req(app,'DELETE',retryTemporary)).status(),204);
 const downloaded=await req(app,'GET',root+'/'+path);assert.equal(downloaded.status(),200);assert.equal(hash(await downloaded.body()),sha);
 const prop=await req(app,'PROPFIND',root+'/'+path,'<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><oc:fileid/><d:getetag/></d:prop></d:propfind>',{Depth:'0','Content-Type':'application/xml'});assert.equal(prop.status(),207);
 const xml=await prop.text(); const fileId=xml.match(/<(?:\w+:)?fileid[^>]*>([^<]+)</)?.[1]; assert(fileId,'file ID');
 sql(`UPDATE proof_original SET file_id=${q(fileId)},state='ready' WHERE id=${q(kind)};`);
 const denied=await req(owner,'PUT',root+'/'+path,Buffer.from('forbidden overwrite'));assert.equal(denied.status(),403);
 const del=await req(owner,'DELETE',root+'/'+path);assert.equal(del.status(),403);
 const ownRead=await req(owner,'GET',root+'/'+path);assert.equal(hash(await ownRead.body()),sha);
 report.files.push({kind,path,mime,bytes:bytes.length,sha256:sha,fileId});
 pass(kind+' uploaded, retry guarded, hash verified, Owner read-only',{bytes:bytes.length});
}
const listing=await req(owner,'PROPFIND',root+'/Receipts',undefined,{Depth:'1'});assert.equal(listing.status(),207);assert((await listing.text()).includes('receipt.png'));
const recListing=await req(owner,'PROPFIND',root+'/Recordings',undefined,{Depth:'1'});assert.equal(recListing.status(),207);assert((await recListing.text()).includes('recording.webm'));
pass('Both originals browsable by meaningful WebDAV filenames');
await owner.p.goto(space.webUrl);
await owner.p.getByText('Receipts',{exact:true}).first().waitFor();
await owner.p.getByText('Receipts',{exact:true}).first().dblclick();
await owner.p.getByText('receipt.png',{exact:true}).first().waitFor();
await owner.p.screenshot({path:dir+'opencloud-receipt.png'});
pass('Owner browses receipt folder in real OpenCloud web interface');
const audioUrl=root+'/Recordings/recording.webm';
const range=await req(app,'GET',audioUrl,undefined,{Range:'bytes=100-999'});assert.equal(range.status(),206);assert.equal((await range.body()).length,900);assert.deepEqual(await range.body(),readFileSync(dir+'recording.webm').subarray(100,1000));
pass('Audio byte ranges exact',{contentRange:range.headers()['content-range']});
const moved=root+'/Receipts/renamed-receipt.png';
assert.equal((await req(app,'MOVE',root+'/Receipts/receipt.png',undefined,{Destination:moved,Overwrite:'F'})).status(),201);
const renamed=await req(app,'PROPFIND',moved,'<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><oc:fileid/></d:prop></d:propfind>',{Depth:'0','Content-Type':'application/xml'});
assert((await renamed.text()).includes(report.files[0].fileId));
assert.equal((await req(app,'GET',root+'/Receipts/receipt.png')).status(),404);
const idUrl=base+'/dav/spaces/'+report.files[0].fileId;
const byId=await req(app,'GET',idUrl);assert.equal(byId.status(),200);assert.equal(hash(await byId.body()),report.files[0].sha256);
sql("UPDATE proof_original SET path='Receipts/renamed-receipt.png' WHERE id='receipt';");report.files[0].path='Receipts/renamed-receipt.png';
pass('Rename retains file ID; original retrievable by ID; stale path returns 404');
const mediaRequests=[];
// Minimal private proxy models server-side credential use and streams the upstream response.
const session=randomBytes(24).toString('hex');
server=http.createServer((incoming,outgoing)=>{
 if(incoming.headers.cookie!==`proof=${session}`){outgoing.writeHead(401).end();return;}
 if(incoming.url==='/'){outgoing.setHeader('Content-Type','text/html');outgoing.end('<audio id="audio" controls src="/audio"></audio><img id="receipt" src="/receipt">');return;}
 const target=incoming.url==='/audio'?audioUrl: incoming.url==='/receipt'?moved:null;
 if(!target){outgoing.writeHead(404).end();return;}
 mediaRequests.push({path:incoming.url,range:incoming.headers.range??null});
 const upstream=https.get(target,{rejectUnauthorized:false,headers:{Authorization:app.authorization,...(incoming.headers.range?{Range:incoming.headers.range}:{})}},r=>{outgoing.writeHead(r.statusCode,{...r.headers,'cache-control':'no-store'});r.pipe(outgoing);});
 upstream.on('error',()=>{outgoing.writeHead(502).end();}); incoming.on('aborted',()=>upstream.destroy());
});
await new Promise(resolve=>server.listen(19201,'127.0.0.1',resolve));
async function playback(){
 const mediaContext=await browser.newContext(); contexts.push(mediaContext);
 await mediaContext.addCookies([{name:'proof',value:session,url:'http://127.0.0.1:19201',httpOnly:true}]);
 const mediaPage=await mediaContext.newPage();
 await mediaPage.bringToFront();await mediaPage.goto('http://127.0.0.1:19201');
 await mediaPage.waitForFunction(()=>document.querySelector('#audio').readyState>=2&&document.querySelector('#receipt').naturalWidth>0);
 const result=await mediaPage.evaluate(async()=>{const a=document.querySelector('#audio');await a.play();await new Promise((resolve,reject)=>{const until=Date.now()+10000;const t=setInterval(()=>{if(a.currentTime>0){clearInterval(t);resolve();}else if(Date.now()>until){clearInterval(t);reject(Error('Audio clock did not advance: '+JSON.stringify({paused:a.paused,ready:a.readyState,error:a.error?.message})));}},50);});const before=a.currentTime;a.currentTime=5;await new Promise(r=>a.addEventListener('seeked',r,{once:true}));const after=a.currentTime;a.pause();return {duration:a.duration,before,after,imageWidth:document.querySelector('#receipt').naturalWidth};});
 assert(result.before>0);assert(result.after>=5);assert(result.duration>7.9);await mediaContext.close();return result;
}
pass('Chromium receipt rendering and audio playback/seeking through streaming proxy',await playback());
assert.equal((await contexts[0].request.get('http://127.0.0.1:19201/audio')).status(),401);
pass('Proof proxy rejects unauthenticated media access');
const before=report.requests.length;assert.equal(sql("SELECT count(*) FROM proof_original WHERE state='ready';").trim(),'2');assert.equal(report.requests.length,before);
pass('Record listing is PostgreSQL-only',{opencloudRequests:0,rows:2});
// Consistent backup: no writers; stop OpenCloud, dump PostgreSQL, preserve all xattrs/config/data.
docker([...compose,'stop','opencloud']);
mkdirSync(dir+'backup',{recursive:true});
writeFileSync(dir+'backup/database.sql',docker([...compose,'exec','-T','postgres','pg_dump','-U','postgres','--no-owner','--no-acl','storage_proof']));
// Debian GNU tar preserves xattrs; extraction goes into new, empty Docker volumes.
for(const v of ['config','data']){
 docker(['run','--rm','--user','0','--entrypoint','tar','-v',`${project}_${v}:/source:ro`,'-v',dir+'backup:/backup','debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc','--xattrs','--xattrs-include=*','--acls','--numeric-owner','-cpf','/backup/'+v+'.tar','-C','/source','.']);
 docker(['volume','create',project+'_restored-'+v]);
 docker(['run','--rm','--user','0','--entrypoint','tar','-v',`${project}_restored-${v}:/target`,'-v',dir+'backup:/backup:ro','debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc','--xattrs','--xattrs-include=*','--acls','--numeric-owner','-xpf','/backup/'+v+'.tar','-C','/target']);
}
writeFileSync(dir+'restore.yaml','services:\n  opencloud:\n    volumes:\n      - restored-config:/etc/opencloud\n      - restored-data:/var/lib/opencloud\nvolumes:\n  restored-config:\n  restored-data:\n');
docker([...compose,'-f',dir+'restore.yaml','up','-d','opencloud']);
sql('CREATE DATABASE storage_proof_restored;');
docker([...compose,'exec','-T','postgres','psql','-U','postgres','-d','storage_proof_restored','-v','ON_ERROR_STOP=1'],readFileSync(dir+'backup/database.sql'));
for(let i=0;i<60;i++){try{const r=await req(app,'GET',audioUrl);if(r.status()===200)break;}catch{}await new Promise(r=>setTimeout(r,1000));}
for(const f of report.files){
 const r=await req(app,'GET',base+'/dav/spaces/'+f.fileId);
 assert.equal(r.status(),200);assert.equal(hash(await r.body()),f.sha256);
}
const restoredRows=docker([...compose,'exec','-T','postgres','psql','-U','postgres','-d','storage_proof_restored','-Atc','SELECT id,sha256,file_id FROM proof_original ORDER BY id;']);
assert.equal(restoredRows,sql('SELECT id,sha256,file_id FROM proof_original ORDER BY id;'));
assert.equal((await req(owner,'DELETE',moved)).status(),403);
assert([403,404].includes((await req(app,'GET',sentinel)).status()));
assert([403,404].includes((await req(outsider,'GET',moved)).status()));
pass('Restored into new OpenCloud volumes + separate PostgreSQL database: hashes, references and permissions preserved');
pass('Restored receipt rendering and audio playback/seeking',await playback());
const oidcApp={...app,authorization:undefined};
const shortToken=await json(oidcApp,'POST','/auth-app/tokens?expiry=1s&label=expiry-proof');
const shortAuth={...app,authorization:'Basic '+Buffer.from(app.name+':'+shortToken.token).toString('base64')};
assert.equal((await req(shortAuth,'GET',audioUrl)).status(),200);
await new Promise(r=>setTimeout(r,2100));
assert.equal((await req(shortAuth,'GET',audioUrl)).status(),401);
pass('Expired application token rejected');
const replacement=await json(oidcApp,'POST','/auth-app/tokens?expiry=1h&label=rotation-proof');
const replacementAuth={...app,authorization:'Basic '+Buffer.from(app.name+':'+replacement.token).toString('base64')};
assert.equal((await req(replacementAuth,'GET',audioUrl)).status(),200);
assert.equal((await req(oidcApp,'DELETE','/auth-app/tokens?token='+encodeURIComponent(appToken.token))).status(),200);
assert.equal((await req(app,'GET',audioUrl)).status(),401);
assert.equal((await req(replacementAuth,'GET',audioUrl)).status(),200);
pass('Credential rotation works; revoked application token rejected');
report.mediaRequests=mediaRequests;
report.completedAt=new Date().toISOString();report.outcome='PASS';
writeFileSync(dir+'results.json',JSON.stringify(report,null,2));
} catch(e){report.outcome='FAIL';report.failure=String(e);console.error(e.stack);writeFileSync(dir+'results.json',JSON.stringify(report,null,2));console.error(String(e));process.exitCode=1;}
finally{server?.closeAllConnections();server?.close();await browser.close();}
