import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readRemoteText } from "../examples/extensions/mainplane-worker-bridge";

describe("Mainplane worker file read", () => {
 test("checks byte count and digest before presenting text", async () => {
   const data = Buffer.from("sample");
   const transport = (async (_url: string, init: RequestInit) => {
     expect(init.method).toBe("POST");
     return new Response(JSON.stringify({
       data_base64: data.toString("base64"), bytes: data.length,
       sha256: createHash("sha256").update(data).digest("hex"),
     }));
   }) as typeof fetch;
   const result = await readRemoteText("https://fleet.example.org/", "fixture-secret",
     "pc2", "C:/owned/file.txt", undefined, transport);
   expect(result.text).toBe("sample");
   expect(result.truncated).toBe(false);
 });
 test("rejects mismatched digests", async () => {
   const transport = (async () => new Response(JSON.stringify({
     data_base64: Buffer.from("wrong").toString("base64"), bytes: 5,
     sha256: "0".repeat(64),
   }))) as typeof fetch;
   await expect(readRemoteText("https://fleet.example.org/", "fixture-secret",
     "pc2", "/tmp/file", undefined, transport)).rejects.toThrow("mismatch");
 });
 test("does not decode arbitrary binary as text", async () => {
   const data = Buffer.from([0xff, 0]);
   const transport = (async () => new Response(JSON.stringify({
     data_base64: data.toString("base64"), bytes: data.length,
     sha256: createHash("sha256").update(data).digest("hex"),
   }))) as typeof fetch;
   await expect(readRemoteText("https://fleet.example.org/", "fixture-secret",
     "pc2", "/tmp/image.bin", undefined, transport)).rejects.toThrow("binary");
 });
});
