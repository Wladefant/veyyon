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
	test("same-head concurrent commits share one encrypted operation and authority receipt", async () => {
		let uploads = 0;
		let commits = 0;
		let releaseReply!: () => void;
		let commitEntered!: () => void;
		const replyGate = new Promise<void>(resolve => { releaseReply = resolve; });
		const entered = new Promise<void>(resolve => { commitEntered = resolve; });
		const fake: CheckpointFetch = async input => {
			const path = new URL(String(input)).pathname;
			if (path.endsWith("/lease"))
				return Response.json({
					ownerNode: "node-a", epoch: 1, expiresAt: "2099-01-01T00:00:00Z",
					headSequence: 0, manifestHash: "",
				});
			if (path.includes("/objects/")) {
				uploads++;
				return new Response(null, { status: 201 });
			}
			if (path.endsWith("/commit")) {
				commits++;
				commitEntered();
				await replyGate;
				return Response.json({ receipt: "shared" });
			}
			throw new Error(`Unexpected fake authority path: ${path}`);
		};
		const client = new CheckpointClient({
			baseUrl: "https://checkpoint.invalid", token: "test", key: new Uint8Array(32), fetch: fake,
		});
		await client.acquireLease("s", "node-a");
		const first = client.commit("s", bundle, 0);
		const second = client.commit("s", bundle, 0);
		try {
			await entered;
		} finally {
			releaseReply();
		}
		expect(await Promise.all([first, second])).toEqual([{ receipt: "shared" }, { receipt: "shared" }]);
		expect(uploads).toBe(1);
		expect(commits).toBe(1);
	});
	test("a different concurrent same-head payload cannot replace the pending replay", async () => {
		let uploads = 0;
		let commits = 0;
		const fake: CheckpointFetch = async input => {
			const path = new URL(String(input)).pathname;
			if (path.endsWith("/lease"))
				return Response.json({
					ownerNode: "node-a", epoch: 1, expiresAt: "2099-01-01T00:00:00Z",
					headSequence: 0, manifestHash: "",
				});
			if (path.includes("/objects/")) {
				uploads++;
				return new Response(null, { status: 201 });
			}
			if (path.endsWith("/commit")) {
				commits++;
				return Response.json({ receipt: "first" });
			}
			throw new Error(`Unexpected fake authority path: ${path}`);
		};
		const client = new CheckpointClient({
			baseUrl: "https://checkpoint.invalid", token: "test", key: new Uint8Array(32), fetch: fake,
		});
		await client.acquireLease("s", "node-a");
		const first = client.commit("s", bundle, 0);
		const conflicting = client.commit("s", { ...bundle, artifacts: { different: "AA==" } }, 0);
		await expect(conflicting).rejects.toThrow(/Pending checkpoint replay payload changed/);
		expect(await first).toEqual({ receipt: "first" });
		expect(uploads).toBe(1);
		expect(commits).toBe(1);
	});
	test("an ambiguous same-head commit retries with the original idempotency key", async () => {
		const keys: string[] = [];
		const fake: CheckpointFetch = async (input, init) => {
			const path = new URL(String(input)).pathname;
			if (path.endsWith("/lease"))
				return Response.json({
					ownerNode: "node-a", epoch: 1, expiresAt: "2099-01-01T00:00:00Z",
					headSequence: 0, manifestHash: "",
				});
			if (path.includes("/objects/")) return new Response(null, { status: 201 });
			if (path.endsWith("/commit")) {
				keys.push(JSON.parse(String(init?.body)).idempotencyKey);
				if (keys.length === 1) throw new Error("synthetic ambiguous commit response");
				return Response.json({ receipt: "reconciled" });
			}
			throw new Error(`Unexpected fake authority path: ${path}`);
		};
		const client = new CheckpointClient({
			baseUrl: "https://checkpoint.invalid", token: "test", key: new Uint8Array(32), fetch: fake,
		});
		await client.acquireLease("s", "node-a");
		const first = client.commit("s", bundle, 0);
		const second = client.commit("s", bundle, 0);
		await expect(Promise.all([first, second])).rejects.toThrow(/synthetic ambiguous commit response/);
		expect(await client.commit("s", bundle, 0)).toEqual({ receipt: "reconciled" });
		expect(keys).toHaveLength(2);
		expect(new Set(keys).size).toBe(1);
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
			await expect(client.acquireLease(id, "node-a")).rejects.toThrow(/lease fence invalid/);
			await expect(client.assertWritable(id, 4)).rejects.toThrow(/Checkpoint lease lost/);
		}
		expiresAt = "2099-01-01T00:00:00Z";
		const valid = await client.acquireLease("valid-expiry", "node-a");
		await expect(client.assertWritable("valid-expiry", valid.epoch)).resolves.toBeUndefined();
	});
	test("rejects invalid authority lease epochs before opening a writable lease", async () => {
		let epoch: unknown = 4;
		const fake: CheckpointFetch = async () => Response.json({
			ownerNode: "node-a", epoch, expiresAt: "2099-01-01T00:00:00Z",
			headSequence: 0, manifestHash: "",
		});
		const client = new CheckpointClient({
			baseUrl: "https://checkpoint.invalid", token: "test", key: new Uint8Array(32), fetch: fake,
		});
		for (const [index, invalid] of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "4", null].entries()) {
			epoch = invalid;
			const id = `invalid-epoch-${index}`;
			await expect(client.acquireLease(id, "node-a")).rejects.toThrow(/lease fence invalid/);
			await expect(client.assertWritable(id, typeof invalid === "number" ? invalid : 4)).rejects.toThrow(/lease lost/);
		}
		for (const valid of [0, 4]) {
			epoch = valid;
			const id = `valid-epoch-${valid}`;
			const acquired = await client.acquireLease(id, "node-a");
			await expect(client.assertWritable(id, acquired.epoch)).resolves.toBeUndefined();
		}
	});
	test("renewal rejects an expired authority fence and immediately loses local writability", async () => {
		let expiresAt = "2099-01-01T00:00:00Z";
		const fake: CheckpointFetch = async () => Response.json({
			ownerNode: "node-a", epoch: 4, expiresAt, headSequence: 0, manifestHash: "",
		});
		const client = new CheckpointClient({
			baseUrl: "https://checkpoint.invalid", token: "test", key: new Uint8Array(32), fetch: fake,
		});
		const acquired = await client.acquireLease("s", "node-a");
		await expect(client.assertWritable("s", acquired.epoch)).resolves.toBeUndefined();
		expiresAt = "2000-01-01T00:00:00Z";
		await expect(client.renewLease("s")).rejects.toThrow(/lease fence invalid/);
		await expect(client.assertWritable("s", acquired.epoch)).rejects.toThrow(/lease lost/);
	});

});

test("lease response body remains inside the checkpoint timeout", async () => {
	let aborted = false;
	const fake: CheckpointFetch = async (_input, init) => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const timer = setTimeout(() => {
					controller.enqueue(new TextEncoder().encode(JSON.stringify({
						ownerNode: "node-a", epoch: 1, expiresAt: "2099-01-01T00:00:00Z",
						headSequence: 0, manifestHash: "",
					})));
					controller.close();
				}, 200);
				init?.signal?.addEventListener("abort", () => {
					aborted = true;
					clearTimeout(timer);
					controller.error(new DOMException("synthetic response-body abort", "AbortError"));
				}, { once: true });
			},
		});
		return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
	};
	const client = new CheckpointClient({
		baseUrl: "https://checkpoint.invalid", token: "test", key: new Uint8Array(32),
		fetch: fake, timeoutMs: 40,
	});
	await expect(client.acquireLease("s", "node-a")).rejects.toThrow();
	expect(aborted).toBe(true);
	await expect(client.assertWritable("s", 1)).rejects.toThrow(/lease/i);
});

test("restoration rejects an oversized streaming object without consuming a second chunk", async () => {
	const object = { hash: "a".repeat(64), size: 1 };
	const manifest = { objects: [object] };
	const manifestHash = new Bun.SHA256().update(JSON.stringify(manifest)).digest("hex");
	let pulls = 0;
	const fake: CheckpointFetch = async input => {
		const path = new URL(String(input)).pathname;
		if (path.endsWith("/head")) return Response.json({ sequence: 1, manifestHash, manifest });
		if (path.includes("/objects/")) {
			const stream = new ReadableStream<Uint8Array>({
				pull(controller) {
					pulls++;
					if (pulls === 1) controller.enqueue(new Uint8Array([1, 2]));
					else controller.error(new Error("an unbounded reader consumed a second object chunk"));
				},
			}, { highWaterMark: 0 });
			return new Response(stream, { status: 200 });
		}
		return new Response(null, { status: 404 });
	};
	const client = new CheckpointClient({
		baseUrl: "https://checkpoint.invalid", token: "test", key: new Uint8Array(32),
		fetch: fake, timeoutMs: 1000,
	});
	await expect(client.restore("s")).rejects.toThrow(/Checkpoint object integrity check failed/);
	expect(pulls).toBe(1);
});

test("restoration aborts a stalled object body before its eventual bytes", async () => {
	const object = { hash: "a".repeat(64), size: 1 };
	const manifest = { objects: [object] };
	const manifestHash = new Bun.SHA256().update(JSON.stringify(manifest)).digest("hex");
	let aborted = false;
	const fake: CheckpointFetch = async (input, init) => {
		const path = new URL(String(input)).pathname;
		if (path.endsWith("/head")) return Response.json({ sequence: 1, manifestHash, manifest });
		if (path.includes("/objects/")) {
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					const timer = setTimeout(() => {
						controller.enqueue(new Uint8Array([1]));
						controller.close();
					}, 200);
					init?.signal?.addEventListener("abort", () => {
						aborted = true;
						clearTimeout(timer);
						controller.error(new DOMException("synthetic object-body abort", "AbortError"));
					}, { once: true });
				},
			});
			return new Response(stream, { status: 200 });
		}
		return new Response(null, { status: 404 });
	};
	const client = new CheckpointClient({
		baseUrl: "https://checkpoint.invalid", token: "test", key: new Uint8Array(32),
		fetch: fake, timeoutMs: 40,
	});
	await expect(client.restore("s")).rejects.toThrow();
	expect(aborted).toBe(true);
});

test("checkpoint transfer grants reject an authority response for a different runtime owner", async () => {
	const actions: string[] = [];
	const fake: CheckpointFetch = async input => {
		actions.push(new URL(String(input)).pathname.split("/").pop()!);
		return Response.json({
			ownerNode: "owner-b", epoch: 5, expiresAt: "2099-01-01T00:00:00Z",
			headSequence: 0, manifestHash: "", resumeToken: "a-long-enough-resume-capability",
		});
	};
	const client = new CheckpointClient({
		baseUrl: "https://checkpoint.invalid", token: "test", key: new Uint8Array(32), fetch: fake,
	});
	await expect(
		client.claimTransfer("s1", "destination", "transfer-1", "a-long-enough-claim-token", 4, "owner-a"),
	).rejects.toThrow(/lease owner mismatch/);
	await expect(
		client.resumeTransfer("s2", "destination", "transfer-2", "a-long-enough-resume-capability", 4, "owner-a"),
	).rejects.toThrow(/lease owner mismatch/);
	await expect(client.assertWritable("s1", 5)).rejects.toThrow(/lease lost/);
	await expect(client.assertWritable("s2", 5)).rejects.toThrow(/lease lost/);
	expect(actions).toEqual(["claim", "claim"]);
});

test("checkpoint renewal refuses a changed authority owner and revokes its cached lease", async () => {
	let wrongOwner = false;
	const fake: CheckpointFetch = async () => Response.json({
		ownerNode: wrongOwner ? "owner-b" : "owner-a",
		epoch: 1, expiresAt: "2099-01-01T00:00:00Z", headSequence: 0, manifestHash: "",
	});
	const client = new CheckpointClient({
		baseUrl: "https://checkpoint.invalid", token: "test", key: new Uint8Array(32), fetch: fake,
	});
	const valid = await client.acquireLease("s", "owner-a");
	await expect(client.assertWritable("s", valid.epoch)).resolves.toBeUndefined();
	wrongOwner = true;
	await expect(client.renewLease("s")).rejects.toThrow(/lease owner mismatch/);
	await expect(client.assertWritable("s", valid.epoch)).rejects.toThrow(/lease lost/);
});
test("an uncertain transfer fences the old writer before the remote answer and never reacquires after two errors", async () => {
	let signalFirst!: () => void;
	let finishFirst!: () => void;
	const firstStarted = new Promise<void>(resolve => { signalFirst = resolve; });
	const firstComplete = new Promise<void>(resolve => { finishFirst = resolve; });
	let transfers = 0;
	const fake: CheckpointFetch = async input => {
		const action = new URL(String(input)).pathname.split("/").pop()!;
		if (action === "lease")
			return Response.json({
				ownerNode: "source", epoch: 4, expiresAt: "2099-01-01T00:00:00Z",
				headSequence: 0, manifestHash: "",
			});
		if (action !== "transfer") throw new Error(`Unexpected authority call: ${action}`);
		transfers++;
		if (transfers === 1) {
			signalFirst();
			await firstComplete;
		}
		throw new Error(`synthetic transport failure ${transfers}`);
	};
	const client = new CheckpointClient({
		baseUrl: "https://checkpoint.invalid", token: "test", key: new Uint8Array(32), fetch: fake,
	});
	const grant = await client.acquireLease("ambiguous-transfer", "source");
	await expect(client.assertWritable("ambiguous-transfer", grant.epoch)).resolves.toBeUndefined();
	const transfer = client.transferLease(
		"ambiguous-transfer", "destination", "a-long-enough-claim-token", "transfer-1",
	);
	try {
		await firstStarted;
		await expect(client.assertWritable("ambiguous-transfer", grant.epoch)).rejects.toThrow(/lease lost/);
	} finally {
		finishFirst();
	}
	await expect(transfer).rejects.toThrow(/synthetic transport failure 1/);
	expect(transfers).toBe(2);
	await expect(client.assertWritable("ambiguous-transfer", grant.epoch)).rejects.toThrow(/lease lost/);
});

test("transfer receipt must bind target owner, next epoch, and live deadline before reporting success", async () => {
	const scenarios: Array<{ name: string; ownerNode: string; epoch: number | undefined; expiresAt: string; valid: boolean }> = [
		{ name: "valid", ownerNode: "destination", epoch: 5, expiresAt: "2099-01-01T00:00:00Z", valid: true },
		{ name: "wrong-owner", ownerNode: "foreign", epoch: 5, expiresAt: "2099-01-01T00:00:00Z", valid: false },
		{ name: "stale-epoch", ownerNode: "destination", epoch: 4, expiresAt: "2099-01-01T00:00:00Z", valid: false },
		{ name: "skipped-epoch", ownerNode: "destination", epoch: 6, expiresAt: "2099-01-01T00:00:00Z", valid: false },
		{ name: "missing-epoch", ownerNode: "destination", epoch: undefined, expiresAt: "2099-01-01T00:00:00Z", valid: false },
		{ name: "expired", ownerNode: "destination", epoch: 5, expiresAt: "2000-01-01T00:00:00Z", valid: false },
		{ name: "malformed-expiry", ownerNode: "destination", epoch: 5, expiresAt: "not-a-date", valid: false },
	];
	for (const scenario of scenarios) {
		let transfers = 0;
		const fake: CheckpointFetch = async input => {
			const action = new URL(String(input)).pathname.split("/").pop()!;
			if (action === "lease")
				return Response.json({
					ownerNode: "source", epoch: 4, expiresAt: "2099-01-01T00:00:00Z",
					headSequence: 0, manifestHash: "",
				});
			if (action !== "transfer") throw new Error(`Unexpected authority call: ${action}`);
			transfers++;
			return Response.json({
				ownerNode: scenario.ownerNode, epoch: scenario.epoch, expiresAt: scenario.expiresAt,
				headSequence: 0, manifestHash: "",
			});
		};
		const client = new CheckpointClient({
			baseUrl: "https://checkpoint.invalid", token: "test", key: new Uint8Array(32), fetch: fake,
		});
		const sessionId = `transfer-receipt-${scenario.name}`;
		const grant = await client.acquireLease(sessionId, "source");
		if (scenario.valid) {
			const receipt = await client.transferLease(sessionId, "destination", "a-long-enough-claim-token", "transfer-2");
			expect(receipt.ownerNode).toBe("destination");
			expect(receipt.epoch).toBe(5);
		} else {
			await expect(client.transferLease(
				sessionId, "destination", "a-long-enough-claim-token", "transfer-2",
			)).rejects.toThrow(/transfer receipt mismatch/);
		}
		expect(transfers).toBe(1);
		await expect(client.assertWritable(sessionId, grant.epoch)).rejects.toThrow(/lease lost/);
	}
});
