import { describe, expect, test } from "bun:test";
import {
	type CheckpointBundle,
	CheckpointClient,
	type CheckpointFetch,
	decryptCheckpointBundle,
	encryptCheckpointBundle,
	filterCheckpointFiles,
} from "../src/checkpoints/cloud-checkpoints";

const bundle: CheckpointBundle = {
	version: 1,
	native: { sessionId: "s", header: { type: "session", id: "s", cwd: "/repo" }, sessionFile: "session.jsonl" },
	journal: { path: "session.jsonl", bytes: "e30K" },
	artifacts: { a: "YmxvYg==" },
	blobs: {},
	workspace: { dirty: ["src/a.ts"], files: [] },
	pins: { bun: "1", commit: "a".repeat(40), runtime: "v1" },
};
describe("cloud checkpoints", () => {
	test("round trips ciphertext larger than the service object cap", async () => {
		const objects = new Map<string, Uint8Array>();
		let head: unknown = null;
		const fake: CheckpointFetch = async (input, init) => {
			const path = new URL(String(input)).pathname;
			if (path.endsWith("/lease"))
				return Response.json({
					ownerNode: "a",
					epoch: 1,
					expiresAt: "2099-01-01T00:00:00Z",
					headSequence: 0,
					manifestHash: "",
				});
			if (path.includes("/objects/")) {
				const hash = path.split("/").pop()!;
				if (init?.method === "PUT") {
					const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
					if (bytes.length > 8388608) return new Response(null, { status: 413 });
					objects.set(hash, bytes);
					return new Response(null, { status: 201 });
				}
				const bytes = objects.get(hash);
				return bytes ? new Response(bytes) : new Response(null, { status: 404 });
			}
			if (path.endsWith("/commit")) {
				const body = JSON.parse(String(init?.body));
				head = {
					sequence: 1,
					manifest: body.manifest,
					manifestHash: new Bun.SHA256().update(JSON.stringify(body.manifest)).digest("hex"),
				};
				return Response.json(head);
			}
			return Response.json(head);
		};
		const client = new CheckpointClient({
			baseUrl: "https://test",
			token: "test",
			key: new Uint8Array(32),
			fetch: fake,
		});
		const large = { ...bundle, artifacts: { large: "x".repeat(9 * 1024 * 1024) } };
		await client.acquireLease("s", "a");
		await client.commit("s", large, 0);
		expect(objects.size).toBe(2);
		expect(await client.restore("s")).toEqual(large);
	});
	test("is disabled by default and excludes credentials and caches", () => {
		expect(CheckpointClient.fromEnv({}).enabled).toBe(false);
		const files = ["src/a.ts", ".env", "node_modules/x", ".git/index", "package-lock.json"].map(path => ({
			path,
			content: new Uint8Array(),
		}));
		expect(filterCheckpointFiles(files).map(x => x.path)).toEqual(["src/a.ts", "package-lock.json"]);
	});
	test("authenticates encrypted bundle and rejects tampering", async () => {
		const key = new Uint8Array(32).fill(9);
		const encrypted = await encryptCheckpointBundle(bundle, key);
		expect(await decryptCheckpointBundle(encrypted, key)).toEqual(bundle);
		encrypted[encrypted.length - 1] = encrypted[encrypted.length - 1]! ^ 1;
		await expect(decryptCheckpointBundle(encrypted, key)).rejects.toThrow();
	});
	test("rejects authenticated ciphertext with an unsupported bundle shape", async () => {
		const key = new Uint8Array(32);
		// Deliberately forge an authenticated payload at the encryption boundary.
		const malformed = { ...bundle, version: 2 } as unknown as CheckpointBundle;
		const encrypted = await encryptCheckpointBundle(malformed, key);
		await expect(decryptCheckpointBundle(encrypted, key)).rejects.toThrow();
	});
	test("lease loss fences commits", async () => {
		const fakeFetch: CheckpointFetch = async () =>
			new Response(
				JSON.stringify({
					ownerNode: "node-a",
					epoch: 4,
					expiresAt: "2099-01-01T00:00:00Z",
					headSequence: 0,
					manifestHash: "",
				}),
			);
		const client = new CheckpointClient({
			baseUrl: "https://checkpoint.invalid",
			token: "test",
			key: new Uint8Array(32).fill(1),
			fetch: fakeFetch,
		});
		const lease = await client.acquireLease("s1", "node-a");
		client.loseLease("s1");
		await expect(client.assertWritable("s1", lease.epoch)).rejects.toThrow(/lease/i);
	});


	test("unparseable lease deadlines cannot authorize checkpoint writes", async () => {
		let expiresAt = "2099-01-01T00:00:00Z";
		const fake: CheckpointFetch = async () => Response.json({
			ownerNode: "node-a",
			epoch: 4,
			expiresAt,
			headSequence: 0,
			manifestHash: "",
		});
		const client = new CheckpointClient({
			baseUrl: "https://checkpoint.invalid",
			token: "test",
			key: new Uint8Array(32).fill(1),
			fetch: fake,
		});
		for (const [index, invalid] of ["not-a-date", "", "2026-99-99T00:00:00Z"].entries()) {
			expiresAt = invalid;
			const id = `invalid-expiry-${index}`;
			const lease = await client.acquireLease(id, "node-a");
			await expect(client.assertWritable(id, lease.epoch)).rejects.toThrow(/Checkpoint lease lost/);
		}
		expiresAt = "2099-01-01T00:00:00Z";
		const valid = await client.acquireLease("valid-expiry", "node-a");
		await expect(client.assertWritable("valid-expiry", valid.epoch)).resolves.toBeUndefined();
	});

});
