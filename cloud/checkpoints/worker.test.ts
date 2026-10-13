import { expect, test } from "bun:test";
import { SessionAuthority, BudgetAuthority } from "./worker";
type State = ConstructorParameters<typeof SessionAuthority>[0];
type Environment = ConstructorParameters<typeof SessionAuthority>[1];
function fixture() {
 const data = new Map<string, unknown>();
 const storage:State["storage"] = { get: async <T>(key:string) => data.get(key) as T | undefined, put: async (key:string,value:unknown) => {data.set(key,value)}, transaction: async <T>(callback:(store:State["storage"])=>Promise<T>) => {
  const previous=transactionQueue;
  let release!:()=>void;
  transactionQueue=new Promise<void>(resolve=>{release=resolve});
  await previous;
  try{return await callback(storage)}finally{release()}
 } };
 let transactionQueue=Promise.resolve();
 const objects = new Map<string, Uint8Array>();
 const env:Environment = { OBJECTS: { get: async key => {const bytes=objects.get(key);return bytes?{size:bytes.length,arrayBuffer:async()=>bytes.slice().buffer}:null},put:async()=>{} }, INDEX: {prepare:()=>({bind:()=>({run:async()=>{},all:async()=>[]})})} };
 const authority = new SessionAuthority({storage}, env);
 const post = (action:string,body:unknown) => authority.fetch(new Request(`https://test/v1/sessions/s/${action}`, {method:"POST",body:JSON.stringify(body)}));
 return {post, objects, storage, data, authority};
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
test("a transfer rotates ownership, fences the source, and admits only its destination",async()=>{
 const {post}=fixture();
 const source=await (await post("lease",{ownerNode:"source"})).json() as {ownerNode:string;epoch:number};
 const request={...source,targetNode:"destination",transferId:"transfer-1"};
 const transferred=await post("transfer",request);
 expect(transferred.status).toBe(200);
 const destination=await transferred.json() as {ownerNode:string;epoch:number};
 expect(destination.ownerNode).toBe("destination");
 expect(destination.epoch).toBe(source.epoch+1);
 expect((await post("renew",source)).status).toBe(409);
 expect((await post("transfer",{...source,targetNode:"attacker",transferId:"wrong-owner"})).status).toBe(409);
 expect((await post("lease",{ownerNode:"other"})).status).toBe(409);
 const resumed=await (await post("lease",{ownerNode:"destination"})).json() as {ownerNode:string;epoch:number};
 expect(resumed.ownerNode).toBe("destination");
 expect(resumed.epoch).toBe(destination.epoch);
});
test("an expired transferred lease can be taken by an offline destination",async()=>{
 const {post,data}=fixture();
 const source=await (await post("lease",{ownerNode:"source"})).json() as {ownerNode:string;epoch:number};
 await post("transfer",{...source,targetNode:"destination",transferId:"transfer-expire"});
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
  post("transfer",{...source,targetNode:"laptop-a",transferId:"race-a"}),
  post("transfer",{...source,targetNode:"laptop-b",transferId:"race-b"}),
 ]);
 expect(results.map(result=>result.status).sort()).toEqual([200,409]);
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
