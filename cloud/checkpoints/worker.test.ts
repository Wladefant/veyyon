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
 const token="single-use-claim";
 const request={...source,targetNode:"destination",claimToken:token,transferId:"transfer-1"};
 const transferred=await post("transfer",request);
 expect(transferred.status).toBe(200);
 const destination=await transferred.json() as {ownerNode:string;epoch:number};
 expect(destination.ownerNode).toBe("destination");
 expect(destination.epoch).toBe(source.epoch+1);
 expect((await post("renew",source)).status).toBe(409);
 expect((await post("release",source)).status).toBe(409);
 expect((await post("transfer",{...source,targetNode:"attacker",claimToken:"bad",transferId:"wrong-owner"})).status).toBe(409);
 expect((await post("claim",{targetNode:"wrong-node",claimToken:token,epoch:destination.epoch,ownerNode:"runtime-a"})).status).toBe(409);
 const claimed=await post("claim",{targetNode:"destination",claimToken:token,epoch:destination.epoch,ownerNode:"runtime-a"});
 expect(claimed.status).toBe(200);
 const runtimeLease=await claimed.json() as {ownerNode:string;epoch:number};
 expect(runtimeLease.ownerNode).toBe("runtime-a");
 expect(runtimeLease.epoch).toBe(destination.epoch+1);
 expect((await post("claim",{targetNode:"destination",claimToken:token,epoch:destination.epoch,ownerNode:"runtime-b"})).status).toBe(409);
 expect((await post("lease",{ownerNode:"runtime-b"})).status).toBe(409);
});
test("an expired transfer lease permits ordinary offline takeover",async()=>{
 const {post,data}=fixture();
 const source=await (await post("lease",{ownerNode:"source"})).json() as {ownerNode:string;epoch:number};
 await post("transfer",{...source,targetNode:"destination",claimToken:"claim",transferId:"transfer-expire"});
 const current=data.get("lease") as {expiresAt:string};
 current.expiresAt=new Date(0).toISOString();
 const takeover=await post("lease",{ownerNode:"offline-destination"});
 expect(takeover.status).toBe(200);
 expect((await takeover.json() as {ownerNode:string}).ownerNode).toBe("offline-destination");
});
test("competing handoffs cannot both take ownership",async()=>{
 const {post}=fixture();
 const source=await (await post("lease",{ownerNode:"source"})).json() as {ownerNode:string;epoch:number};
 const results=await Promise.all([
  post("transfer",{...source,targetNode:"laptop-a",claimToken:"claim-a",transferId:"race-a"}),
  post("transfer",{...source,targetNode:"laptop-b",claimToken:"claim-b",transferId:"race-b"}),
 ]);
 expect(results.map(result=>result.status).sort()).toEqual([200,409]);
});
test("same owner with a stale epoch cannot renew, release, transfer, or commit after ownership returns",async()=>{
 const {post,objects}=fixture();
 const original=await (await post("lease",{ownerNode:"source"})).json() as {ownerNode:string;epoch:number};
 const transfer=await (await post("transfer",{...original,targetNode:"temporary-node",claimToken:"temporary-claim",transferId:"temporary-transfer"})).json() as {epoch:number};
 const runtime=await (await post("claim",{targetNode:"temporary-node",claimToken:"temporary-claim",epoch:transfer.epoch,ownerNode:"temporary-runtime"})).json() as {ownerNode:string;epoch:number};
 await post("release",runtime);
 const current=await (await post("lease",{ownerNode:"source"})).json() as {ownerNode:string;epoch:number};
 expect(current.epoch).toBeGreaterThan(original.epoch);
 expect((await post("renew",original)).status).toBe(409);
 expect((await post("release",original)).status).toBe(409);
 expect((await post("transfer",{...original,targetNode:"destination",claimToken:"claim",transferId:"stale-epoch"})).status).toBe(409);
 const bytes=new Uint8Array([7,8,9]);
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),b=>b.toString(16).padStart(2,"0")).join("");
 objects.set(hash,bytes);
 expect((await post("commit",{...original,expectedHead:0,idempotencyKey:"stale-epoch",manifest:{version:1,sessionId:"s",sequence:1,objects:[{hash,size:bytes.length}]}})).status).toBe(409);
});
test("an interrupted transfer rolls back its lease rotation and safely retries",async()=>{
 const {post,data,failPut}=fixture();
 const source=await (await post("lease",{ownerNode:"source"})).json() as {ownerNode:string;epoch:number};
 const request={...source,targetNode:"destination",claimToken:"retry-claim",transferId:"transfer-retry"};
 failPut("transfer:transfer-retry");
 await expect(post("transfer",request)).rejects.toThrow("simulated storage interruption");
 expect(data.get("lease")).toMatchObject(source);
 expect((await post("renew",source)).status).toBe(200);
 const retry=await post("transfer",request);
 expect(retry.status).toBe(200);
 const destination=await retry.json() as {ownerNode:string;epoch:number};
 expect(destination.ownerNode).toBe("destination");
 expect((await post("claim",{targetNode:"destination",claimToken:"retry-claim",epoch:destination.epoch,ownerNode:"destination-runtime"})).status).toBe(200);
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
