import { readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const account='a0d288d1c95470cd009cc6e0df7accb7';
const token=process.env.CLOUDFLARE_API_TOKEN;
if(!token)throw Error('CLOUDFLARE_API_TOKEN required');
const base=`https://api.cloudflare.com/client/v4/accounts/${account}`;
async function api(path,method='GET',body){const response=await fetch(base+path,{method,headers:{authorization:`Bearer ${token}`,...(body instanceof FormData?{}:{'content-type':'application/json'})},body:body instanceof FormData?body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});const data=await response.json();if(!response.ok || !data.success)throw Error(`Cloudflare ${path}: ${response.status} ${JSON.stringify(data.errors)}`);return data.result;}
const buckets=await api('/r2/buckets');if(!buckets.buckets.some(b=>b.name==='veyyon-checkpoints'))await api('/r2/buckets','POST',{name:'veyyon-checkpoints'});
const databases=await api('/d1/database');let db=databases.find(d=>d.name==='veyyon-checkpoints');if(!db)db=await api('/d1/database','POST',{name:'veyyon-checkpoints'});
await api(`/d1/database/${db.uuid}/query`,'POST',{sql:'CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, manifest_hash TEXT NOT NULL)'});
const scripts=await api('/workers/scripts');const exists=scripts.some(s=>s.id==='veyyon-checkpoints');
const metadata={main_module:'worker.js',compatibility_date:'2026-10-01',limits:{cpu_ms:10},bindings:[{type:'r2_bucket',name:'OBJECTS',bucket_name:'veyyon-checkpoints'},{type:'d1',name:'INDEX',id:db.uuid},{type:'durable_object_namespace',name:'SESSIONS',class_name:'SessionAuthority'},{type:'durable_object_namespace',name:'BUDGET',class_name:'BudgetAuthority'},{type:'secret_text',name:'API_TOKEN',text:process.env.VEYYON_CHECKPOINT_TOKEN}],...(!exists?{migrations:{new_tag:'v1',new_sqlite_classes:['SessionAuthority','BudgetAuthority']}}:{})};
if(!metadata.bindings.at(-1).text)throw Error('VEYYON_CHECKPOINT_TOKEN required');
const form=new FormData();form.set('metadata',JSON.stringify(metadata));form.set('worker.js',new Blob([stripTypeScriptTypes(readFileSync(new URL('./worker.ts',import.meta.url),'utf8'),{mode:'transform'})],{type:'application/javascript+module'}),'worker.js');
await api('/workers/scripts/veyyon-checkpoints','PUT',form);
await api('/workers/scripts/veyyon-checkpoints/subdomain','POST',{enabled:true});
writeFileSync(new URL('./deployment.json',import.meta.url),JSON.stringify({account,worker:'veyyon-checkpoints',bucket:'veyyon-checkpoints',databaseId:db.uuid,url:'https://veyyon-checkpoints.polysimulator.workers.dev'},null,2)+'\n');
console.log('Deployed veyyon-checkpoints in approved PolySimulator account');
