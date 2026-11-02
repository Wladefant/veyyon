import { describe, expect, test } from "bun:test";
import {
	type CheckpointBundle,
	CheckpointClient,
	type CheckpointFetch,
	decryptCheckpointBundle,
	encryptCheckpointBundle,
	filterCheckpointFiles,
} from "../src/checkpoints/cloud-checkpoints";
import { SynchronizedSession } from "../src/checkpoints/synchronized-session";

const bundle: CheckpointBundle = {
	version: 1,
	native: { sessionId: "s", header: { type: "session", id: "s", cwd: "/repo" }, sessionFile: "session.jsonl" },
	journal: { path: "session.jsonl", bytes: "e30K" },
	artifacts: { a: "YmxvYg==" },
	blobs: {},
	workspace: { dirty: ["src/a.ts"], files: [] },
	pins: { bun: "1", commit: "a".repeat(40), runtime: "v1" },
};
// Mirror the pinned authority Worker commit response, not a generic HTTP 200.
function commitHeadForRequest(init?: RequestInit) {
	const { manifest } = JSON.parse(String(init?.body)) as {
		manifest: { version: 1; sessionId: string; sequence: number; objects: { hash: string; size: number }[] };
	};
	return {
		sequence: manifest.sequence,
		manifestHash: new Bun.SHA256().update(JSON.stringify(manifest)).digest("hex"),
		manifest,
	};
}

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
		const fake: CheckpointFetch = async (input, init) => {
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
				return Response.json(commitHeadForRequest(init));
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
		const outcomes = await Promise.all([first, second]);
		expect(outcomes).toEqual([outcomes[0], outcomes[0]]);
		expect(outcomes[0]).toMatchObject({ sequence: 1 });
		expect(uploads).toBe(1);
		expect(commits).toBe(1);
	});
	test("a different concurrent same-head payload cannot replace the pending replay", async () => {
		let uploads = 0;
		let commits = 0;
		const fake: CheckpointFetch = async (input, init) => {
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
				return Response.json(commitHeadForRequest(init));
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
		expect(await first).toMatchObject({ sequence: 1 });
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
				return Response.json(commitHeadForRequest(init));
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
		expect(await client.commit("s", bundle, 0)).toMatchObject({ sequence: 1 });
		expect(keys).toHaveLength(2);
		expect(new Set(keys).size).toBe(1);
	});

	test("an unverified 200 commit receipt retains the original idempotency key for reconciliation", async () => {
		const corruptions = [
			{ name: "missing receipt", change: (_head: ReturnType<typeof commitHeadForRequest>) => null },
			{ name: "wrong sequence", change: (head: ReturnType<typeof commitHeadForRequest>) => ({ ...head, sequence: head.sequence + 1 }) },
			{ name: "wrong manifest hash", change: (head: ReturnType<typeof commitHeadForRequest>) => ({ ...head, manifestHash: "0".repeat(64) }) },
			{ name: "wrong manifest", change: (head: ReturnType<typeof commitHeadForRequest>) => ({ ...head, manifest: { ...head.manifest, sessionId: "other-session" } }) },
		];
		for (const corruption of corruptions) {
			let commitCalls = 0;
			const keys: string[] = [];
			const fake: CheckpointFetch = async (input, init) => {
				const path = new URL(String(input)).pathname;
				if (path.endsWith("/lease")) return Response.json({
					ownerNode: "node-a", epoch: 1, expiresAt: "2099-01-01T00:00:00Z",
					headSequence: 0, manifestHash: "",
				});
				if (path.includes("/objects/")) return new Response(null, { status: 201 });
				if (path.endsWith("/commit")) {
					keys.push(JSON.parse(String(init?.body)).idempotencyKey);
					const head = commitHeadForRequest(init);
					return Response.json(++commitCalls === 1 ? corruption.change(head) : head);
				}
				throw new Error(`Unexpected authority call in ${corruption.name}: ${path}`);
			};
			const client = new CheckpointClient({
				baseUrl: "https://checkpoint.invalid", token: "test", key: new Uint8Array(32), fetch: fake,
			});
			await client.acquireLease("s", "node-a");
			await expect(client.commit("s", bundle, 0)).rejects.toThrow(/commit receipt mismatch/);
			expect(await client.commit("s", bundle, 0)).toMatchObject({ sequence: 1 });
			expect(commitCalls).toBe(2);
			expect(new Set(keys).size).toBe(1);
		}
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

test("checkpoint authority JSON refuses an oversized first chunk without consuming a second", async () => {
	let pulls = 0;
	const fake: CheckpointFetch = async () => new Response(new ReadableStream<Uint8Array>({
		pull(controller) {
			pulls++;
			if (pulls === 1) controller.enqueue(new Uint8Array(256 * 1024 + 1));
			else controller.error(new Error("oversized JSON reader consumed a second chunk"));
		},
	}, { highWaterMark: 0 }), { status: 200 });
	const client = new CheckpointClient({
		baseUrl: "https://checkpoint.invalid", token: "test", key: new Uint8Array(32), fetch: fake,
	});
	await expect(client.acquireLease("s", "node-a")).rejects.toThrow(/JSON exceeds 256 KiB/);
	expect(pulls).toBe(1);
	await expect(client.assertWritable("s", 1)).rejects.toThrow(/lease/i);
});

test("checkpoint authority JSON accepts a valid response split across streaming chunks", async () => {
	const receipt = {
		ownerNode: "node-a", epoch: 1, expiresAt: "2099-01-01T00:00:00Z",
		headSequence: 0, manifestHash: "",
	};
	const bytes = new TextEncoder().encode(JSON.stringify(receipt));
	const fake: CheckpointFetch = async () => new Response(new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes.subarray(0, 7));
			controller.enqueue(bytes.subarray(7));
			controller.close();
		},
	}), { status: 200 });
	const client = new CheckpointClient({
		baseUrl: "https://checkpoint.invalid", token: "test", key: new Uint8Array(32), fetch: fake,
	});
	expect(await client.acquireLease("s", "node-a")).toEqual(receipt);
	await expect(client.assertWritable("s", receipt.epoch)).resolves.toBeUndefined();
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

test("malformed transfer identities and capabilities fail before a claim request", async () => {
	let calls = 0;
	const fake: CheckpointFetch = async () => {
		calls++;
		throw new Error("Invalid transfer must never reach the authority");
	};
	const client = new CheckpointClient({
		baseUrl: "https://checkpoint.invalid", token: "test", key: new Uint8Array(32), fetch: fake,
	});
	const claim = "a-long-enough-claim-token";
	const resume = "a-long-enough-resume-capability";
	for (const epoch of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
		await expect(client.claimTransfer("s", "destination", "transfer-1", claim, epoch, "owner-a"))
			.rejects.toThrow(/Invalid checkpoint transfer identity/);
		await expect(client.resumeTransfer("s", "destination", "transfer-1", resume, epoch, "owner-a"))
			.rejects.toThrow(/Invalid checkpoint transfer identity/);
	}
	for (const transferId of ["", "path/escape", "space id", "x".repeat(129)]) {
		await expect(client.claimTransfer("s", "destination", transferId, claim, 2, "owner-a"))
			.rejects.toThrow(/Invalid checkpoint transfer identity/);
	}
	for (const capability of ["", "short", "x".repeat(129)]) {
		await expect(client.claimTransfer("s", "destination", "transfer-1", capability, 2, "owner-a"))
			.rejects.toThrow(/Invalid checkpoint transfer capability/);
		await expect(client.resumeTransfer("s", "destination", "transfer-1", capability, 2, "owner-a"))
			.rejects.toThrow(/Invalid checkpoint transfer capability/);
	}
	expect(calls).toBe(0);
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

// WHY: a successful /claim JSON response can carry a different transfer's
// runtime lease. The requested one-use transfer identity must match before
// admission for both initial claims and later resume-capability redemption.
test("claim and resume receipts bind the requested target and transfer identity", async () => {
	const scenarios = [
		{ name: "valid", targetNode: "destination-device", transferId: "transfer-1", valid: true },
		{ name: "foreign target", targetNode: "other-device", transferId: "transfer-1", valid: false },
		{ name: "missing target", targetNode: undefined, transferId: "transfer-1", valid: false },
		{ name: "foreign transfer", targetNode: "destination-device", transferId: "transfer-2", valid: false },
		{ name: "missing transfer", targetNode: "destination-device", transferId: undefined, valid: false },
	] as const;
	for (const action of ["claim", "resume"] as const) {
		for (const scenario of scenarios) {
			const fake: CheckpointFetch = async input => {
				expect(new URL(String(input)).pathname.endsWith("/claim")).toBe(true);
				return Response.json({
					ownerNode: "runtime-owner", epoch: 5, expiresAt: "2099-01-01T00:00:00Z",
					headSequence: 0, manifestHash: "",
					...(scenario.targetNode === undefined ? {} : { targetNode: scenario.targetNode }),
					...(scenario.transferId === undefined ? {} : { transferId: scenario.transferId }),
					resumeToken: "a-long-enough-pending-resume-capability",
				});
			};
			const client = new CheckpointClient({
				baseUrl: "https://checkpoint.invalid", token: "test", key: new Uint8Array(32), fetch: fake,
			});
			const grant = action === "claim"
				? client.claimTransfer("identity-s", "destination-device", "transfer-1", "a-long-enough-claim-capability", 4, "runtime-owner")
				: client.resumeTransfer("identity-s", "destination-device", "transfer-1", "a-long-enough-resume-capability", 4, "runtime-owner");
			if (scenario.valid) {
				const accepted = await grant;
				expect(accepted.lease.targetNode).toBe("destination-device");
				expect(accepted.lease.transferId).toBe("transfer-1");
				await expect(client.assertWritable("identity-s", 5)).resolves.toBeUndefined();
			} else {
				await expect(grant).rejects.toThrow(/transfer grant identity mismatch/);
				await expect(client.assertWritable("identity-s", 5)).rejects.toThrow(/lease lost/);
			}
		}
	}
});

test("an overlong authority resume capability cannot replace a one-time transfer claim", async () => {
	let calls = 0;
	const fake: CheckpointFetch = async () => {
		calls++;
		return Response.json({
			ownerNode: "owner-a",
			epoch: 5,
			expiresAt: "2099-01-01T00:00:00Z",
			headSequence: 0,
			manifestHash: "",
			targetNode: "destination",
			transferId: "transfer-1",
			resumeToken: "x".repeat(129),
		});
	};
	const client = new CheckpointClient({
		baseUrl: "https://checkpoint.invalid", token: "test", key: new Uint8Array(32), fetch: fake,
	});
	await expect(
		client.claimTransfer("session-a", "destination", "transfer-1", "a-long-enough-claim-token", 4, "owner-a"),
	).rejects.toThrow(/valid resume capability/);
	await expect(client.assertWritable("session-a", 5)).rejects.toThrow(/lease lost/);
	expect(calls).toBe(1);
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

test("transfer receipt must bind target identity, transfer ID, next epoch, and live deadline", async () => {
	const scenarios: Array<{ name: string; ownerNode: string; epoch: number | undefined; expiresAt: string; valid: boolean; targetNode?: string; transferId?: string }> = [
		{ name: "valid", ownerNode: "destination", epoch: 5, expiresAt: "2099-01-01T00:00:00Z", valid: true },
		{ name: "wrong-owner", ownerNode: "foreign", epoch: 5, expiresAt: "2099-01-01T00:00:00Z", valid: false },
		{ name: "stale-epoch", ownerNode: "destination", epoch: 4, expiresAt: "2099-01-01T00:00:00Z", valid: false },
		{ name: "skipped-epoch", ownerNode: "destination", epoch: 6, expiresAt: "2099-01-01T00:00:00Z", valid: false },
		{ name: "missing-epoch", ownerNode: "destination", epoch: undefined, expiresAt: "2099-01-01T00:00:00Z", valid: false },
		{ name: "expired", ownerNode: "destination", epoch: 5, expiresAt: "2000-01-01T00:00:00Z", valid: false },
		{ name: "malformed-expiry", ownerNode: "destination", epoch: 5, expiresAt: "not-a-date", valid: false },
		{ name: "wrong-target", ownerNode: "destination", epoch: 5, expiresAt: "2099-01-01T00:00:00Z", targetNode: "other-device", valid: false },
		{ name: "missing-target", ownerNode: "destination", epoch: 5, expiresAt: "2099-01-01T00:00:00Z", targetNode: undefined, valid: false },
		{ name: "wrong-transfer", ownerNode: "destination", epoch: 5, expiresAt: "2099-01-01T00:00:00Z", transferId: "other-transfer", valid: false },
		{ name: "missing-transfer", ownerNode: "destination", epoch: 5, expiresAt: "2099-01-01T00:00:00Z", transferId: undefined, valid: false },
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
				targetNode: "targetNode" in scenario ? scenario.targetNode : "destination",
				transferId: "transferId" in scenario ? scenario.transferId : "transfer-2",
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
			expect(receipt.targetNode).toBe("destination");
			expect(receipt.transferId).toBe("transfer-2");
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

// WHY: a definite HTTP rejection is not a lost transport response, so the
// one-use transfer must not be retried. Synthetic responses cannot prove a
// live checkpoint authority or a network timeout/reconciliation outcome.
test("definite transfer refusals are not replayed while ambiguous statuses retry at most once", async () => {
	for (const [status, expectedCalls] of [
		[400, 1], [401, 1], [403, 1], [404, 1], [409, 1], [422, 1],
		[408, 2], [429, 2], [500, 2], [503, 2],
	] as const) {
		let transfers = 0;
		const fake: CheckpointFetch = async input => {
			const action = new URL(String(input)).pathname.split("/").pop();
			if (action === "lease")
				return Response.json({
					ownerNode: "source", epoch: 4, expiresAt: "2099-01-01T00:00:00Z",
					headSequence: 0, manifestHash: "",
				});
			if (action === "transfer") {
				transfers++;
				return new Response("synthetic authority rejection", { status });
			}
			throw new Error(`Unexpected authority call: ${action}`);
		};
		const client = new CheckpointClient({
			baseUrl: "https://checkpoint.invalid", token: "test", key: new Uint8Array(32), fetch: fake,
		});
		const sessionId = `definite-refusal-${status}`;
		const grant = await client.acquireLease(sessionId, "source");
		await expect(
			client.transferLease(sessionId, "destination", "a-long-enough-claim-token", "transfer-1"),
		).rejects.toThrow(new RegExp(`HTTP ${status}`));
		expect(transfers).toBe(expectedCalls);
		await expect(client.assertWritable(sessionId, grant.epoch)).rejects.toThrow(/lease lost/);
	}
});


// WHY: HTTP 200 from /finalize does not prove the one-use resume capability
// was promoted. A false-success receipt must not unlock the transferred session.
test("checkpoint finalization accepts only affirmative authority receipts", async () => {
	const cases = [
		{ name: "missing", receipt: null, valid: false },
		{ name: "negative", receipt: { ok: false }, valid: false },
		{ name: "wrong-type", receipt: { ok: "true" }, valid: false },
		{ name: "no-ok-field", receipt: {}, valid: false },
		{ name: "confirmed", receipt: { ok: true }, valid: true },
	] as const;
	for (const scenario of cases) {
		const actions: string[] = [];
		const fake: CheckpointFetch = async input => {
			const action = new URL(String(input)).pathname.split("/").pop()!;
			actions.push(action);
			if (action === "claim") return Response.json({
				ownerNode: "runtime-owner", epoch: 5, expiresAt: "2099-01-01T00:00:00Z",
				headSequence: 0, manifestHash: "",
				targetNode: "destination-device", transferId: "transfer-1",
				resumeToken: "a-long-enough-pending-resume-capability",
			});
			if (action === "finalize") return Response.json(scenario.receipt);
			throw new Error(`Unexpected fake authority call: ${action}`);
		};
		const client = new CheckpointClient({
			baseUrl: "https://checkpoint.invalid", token: "test", key: new Uint8Array(32), fetch: fake,
		});
		const sessionId = `confirm-${scenario.name}`;
		const grant = await client.claimTransfer(
			sessionId, "destination-device", "transfer-1",
			"a-long-enough-claim-capability", 4, "runtime-owner",
		);
		const request = client.finalizeTransfer(
			sessionId, "destination-device", "transfer-1",
			4, grant.lease.epoch, grant.resumeToken,
		);
		if (scenario.valid) await expect(request).resolves.toBeUndefined();
		else await expect(request).rejects.toThrow(/finalization receipt mismatch/);
		expect(actions).toEqual(["claim", "finalize"]);
	}
});

test("nonconfirming transfer finalization fences session admission but permits one cleanup release", async () => {
	const previousNode = process.env.VEYYON_CHECKPOINT_NODE;
	process.env.VEYYON_CHECKPOINT_NODE = "destination-device";
	const actions: string[] = [];
	let persisted = 0;
	const fake: CheckpointFetch = async input => {
		const action = new URL(String(input)).pathname.split("/").pop()!;
		actions.push(action);
		if (action === "finalize") return Response.json({ ok: false });
		if (action === "claim") return Response.json({
			ownerNode: "runtime-owner", epoch: 5, expiresAt: "2099-01-01T00:00:00Z",
			headSequence: 0, manifestHash: "",
			targetNode: "destination-device", transferId: "transfer-1",
			resumeToken: "a-long-enough-pending-resume-capability",
		});
		if (action === "release") return Response.json({
			ownerNode: "runtime-owner", epoch: 6, expiresAt: "1970-01-01T00:00:00Z",
			headSequence: 0, manifestHash: "",
		});
		throw new Error(`Unexpected fake authority call: ${action}`);
	};
	const session = new SynchronizedSession(
		"nonconfirming-finalize",
		new CheckpointClient({
			baseUrl: "https://checkpoint.invalid", token: "test", key: new Uint8Array(32), fetch: fake,
		}),
		{
			version: 1, sessionId: "nonconfirming-finalize", targetNode: "destination-device",
			transferId: "transfer-1", transferEpoch: 4,
			claimToken: "a-long-enough-claim-capability", epoch: 4,
		},
		"runtime-owner",
		async () => { persisted++; },
	);
	try {
		await expect(session.admit()).rejects.toThrow(/finalization receipt mismatch/);
		await expect(session.admit()).rejects.toThrow(/Synchronized ownership lost/);
		await session.close();
		expect(actions).toEqual(["claim", "finalize", "release"]);
		expect(persisted).toBe(1);
	} finally {
		if (previousNode === undefined) delete process.env.VEYYON_CHECKPOINT_NODE;
		else process.env.VEYYON_CHECKPOINT_NODE = previousNode;
	}
});
