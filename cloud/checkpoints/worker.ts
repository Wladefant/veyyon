import { isCheckpointNodeLabel } from "../../contracts/session/src/checkpoint-ownership";
interface Storage {
 get<T>(key: string): Promise<T | undefined>;
 put(key: string, value: unknown): Promise<void>;
 transaction<T>(callback: (store: Storage) => Promise<T>): Promise<T>;
}
interface Stub { fetch(request: Request): Promise<Response> }
interface Namespace { idFromName(name: string): unknown; get(id: unknown): Stub }
interface ObjectStore { get(key: string): Promise<{size:number;arrayBuffer():Promise<ArrayBuffer>} | null>; put(key:string,bytes:ArrayBuffer,options?:unknown):Promise<unknown> }
interface Index { prepare(sql:string):{bind(...values:unknown[]):{run():Promise<unknown>;all():Promise<unknown>}} }
interface Env { OBJECTS:ObjectStore; INDEX:Index; SESSIONS:Namespace; BUDGET:Namespace; API_TOKEN:string }
interface Lease {ownerNode:string;epoch:number;expiresAt:string;headSequence:number;manifestHash:string;targetNode?:string;claimHash?:string;claimEpoch?:number;transferId?:string}
interface Manifest {version:1;sessionId:string;sequence:number;objects:{hash:string;size:number}[]}
interface Head {sequence:number;manifestHash:string;manifest:Manifest}
interface Transfer {sourceNode:string;sourceEpoch:number;targetNode:string;targetEpoch:number;claimHash:string;result:Lease}
interface Claim {targetNode:string;transferEpoch:number;claimHash:string;spent:boolean;runtimeOwner?:string;runtimeEpoch?:number;resumeHash?:string;resumeToken?:string;pendingResumeHash?:string;pendingResumeToken?:string}
const json=(value:unknown,status=200)=>Response.json(value,{status});
const digest=async(bytes:BufferSource)=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),b=>b.toString(16).padStart(2,"0")).join("");
const hashPattern=/^[a-f0-9]{64}$/;
function manifestOf(value:unknown):Manifest | null {
 if(!value || typeof value!=="object")return null;
 const m=value as Record<string,unknown>;
 if(m.version!==1 || typeof m.sessionId!=="string" || !Number.isSafeInteger(m.sequence) || !Array.isArray(m.objects) || !m.objects.length || m.objects.length>1024)return null;
 let total=0;const objects:Manifest["objects"]=[];
 for(const item of m.objects){if(!item || typeof item!=="object")return null;const o=item as Record<string,unknown>;if(typeof o.hash!=="string" || !hashPattern.test(o.hash) || typeof o.size!=="number" || !Number.isSafeInteger(o.size) || o.size<1 || o.size>8388608)return null;total+=o.size;objects.push({hash:o.hash,size:o.size});}
 return total>67108864 ? null : {version:1,sessionId:m.sessionId,sequence:m.sequence as number,objects};
}
export class SessionAuthority {
 constructor(readonly state:{storage:Storage},readonly env:Pick<Env,"OBJECTS"|"INDEX">){}
 async repair(head:Head):Promise<void>{await this.env.INDEX.prepare("INSERT INTO sessions (id, sequence, manifest_hash) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET sequence=excluded.sequence, manifest_hash=excluded.manifest_hash WHERE excluded.sequence >= sessions.sequence").bind(head.manifest.sessionId,head.sequence,head.manifestHash).run();await this.state.storage.put("indexed",head.sequence);}
 async fetch(request:Request):Promise<Response>{
 const action=new URL(request.url).pathname.split("/").pop();
 if(action==="head"){const head=await this.state.storage.get<Head>("head");if(head){try{await this.repair(head);}catch{/* authoritative head remains readable; next request retries outbox */}}return json(head??null);}
 const raw:unknown=await request.json();
 if (!raw || typeof raw!=="object" || Array.isArray(raw)) return json({error:"invalid request"},400);
 const body=raw as Record<string,unknown>;
 if(!isCheckpointNodeLabel(body.ownerNode))return json({error:"valid owner required"},400);
 if(action==="commit"){
 const manifest=manifestOf(body.manifest);if(!manifest || manifest.sequence!==Number(body.expectedHead)+1 || typeof body.idempotencyKey!=="string" || body.idempotencyKey.length>128)return json({error:"invalid manifest"},400);
 if (manifest.sessionId !== new URL(request.url).pathname.split("/")[3]) return json({error:"session identity mismatch"},400);
 const manifestHash=await digest(new TextEncoder().encode(JSON.stringify(manifest)));
 for(const ref of manifest.objects){const object=await this.env.OBJECTS.get(ref.hash);if(!object || object.size!==ref.size || await digest(await object.arrayBuffer())!==ref.hash)return json({error:"missing or corrupt object"},422);}
 const result=await this.state.storage.transaction(async store=>{
 const lease=await store.get<Lease>("lease");if(!lease || lease.ownerNode!==body.ownerNode || lease.epoch!==body.epoch || Date.parse(lease.expiresAt)<=Date.now())return json({error:"stale writer"},409);
 const replay=await store.get<Head>(`replay:${body.idempotencyKey}`);if(replay)return replay.manifestHash===manifestHash?json(replay):json({error:"idempotency mismatch"},409);
 const head=await store.get<Head>("head");if((head?.sequence??0)!==body.expectedHead || manifest.sequence>100 || (head && head.manifest.sessionId!==manifest.sessionId))return json({error:"head conflict or cap"},409);
 const next={sequence:manifest.sequence,manifestHash,manifest};await store.put("head",next);await store.put(`replay:${body.idempotencyKey}`,next);await store.put("outbox",next);return json(next);
 });
 if(result.ok){const head=await this.state.storage.get<Head>("head");if(head){try{await this.repair(head);}catch{/* committed outbox is retried on head read */}}}return result;
 }
 const rawTarget=body.targetNode;
 const rawTransferId=body.transferId;
 const rawClaimToken=body.claimToken;
 const rawResumeToken=body.resumeToken;
 const targetNode=isCheckpointNodeLabel(rawTarget)?rawTarget:undefined;
 const transferId=typeof rawTransferId==="string" && /^[A-Za-z0-9_-]{1,128}$/.test(rawTransferId)?rawTransferId:undefined;
 const claimHash=typeof rawClaimToken==="string" && rawClaimToken.length>=16 && rawClaimToken.length<=128
  ? await digest(new TextEncoder().encode(rawClaimToken)) : undefined;
 const resumeHash=typeof rawResumeToken==="string" && rawResumeToken.length>=16 && rawResumeToken.length<=128
  ? await digest(new TextEncoder().encode(rawResumeToken)) : undefined;
 const nextResumeToken=crypto.randomUUID();
 const nextResumeHash=await digest(new TextEncoder().encode(nextResumeToken));
 return this.state.storage.transaction(async store=>{
  const current=await store.get<Lease>("lease");
  const live=current && Date.parse(current.expiresAt)>Date.now();
  const head=await store.get<Head>("head");
  if(action==="lease"){
   if(current?.claimHash)return json({error:"transferred sessions require their authority-issued resume capability"},409);
   if(live && current.ownerNode!==body.ownerNode)return json({error:"owned"},409);
   const lease:Lease={ownerNode:body.ownerNode as string,epoch:live?current.epoch:(current?.epoch??0)+1,expiresAt:new Date(Date.now()+60000).toISOString(),headSequence:head?.sequence??0,manifestHash:head?.manifestHash??""};
   await store.put("lease",lease);return json(lease);
  }
  if(action==="transfer"){
   if(!targetNode || !transferId || claimHash===undefined || !Number.isSafeInteger(body.epoch))return json({error:"invalid transfer"},400);
   const prior=await store.get<Transfer>(`transfer:${transferId}`);
   if(prior){
    if(prior.sourceNode!==body.ownerNode || prior.sourceEpoch!==body.epoch || prior.targetNode!==targetNode || prior.claimHash!==claimHash)return json({error:"transfer replay mismatch"},409);
    return json(prior.result);
   }
   if(!live || current.ownerNode!==body.ownerNode || current.epoch!==body.epoch || current.claimHash)return json({error:"stale writer"},409);
   const next:Lease={...current,ownerNode:targetNode,targetNode,epoch:current.epoch+1,expiresAt:new Date(Date.now()+60000).toISOString(),claimHash,claimEpoch:current.epoch+1,transferId};
   const result={...next};delete result.claimHash;delete result.claimEpoch;
   await store.put("lease",next);
   await store.put(`transfer:${transferId}`,{sourceNode:current.ownerNode,sourceEpoch:current.epoch,targetNode,targetEpoch:next.epoch,claimHash,result});
   return json(result);
  }
  if(action==="claim"){
   if(!targetNode || !transferId || !Number.isSafeInteger(body.epoch) || (claimHash===undefined)===(resumeHash===undefined))return json({error:"invalid claim"},400);
   const transfer=await store.get<Transfer>(`transfer:${transferId}`);
   const claim=await store.get<Claim>(`claim:${transferId}`);
   if(!transfer || transfer.targetNode!==targetNode || transfer.targetEpoch!==body.epoch || !current || current.transferId!==transferId || current.targetNode!==targetNode)
    return json({error:"invalid or stale transfer identity"},409);
   if(claimHash!==undefined && claimHash!==transfer.claimHash)return json({error:"invalid or spent transfer claim"},409);
   if(claim && (claim.targetNode!==targetNode || claim.transferEpoch!==body.epoch || claim.claimHash!==transfer.claimHash))
    return json({error:"invalid transfer claim"},409);
   if(claim?.spent && resumeHash!==undefined && resumeHash!==claim.resumeHash && resumeHash!==claim.pendingResumeHash)
    return json({error:"stale resume capability"},409);
   if(claim?.spent && claimHash===undefined && resumeHash===undefined)return json({error:"resume capability required"},409);
   if(live && current.ownerNode!==body.ownerNode)return json({error:"another runtime holds the live checkpoint lease"},409);
   if(claim?.spent && claimHash!==undefined && !claim.pendingResumeToken)return json({error:"transfer claim has already been spent"},409);
   if(!claim?.spent && claimHash===undefined)return json({error:"resume capability required"},409);
   if(!claim?.spent && (current.ownerNode!==targetNode || current.epoch!==transfer.targetEpoch || current.claimHash!==transfer.claimHash))
    return json({error:"transfer claim is stale"},409);
   const retrySameRuntime=live && current.ownerNode===body.ownerNode;
   const epoch=retrySameRuntime?current.epoch:current.epoch+1;
   const pendingToken=retrySameRuntime && claim?.pendingResumeToken
    ? claim.pendingResumeToken
    : claim?.pendingResumeToken ?? nextResumeToken;
   const pendingHash=retrySameRuntime && claim?.pendingResumeHash
    ? claim.pendingResumeHash
    : claim?.pendingResumeHash ?? nextResumeHash;
   const next:Lease={...current,ownerNode:body.ownerNode as string,epoch,expiresAt:new Date(Date.now()+60000).toISOString()};
   const nextClaim:Claim={
    targetNode,transferEpoch:transfer.targetEpoch,claimHash:transfer.claimHash,spent:true,
    runtimeOwner:body.ownerNode as string,runtimeEpoch:epoch,
    resumeHash:claim?.resumeHash,resumeToken:claim?.resumeToken,
    pendingResumeHash:pendingHash,pendingResumeToken:pendingToken,
   };
   await store.put("lease",next);
   await store.put(`claim:${transferId}`,nextClaim);
   const visible={...next};delete visible.claimHash;delete visible.claimEpoch;
   return json({...visible,resumeToken:pendingToken});
  }
  if(action==="finalize"){
   if(!targetNode || !transferId || resumeHash===undefined || !Number.isSafeInteger(body.epoch))return json({error:"invalid resume finalization"},400);
   const transfer=await store.get<Transfer>(`transfer:${transferId}`);
   const claim=await store.get<Claim>(`claim:${transferId}`);
   if(!transfer || !claim?.spent || transfer.targetNode!==targetNode || transfer.targetEpoch!==body.epoch ||
    !live || current.ownerNode!==body.ownerNode || current.epoch!==body.leaseEpoch || current.transferId!==transferId ||
    claim.runtimeOwner!==body.ownerNode || claim.runtimeEpoch!==body.leaseEpoch || claim.pendingResumeHash!==resumeHash)
    return json({error:"resume capability finalization is stale"},409);
   const {pendingResumeHash,pendingResumeToken,...rest}=claim;
   const nextClaim:Claim={...rest,resumeHash:pendingResumeHash,resumeToken:pendingResumeToken};
   await store.put(`claim:${transferId}`,nextClaim);
   return json({ok:true});
  }
  if(!live || current.ownerNode!==body.ownerNode || current.epoch!==body.epoch)return json({error:"stale writer"},409);
  if(action==="renew"){const next={...current,expiresAt:new Date(Date.now()+60000).toISOString()};await store.put("lease",next);return json(next);}
  if(action==="release"){
   const next={...current,epoch:current.epoch+1,expiresAt:new Date(0).toISOString()};
   await store.put("lease",next);return json(next);
  }
  return json({error:"unknown operation"},404);
 });
 }
}
export class BudgetAuthority {
 constructor(readonly state:{storage:Storage}){}
 async fetch(request:Request):Promise<Response>{
 const raw:unknown=await request.json();
 if (!raw || typeof raw!=="object" || Array.isArray(raw)) return json({error:"invalid admission"},400);
 const values=raw as Record<string,unknown>;
 if ((values.bytes!==undefined && typeof values.bytes!=="number") || (values.sessionId!==undefined && typeof values.sessionId!=="string")) return json({error:"invalid admission"},400);
 const body={bytes:typeof values.bytes==="number"?values.bytes:undefined,sessionId:typeof values.sessionId==="string"?values.sessionId:undefined};
 const units=typeof values.units==="number"?values.units:1;
 if (!Number.isSafeInteger(units) || units<1 || units>1025) return json({error:"invalid operation reservation"},400);
 return this.state.storage.transaction(async store=>{
  const today=new Date().toISOString().slice(0,10);
  const day=await store.get<{day:string;count:number}>("requests");
  const count=day?.day===today?day.count:0;
  const bytes=await store.get<number>("bytes")??0;
  const addition=body.bytes??0;
  const sessions=await store.get<string[]>("sessions")??[];
  if (!Number.isSafeInteger(addition)||addition<0 || count+units>10000 || bytes+addition>1073741824 || (body.sessionId && !sessions.includes(body.sessionId) && sessions.length>=100)) return json({error:"free tier cap"},429);
  if (body.sessionId && !sessions.includes(body.sessionId)) {sessions.push(body.sessionId);await store.put("sessions",sessions);}
  await store.put("requests",{day:today,count:count+units});await store.put("bytes",bytes+addition);
  return json({ok:true});
 });
 }
}
export default {
 async fetch(request:Request,env:Env):Promise<Response>{
  let bytes:ArrayBuffer|undefined;
 if(!env.API_TOKEN || request.headers.get("authorization")!==`Bearer ${env.API_TOKEN}`)return json({error:"unauthorized"},401);
 const url=new URL(request.url);const parts=url.pathname.split("/").filter(Boolean);
 if(parts[0]!=="v1")return json({error:"not found"},404);
 if(parts[1]==="objects" && request.method==="PUT") {const declared=Number(request.headers.get("content-length"));if(declared>8388608)return json({error:"object cap"},413);bytes=await request.arrayBuffer();if(bytes.byteLength>8388608 || !bytes.byteLength)return json({error:"object cap"},413);}
 const sessionId=parts[1]==="sessions" && /^[a-zA-Z0-9_-]{1,128}$/.test(parts[2]??"")?parts[2]:undefined;
 let units=1;
 if (parts[3]==="commit" && request.method==="POST") {
  const raw:unknown=await request.clone().json();
  if (!raw || typeof raw!=="object" || !("manifest" in raw)) return json({error:"invalid manifest"},400);
  const manifest=manifestOf(raw.manifest);
  if (!manifest) return json({error:"invalid manifest"},400);
  units+=manifest.objects.length;
 }
 const budget=await env.BUDGET.get(env.BUDGET.idFromName("global")).fetch(new Request("https://budget/admit",{method:"POST",body:JSON.stringify({bytes:bytes?.byteLength??0,sessionId,units})}));if(!budget.ok)return budget;
 if(parts[1]==="objects" && parts.length===3 && hashPattern.test(parts[2]!)){
 const hash=parts[2]!;const existing=await env.OBJECTS.get(hash);
 if(request.method==="GET")return existing?new Response(await existing.arrayBuffer(),{headers:{"content-type":"application/octet-stream"}}):json({error:"missing"},404);
 if(bytes){if(await digest(bytes)!==hash)return json({error:"hash mismatch"},422);if(existing)return json({error:"immutable object exists"},409);await env.OBJECTS.put(hash,bytes,{onlyIf:{etagDoesNotMatch:"*"}});return new Response(null,{status:201});}
 }
 if(parts[1]==="catalog" && request.method==="GET")return json(await env.INDEX.prepare("SELECT id, sequence, manifest_hash FROM sessions LIMIT 100").bind().all());
 if(parts[1]==="sessions" && parts.length===4 && sessionId && ((parts[3]==="head" && request.method==="GET") || (["lease","renew","release","transfer","claim","finalize","commit"].includes(parts[3]!) && request.method==="POST"))) return env.SESSIONS.get(env.SESSIONS.idFromName(sessionId)).fetch(request);
 return json({error:"not found"},404);
 }
};
