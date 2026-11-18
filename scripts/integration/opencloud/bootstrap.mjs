// Scoped synthetic identities and space for actual Quantself application integration.
import {chromium} from 'playwright';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import assert from 'node:assert/strict';
const dir=new URL('.',import.meta.url).pathname;
const base='https://localhost:19200';
const project=process.env.INTEGRATION_PROJECT;
assert(project?.startsWith('qs-storage-integration-'),'Use run.sh to allocate an isolated project');
const compose=['compose','-p',project,'-f',dir+'compose.yaml'];
const docker=(args,input)=>execFileSync('docker',args,{input,encoding:'utf8',stdio:['pipe','pipe','pipe']});

const q=s=>"'"+String(s).replaceAll("'","''")+"'";
const hash=b=>createHash('sha256').update(b).digest('hex');
const report={startedAt:new Date().toISOString(),checks:[],requests:[],files:[],limitations:['Mac Docker, not Keep VMs; local timings only','Self-signed localhost TLS; verification bypass limited to this proof']};
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

const env={...process.env, QUANTSELF_ORIGINALS_PROVIDER:'opencloud', QUANTSELF_OPENCLOUD_URL:base,
 QUANTSELF_OPENCLOUD_SPACE_ID:space.id, QUANTSELF_OPENCLOUD_USERNAME:app.name,
 QUANTSELF_OPENCLOUD_TOKEN:appToken.token, NODE_TLS_REJECT_UNAUTHORIZED:'0',
 QUANTSELF_STORAGE_INTEGRATION:'1', BETTER_AUTH_URL:'http://localhost:19301',
 QUANTSELF_TODO_CAPTURE_ROOT:dir+'legacy-audio'};
execFileSync('bun',[process.env.INTEGRATION_REPO_ROOT+'/scripts/integration/opencloud/check.ts'],{env,stdio:'inherit',timeout:300000});
} finally {
 await browser.close();
}
