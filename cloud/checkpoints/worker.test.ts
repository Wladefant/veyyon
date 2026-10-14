import { expect, test } from "bun:test";
import { SessionAuthority, BudgetAuthority } from "./worker";
type State = ConstructorParameters<typeof SessionAuthority>[0];
type Environment = ConstructorParameters<typeof SessionAuthority>[1];
function fixture() {
 const data = new Map<string, unknown>();
 let failPutKey:string|undefined;
 let transactionQueue=Promise.resolve();
 const storage:State["storage"] = { get: async <T>(key:string) => data.get(key) as T | undefined, put: async (key:string,value:unknown) => {if(key===failPutKey){failPutKey=undefined;throw new Error("simulated storage interruption")}data.set(key,value)}, transaction: async <T>(callback:(store:State["storage"])=>Promise<T>) => {
  const previous=transactionQueue;
  let release!:()=>void;
  transactionQueue=new Promise<void>(resolve=>{release=resolve});
  await previous;
  const snapshot=new Map(data);
  try{return await callback(storage)}catch(error){data.clear();for(const [key,value] of snapshot)data.set(key,value);throw error}finally{release()}
 } };
 const objects = new Map<string, Uint8Array>();
 const env:Environment = { OBJECTS: { get: async key => {const bytes=objects.get(key);return bytes?{size:bytes.length,arrayBuffer:async()=>bytes.slice().buffer}:null},put:async()=>{} }, INDEX: {prepare:()=>({bind:()=>({run:async()=>{},all:async()=>[]})})} };
 const authority = new SessionAuthority({storage}, env);
 const post = (action:string,body:unknown) => authority.fetch(new Request(`https://test/v1/sessions/s/${action}`, {method:"POST",body:JSON.stringify(body)}));
 return {post, objects, storage, data, authority, failPut:(key:string)=>{failPutKey=key}};
}
test("release advances epochs and replay is payload bound",async()=>{
 const {post,objects}=fixture();
 const lease=await (await post("lease",{ownerNode:"a"})).json() as {epoch:number;ownerNode:string};
 const bytes=new Uint8Array([1,2,3]);const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),b=>b.toString(16).padStart(2,"0")).join("");objects.set(hash,bytes);
 const body={ownerNode:"a",epoch:lease.epoch,expectedHead:0,idempotencyKey:"operation",manifest:{version:1,sessionId:"s",sequence:1,objects:[{hash,size:3}]}};
 expect((await post("commit",body)).status).toBe(200);
 expect((await post("commit",body)).status).toBe(200);
 expect((await post("commit",{...body,manifest:{...body.manifest,sequence:2}})).status).toBe(400);
 await post("release",lease);await post("lease",{ownerNode:"b"});
 expect((await post("commit",{...body,idempotencyKey:"new",expectedHead:1,manifest:{...body.manifest,sequence:2}})).status).toBe(409);
});
test("a transfer fences the source and allows only one runtime on the named destination",async()=>{
 const {post}=fixture();
 const source=await (await post("lease",{ownerNode:"source"})).json() as {ownerNode:string;epoch:number};
 const token="single-use-claim-capability";
 const request={...source,targetNode:"destination",claimToken:token,transferId:"transfer-1"};
 const transferred=await post("transfer",request);
 expect(transferred.status).toBe(200);
 const destination=await transferred.json() as {ownerNode:string;epoch:number};
 expect(destination.ownerNode).toBe("destination");
 expect(destination.epoch).toBe(source.epoch+1);
 expect((await post("renew",source)).status).toBe(409);
 expect((await post("release",source)).status).toBe(409);
 expect((await post("transfer",{...source,targetNode:"attacker",claimToken:token,transferId:"wrong-owner"})).status).toBe(409);
 expect((await post("claim",{targetNode:"wrong-node",transferId:"transfer-1",claimToken:token,epoch:destination.epoch,ownerNode:"runtime-a"})).status).toBe(409);
 const claimed=await post("claim",{targetNode:"destination",transferId:"transfer-1",claimToken:token,epoch:destination.epoch,ownerNode:"runtime-a"});
 expect(claimed.status).toBe(200);
 const runtimeLease=await claimed.json() as {ownerNode:string;epoch:number;resumeToken:string};
 expect(runtimeLease.ownerNode).toBe("runtime-a");
 expect(runtimeLease.epoch).toBe(destination.epoch+1);
 expect((await post("finalize",{ownerNode:"runtime-a",targetNode:"destination",transferId:"transfer-1",epoch:destination.epoch,leaseEpoch:runtimeLease.epoch,resumeToken:runtimeLease.resumeToken})).status).toBe(200);
 expect((await post("claim",{targetNode:"destination",transferId:"transfer-1",claimToken:token,epoch:destination.epoch,ownerNode:"runtime-b"})).status).toBe(409);
 expect((await post("lease",{ownerNode:"runtime-b"})).status).toBe(409);
});
test("concurrent claim redemption grants one runtime and denies the other",async()=>{
 const {post}=fixture();
 const source=await (await post("lease",{ownerNode:"source"})).json() as {ownerNode:string;epoch:number};
 const transferId="claim-race";
 const token="claim-race-capability";
 const transferred=await (await post("transfer",{...source,targetNode:"destination",claimToken:token,transferId})).json() as {epoch:number};
 const results=await Promise.all([
  post("claim",{targetNode:"destination",transferId,claimToken:token,epoch:transferred.epoch,ownerNode:"runtime-one"}),
  post("claim",{targetNode:"destination",transferId,claimToken:token,epoch:transferred.epoch,ownerNode:"runtime-two"}),
 ]);
 expect(results.map(result=>result.status).sort()).toEqual([200,409]);
});
test("an expired pending transfer is recovered only by its named claim and never by ordinary lease acquisition",async()=>{
 const {post,data}=fixture();
 const source=await (await post("lease",{ownerNode:"source"})).json() as {ownerNode:string;epoch:number};
 const token="expired-transfer-claim-token";
 const transferId="transfer-expire";
 const transferred=await (await post("transfer",{...source,targetNode:"destination",claimToken:token,transferId})).json() as {epoch:number};
 const current=data.get("lease") as {expiresAt:string};
 current.expiresAt=new Date(0).toISOString();
 expect((await post("lease",{ownerNode:"offline-destination"})).status).toBe(409);
 const takeover=await post("claim",{targetNode:"destination",transferId,claimToken:token,epoch:transferred.epoch,ownerNode:"destination-runtime"});
 expect(takeover.status).toBe(200);
});
test("competing handoffs cannot both take ownership",async()=>{
 const {post}=fixture();
 const source=await (await post("lease",{ownerNode:"source"})).json() as {ownerNode:string;epoch:number};
 const results=await Promise.all([
  post("transfer",{...source,targetNode:"laptop-a",claimToken:"claim-capability-a-001",transferId:"race-a"}),
  post("transfer",{...source,targetNode:"laptop-b",claimToken:"claim-capability-b-001",transferId:"race-b"}),
 ]);
 expect(results.map(result=>result.status).sort()).toEqual([200,409]);
});
test("same source owner with a stale epoch cannot return after transfer or capability rotation",async()=>{
 const {post,objects,data}=fixture();
 const original=await (await post("lease",{ownerNode:"source"})).json() as {ownerNode:string;epoch:number};
 const transferId="temporary-transfer";
 const transfer=await (await post("transfer",{...original,targetNode:"temporary-node",claimToken:"temporary-claim-capability",transferId})).json() as {epoch:number};
 const claimed=await (await post("claim",{targetNode:"temporary-node",transferId,claimToken:"temporary-claim-capability",epoch:transfer.epoch,ownerNode:"temporary-runtime"})).json() as {ownerNode:string;epoch:number;resumeToken:string};
 await post("finalize",{ownerNode:claimed.ownerNode,targetNode:"temporary-node",transferId,epoch:transfer.epoch,leaseEpoch:claimed.epoch,resumeToken:claimed.resumeToken});
 const released=await post("release",claimed);
 expect(released.status).toBe(200);
 const currentLease=data.get("lease") as {expiresAt:string};
 currentLease.expiresAt=new Date(0).toISOString();
 const resumed=await (await post("claim",{targetNode:"temporary-node",transferId,resumeToken:claimed.resumeToken,epoch:transfer.epoch,ownerNode:"temporary-runtime-next"})).json() as {ownerNode:string;epoch:number;resumeToken:string};
 expect(resumed.epoch).toBeGreaterThan(original.epoch);
 await post("finalize",{ownerNode:resumed.ownerNode,targetNode:"temporary-node",transferId,epoch:transfer.epoch,leaseEpoch:resumed.epoch,resumeToken:resumed.resumeToken});
 expect((await post("lease",{ownerNode:"source"})).status).toBe(409);
 expect((await post("renew",original)).status).toBe(409);
 expect((await post("release",original)).status).toBe(409);
 expect((await post("transfer",{...original,targetNode:"destination",claimToken:"stale-transfer-capability",transferId:"stale-epoch"})).status).toBe(409);
 expect((await post("claim",{targetNode:"temporary-node",transferId,resumeToken:claimed.resumeToken,epoch:transfer.epoch,ownerNode:"copied-runtime"})).status).toBe(409);
 const bytes=new Uint8Array([7,8,9]);
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),b=>b.toString(16).padStart(2,"0")).join("");
 objects.set(hash,bytes);
 expect((await post("commit",{...original,expectedHead:0,idempotencyKey:"stale-epoch",manifest:{version:1,sessionId:"s",sequence:1,objects:[{hash,size:bytes.length}]}})).status).toBe(409);
});
test("a crash after redemption reclaims the pending capability after expiry and storage failure rolls back",async()=>{
 const {post,data,failPut}=fixture();
 const source=await (await post("lease",{ownerNode:"source"})).json() as {ownerNode:string;epoch:number};
 const transferId="claim-recovery";
 const token="claim-recovery-capability";
 const transfer=await (await post("transfer",{...source,targetNode:"destination",claimToken:token,transferId})).json() as {epoch:number};
 failPut(`claim:${transferId}`);
 await expect(post("claim",{targetNode:"destination",transferId,claimToken:token,epoch:transfer.epoch,ownerNode:"runtime-first"})).rejects.toThrow("simulated storage interruption");
 expect(data.get("lease")).toMatchObject({ownerNode:"destination",epoch:transfer.epoch});
 expect(data.has(`claim:${transferId}`)).toBe(false);
 const first=await (await post("claim",{targetNode:"destination",transferId,claimToken:token,epoch:transfer.epoch,ownerNode:"runtime-first"})).json() as {resumeToken:string;epoch:number};
 expect(typeof first.resumeToken).toBe("string");
 const current=data.get("lease") as {expiresAt:string};
 current.expiresAt=new Date(0).toISOString();
 const recovered=await post("claim",{targetNode:"destination",transferId,claimToken:token,epoch:transfer.epoch,ownerNode:"runtime-recovered"});
 expect(recovered.status).toBe(200);
 expect((await recovered.json() as {resumeToken:string}).resumeToken).toBe(first.resumeToken);
 expect((await post("lease",{ownerNode:"copied-installation"})).status).toBe(409);
});
test("node labels reject path syntax at authority boundaries",async()=>{
 const {post}=fixture();
 expect((await post("lease",{ownerNode:"../outside"})).status).toBe(400);
 const source=await (await post("lease",{ownerNode:"source"})).json() as {ownerNode:string;epoch:number};
 expect((await post("transfer",{...source,targetNode:"dest/../other",claimToken:"capability-long-enough",transferId:"bad-label"})).status).toBe(400);
});
test("a failed transfer persist followed by source release retries at the authoritative epoch",async()=>{
 const {post,data,failPut}=fixture();
 const source=await (await post("lease",{ownerNode:"source"})).json() as {ownerNode:string;epoch:number};
 const failedRequest={...source,targetNode:"destination",claimToken:"retry-claim-capability",transferId:"transfer-retry"};
 failPut("transfer:transfer-retry");
 await expect(post("transfer",failedRequest)).rejects.toThrow("simulated storage interruption");
 expect(data.get("lease")).toMatchObject(source);
 const released=await (await post("release",source)).json() as {ownerNode:string;epoch:number};
 expect(released.epoch).toBe(source.epoch+1);
 expect((await post("transfer",failedRequest)).status).toBe(409);
 const authoritative=await (await post("lease",{ownerNode:"source"})).json() as {ownerNode:string;epoch:number};
 expect(authoritative.epoch).toBeGreaterThan(released.epoch);
 const retry=await post("transfer",{
  ...authoritative,
  targetNode:"destination",
  claimToken:"fresh-claim-capability",
  transferId:"transfer-retry-new",
 });
 expect(retry.status).toBe(200);
 const destination=await retry.json() as {ownerNode:string;epoch:number};
 expect(destination.ownerNode).toBe("destination");
 expect((await post("claim",{targetNode:"destination",transferId:"transfer-retry-new",claimToken:"fresh-claim-capability",epoch:destination.epoch,ownerNode:"destination-runtime"})).status).toBe(200);
 expect((await post("renew",source)).status).toBe(409);
});
test("missing object cannot publish a head",async()=>{
 const {post}=fixture();const lease=await (await post("lease",{ownerNode:"a"})).json() as {epoch:number;ownerNode:string};
 expect((await post("commit",{...lease,expectedHead:0,idempotencyKey:"x",manifest:{version:1,sessionId:"s",sequence:1,objects:[{hash:"a".repeat(64),size:3}]}})).status).toBe(422);
});
test("Free-tier storage and daily request caps fail closed", async () => {
 const {storage, data}=fixture();
 const budget=new BudgetAuthority({storage});
 const admit=()=>budget.fetch(new Request("https://test/admit",{method:"POST",body:JSON.stringify({bytes:1})}));
 data.set("bytes",1073741824);
 expect((await admit()).status).toBe(429);
 data.set("bytes",0);
 data.set("requests",{day:new Date().toISOString().slice(0,10),count:10000});
 expect((await admit()).status).toBe(429);
 data.set("requests",{day:new Date().toISOString().slice(0,10),count:0});
 expect((await admit()).status).toBe(200);
});
test("interrupted index write retains canonical commit and repairs on head read", async () => {
 const {storage, objects, data}=fixture();
 let interrupted=true;
 const authority=new SessionAuthority({storage},{OBJECTS:{get:async key=>{const value=objects.get(key);return value?{size:value.length,arrayBuffer:async()=>value.slice().buffer}:null},put:async()=>{}},INDEX:{prepare:()=>({bind:()=>({run:async()=>{if(interrupted)throw new Error("index unavailable")},all:async()=>[]})})}});
 const call=(action:string,body:unknown)=>authority.fetch(new Request(`https://test/v1/sessions/s/${action}`,{method:"POST",body:JSON.stringify(body)}));
 const lease=await (await call("lease",{ownerNode:"a"})).json() as {epoch:number;ownerNode:string};
 const bytes=new Uint8Array([7]);const hash=new Bun.SHA256().update(bytes).digest("hex");objects.set(hash,bytes);
 const body={...lease,expectedHead:0,idempotencyKey:"lost-ack",manifest:{version:1,sessionId:"s",sequence:1,objects:[{hash,size:1}]}};
 expect((await call("commit",body)).status).toBe(200);
 expect(data.get("outbox")).toBeDefined();
 expect(data.get("indexed")).toBeUndefined();
 interrupted=false;
 const head=await authority.fetch(new Request("https://test/v1/sessions/s/head"));
 expect(head.status).toBe(200);
 expect(data.get("indexed")).toBe(1);
 expect((await call("commit",body)).status).toBe(200);
});
