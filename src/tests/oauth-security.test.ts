import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
let child: ChildProcess;
let base: string;
const resource = 'https://bridge.example.com';
const verifier = 'v'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');
let clientId: string;
const redirect = 'https://claude.ai/api/mcp/auth_callback';
before(async () => {
 child = spawn(process.execPath, ['dist/http.js'], { env: {...process.env, NODE_ENV:'test', OAUTH_STATE_PATH:'', PORT:'0', SHOPMONKEY_API_KEY:'test-only', OAUTH_SIGNING_SECRET:'s'.repeat(48), OAUTH_PASSWORD:'p'.repeat(32), EXTERNAL_URL:resource, MCP_ENABLE_WRITES:'false'}, stdio:['ignore','ignore','pipe'] });
 const port = await new Promise<string>((resolve,reject)=>{ const timer=setTimeout(()=>reject(Error('startup timeout')),5000); child.stderr!.on('data',d=>{const m=String(d).match(/listening on :(\d+)/);if(m){clearTimeout(timer);resolve(m[1]);}});child.on('exit',()=>{clearTimeout(timer);reject(Error('startup failed'));}); });
 base=`http://localhost:${port}`;
 const r=await post('/register',{redirect_uris:[redirect],client_name:'Acceptance test'});clientId=(await r.json()).client_id;
});
after(()=>child?.kill());
function post(path:string, body:unknown){return fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'manual'});}
async function code(aud=resource){const r=await post('/authorize',{client_id:clientId,redirect_uri:redirect,response_type:'code',code_challenge:challenge,code_challenge_method:'S256',resource:aud,password:'p'.repeat(32)}); return r;}
function exchange(c:string){return post('/token',{grant_type:'authorization_code',client_id:clientId,redirect_uri:redirect,code:c,code_verifier:verifier});}
async function tokens(){const r=await code();assert.equal(r.status,302);const c=new URL(r.headers.get('location')!).searchParams.get('code')!;const t=await exchange(c);assert.equal(t.status,200);return {c,...await t.json()};}
test('rejects authorization for a different resource',async()=>{const r=await code('https://wrong.example.com');assert.ok(!new URL(r.headers.get('location')!).searchParams.has('code'));});
test('authorization code cannot be redeemed twice',async()=>{const t=await tokens();assert.equal((await exchange(t.c)).status,400);});
test('refresh token must be bound to the registered client',async()=>{const t=await tokens();assert.equal((await post('/token',{grant_type:'refresh_token',refresh_token:t.refresh_token,client_id:'wrong'})).status,400);});
test('refresh token rotates and cannot be replayed',async()=>{const t=await tokens();const body={grant_type:'refresh_token',refresh_token:t.refresh_token,client_id:clientId};assert.equal((await post('/token',body)).status,200);assert.equal((await post('/token',body)).status,400);});
test('OAuth token can list read tools; writes are hidden and rejected',async()=>{const t=await tokens();async function rpc(method:string,params={}){const r=await fetch(base+'/',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:`Bearer ${t.access_token}`},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});assert.equal(r.status,200);const text=await r.text();return JSON.parse(text.startsWith('event:')?text.split('\n').find(l=>l.startsWith('data:'))!.slice(5):text);}
 const list=await rpc('tools/list');assert.ok(list.result.tools.some((t:{name:string})=>t.name==='get_vehicle'));assert.ok(!list.result.tools.some((t:{name:string})=>t.name==='create_order'));const call=await rpc('tools/call',{name:'create_order',arguments:{}});assert.equal(call.result.isError,true);
});
test('oversized OAuth input cannot crash the server',async()=>{const r=await post('/register',{padding:'x'.repeat(70000)});assert.equal(r.status,400);assert.equal((await fetch(base+'/health')).status,200);});
test('login attempts are rate limited',async()=>{let status=0;for(let i=0;i<35;i++){const r=await post('/authorize',{client_id:clientId,redirect_uri:redirect,response_type:'code',code_challenge:challenge,code_challenge_method:'S256',password:'wrong'});status=r.status;if(status===429)break;}assert.equal(status,429);});
