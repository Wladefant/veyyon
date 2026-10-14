import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckpointFetch } from "../src/checkpoints/cloud-checkpoints";
import { runCheckpointCommand } from "../src/cli/checkpoint-cli";
import { Settings } from "../src/config/settings";

test("separate CLI invocations on one host use independent lease owners", async () => {
	const root = await mkdtemp(join(tmpdir(), "checkpoint-cli-"));
	const file = join(root, "session.jsonl");
	await writeFile(file, `${JSON.stringify({ type: "session", id: "same-host", cwd: root })}\n`);
	await Settings.init({ inMemory: true, overrides: { "checkpoints.enabled": true } });
	const previousFetch = globalThis.fetch;
	const previousEnv = {
		url: process.env.VEYYON_CHECKPOINT_URL,
		token: process.env.VEYYON_CHECKPOINT_TOKEN,
		key: process.env.VEYYON_CHECKPOINT_KEY,
		node: process.env.VEYYON_CHECKPOINT_NODE,
	};
	delete process.env.VEYYON_CHECKPOINT_NODE;
	process.env.VEYYON_CHECKPOINT_URL = "https://checkpoint.invalid";
	process.env.VEYYON_CHECKPOINT_TOKEN = "test";
	process.env.VEYYON_CHECKPOINT_KEY = Buffer.alloc(32).toString("base64");
	const owners: string[] = [];
	const fakeFetch: CheckpointFetch = async (input, init) => {
		const path = new URL(String(input)).pathname;
		if (path.endsWith("/lease")) {
			const body: unknown = JSON.parse(String(init?.body));
			if (!body || typeof body !== "object" || !("ownerNode" in body) || typeof body.ownerNode !== "string")
				throw new Error("Missing lease owner");
			owners.push(body.ownerNode);
			return Response.json({
				ownerNode: body.ownerNode,
				epoch: owners.length,
				expiresAt: "2099-01-01T00:00:00Z",
				headSequence: 0,
				manifestHash: "",
			});
		}
		if (path.includes("/objects/")) return new Response(null, { status: 201 });
		if (path.endsWith("/head")) return Response.json(null);
		return Response.json({ committed: true });
	};
	globalThis.fetch = Object.assign(fakeFetch, { preconnect: previousFetch.preconnect });
	try {
		await runCheckpointCommand({ action: "export", sessionFile: file });
		await runCheckpointCommand({ action: "export", sessionFile: file });
		expect(owners).toHaveLength(2);
		expect(owners[0]).not.toBe(owners[1]);
	} finally {
		globalThis.fetch = previousFetch;
		for (const [key, value] of Object.entries({
			VEYYON_CHECKPOINT_URL: previousEnv.url,
			VEYYON_CHECKPOINT_TOKEN: previousEnv.token,
			VEYYON_CHECKPOINT_KEY: previousEnv.key,
			VEYYON_CHECKPOINT_NODE: previousEnv.node,
		})) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await Settings.init({ inMemory: true });
		await rm(root, { recursive: true, force: true });
	}
});

test("an interrupted handoff preserves source journal data and avoids overwriting the destination", async () => {
	const root = await mkdtemp(join(tmpdir(), "checkpoint-transfer-"));
	const source = join(root, "session.jsonl");
	const destination = join(root, "destination");
	const sourceBytes = Buffer.from(`${JSON.stringify({ type: "session", id: "transfer", cwd: root })}\n`);
	await writeFile(source, sourceBytes);
	const assertSourceRetained = async () => {
		const text = await Bun.file(source).text();
		const header = JSON.parse(text.split("\n")[0]!) as Record<string, unknown>;
		expect(header).toMatchObject({ type: "session", id: "transfer", cwd: root });
		expect(text.split("\n").slice(1).join("\n")).toBe(sourceBytes.toString("utf8").split("\n").slice(1).join("\n"));
	};
	await Settings.init({ inMemory: true, overrides: { "checkpoints.enabled": true } });
	const previousFetch = globalThis.fetch;
	const previousEnv = {
		url: process.env.VEYYON_CHECKPOINT_URL,
		token: process.env.VEYYON_CHECKPOINT_TOKEN,
		key: process.env.VEYYON_CHECKPOINT_KEY,
		node: process.env.VEYYON_CHECKPOINT_NODE,
	};
	process.env.VEYYON_CHECKPOINT_URL = "https://checkpoint.invalid";
	process.env.VEYYON_CHECKPOINT_TOKEN = "test";
	process.env.VEYYON_CHECKPOINT_KEY = Buffer.alloc(32).toString("base64");
	process.env.VEYYON_CHECKPOINT_NODE = "transfer-owner";
	const objects = new Map<string, Uint8Array>();
	let head: { sequence: number; manifestHash: string; manifest: { objects: { hash: string; size: number }[] } } | null =
		null;
	let leaseOwner = "transfer-owner";
	let leaseEpoch = 1;
	let transferReplay:
		| { transferId: string; ownerNode: string; epoch: number; targetNode: string; claimToken: string }
		| undefined;
	let interruptedTransferResponses = 2;
	let interruptCommit = true;
	const fakeFetch: CheckpointFetch = async (input, init) => {
		const path = new URL(String(input)).pathname;
		if (path.endsWith("/lease")) {
			const request = JSON.parse(String(init?.body)) as { ownerNode: string };
			if (request.ownerNode !== leaseOwner)
				return Response.json({ error: "owned" }, { status: 409 });
			return Response.json({
				ownerNode: leaseOwner,
				epoch: leaseEpoch,
				expiresAt: "2099-01-01T00:00:00Z",
				headSequence: head?.sequence ?? 0,
				manifestHash: head?.manifestHash ?? "",
			});
		}
		if (path.endsWith("/transfer")) {
			const request = JSON.parse(String(init?.body)) as {
				ownerNode: string;
				epoch: number;
				targetNode: string;
				claimToken: string;
				transferId: string;
			};
			if (transferReplay?.transferId === request.transferId) {
				if (
					transferReplay.ownerNode !== request.ownerNode ||
					transferReplay.epoch !== request.epoch ||
					transferReplay.targetNode !== request.targetNode ||
					transferReplay.claimToken !== request.claimToken
				)
					return Response.json({ error: "transfer replay mismatch" }, { status: 409 });
				if (interruptedTransferResponses > 0) {
					interruptedTransferResponses--;
					return Response.json({ error: "ack interrupted" }, { status: 503 });
				}
				return Response.json({
					ownerNode: leaseOwner,
					epoch: leaseEpoch,
					expiresAt: "2099-01-01T00:00:00Z",
					headSequence: head?.sequence ?? 0,
					manifestHash: head?.manifestHash ?? "",
				});
			}
			if (request.ownerNode !== leaseOwner || request.epoch !== leaseEpoch)
				return Response.json({ error: "stale writer" }, { status: 409 });
			leaseOwner = request.targetNode;
			leaseEpoch++;
			transferReplay = {
				transferId: request.transferId,
				ownerNode: request.ownerNode,
				epoch: request.epoch,
				targetNode: request.targetNode,
				claimToken: request.claimToken,
			};
			if (interruptedTransferResponses > 0) {
				interruptedTransferResponses--;
				return Response.json({ error: "ack interrupted" }, { status: 503 });
			}
			return Response.json({
				ownerNode: leaseOwner,
				epoch: leaseEpoch,
				expiresAt: "2099-01-01T00:00:00Z",
				headSequence: head?.sequence ?? 0,
				manifestHash: head?.manifestHash ?? "",
			});
		}
		if (path.endsWith("/release")) return new Response(null, { status: 204 });
		if (path.endsWith("/head")) return Response.json(head);
		if (path.includes("/objects/")) {
			const hash = path.split("/").pop()!;
			if (init?.method === "PUT") {
				const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
				objects.set(hash, bytes);
				return new Response(null, { status: 201 });
			}
			const bytes = objects.get(hash);
			return bytes ? new Response(bytes) : new Response(null, { status: 404 });
		}
		if (path.endsWith("/commit")) {
			if (interruptCommit) {
				interruptCommit = false;
				return Response.json({ error: "interrupted" }, { status: 503 });
			}
			const request = JSON.parse(String(init?.body)) as {
				expectedHead: number;
				manifest: { objects: { hash: string; size: number }[] };
			};
			head = {
				sequence: request.expectedHead + 1,
				manifest: request.manifest,
				manifestHash: new Bun.SHA256().update(JSON.stringify(request.manifest)).digest("hex"),
			};
			return Response.json(head);
		}
		throw new Error(`Unexpected checkpoint request: ${path}`);
	};
	globalThis.fetch = Object.assign(fakeFetch, { preconnect: previousFetch.preconnect });
	try {
		await expect(runCheckpointCommand({ action: "export", sessionFile: source })).rejects.toThrow(/503/);
		expect(Buffer.from(await Bun.file(source).arrayBuffer())).toEqual(sourceBytes);
		await runCheckpointCommand({ action: "export", sessionFile: source });
		expect(Buffer.from(await Bun.file(source).arrayBuffer())).toEqual(sourceBytes);
		await expect(runCheckpointCommand({
			action: "handoff",
			id: "transfer",
			sessionFile: source,
			targetNode: "destination",
		})).rejects.toThrow(/503/);
		await assertSourceRetained();
		await runCheckpointCommand({
			action: "handoff",
			id: "transfer",
			sessionFile: source,
			targetNode: "destination",
		});
		expect(leaseOwner).toBe("destination");
		await assertSourceRetained();
		process.env.VEYYON_CHECKPOINT_NODE = "destination";
		await runCheckpointCommand({ action: "restore", id: "transfer", output: destination });
		const ownership = JSON.parse(await Bun.file(join(destination, "sessions", "checkpoint-ownership.json")).text()) as {
			version: number;
			sessionId: string;
			targetNode: string;
			claimToken: string;
			transferId: string;
			transferEpoch: number;
		};
		expect(ownership).toMatchObject({
			version: 1,
			sessionId: "transfer",
			targetNode: "destination",
			transferId: expect.any(String),
			transferEpoch: 2,
		});
		expect(ownership.claimToken.length).toBeGreaterThan(0);
		expect(ownership.epoch).toBe(2);
		const recovery = JSON.parse(await Bun.file(join(destination, "recovery.json")).text()) as {
			checkpointTransfer: boolean;
		};
		expect(recovery.checkpointTransfer).toBe(true);
		const restored = await Bun.file(join(destination, "sessions", "session.jsonl")).arrayBuffer();
		expect(Buffer.from(restored)).toEqual(Buffer.from(await Bun.file(source).arrayBuffer()));
		await expect(runCheckpointCommand({ action: "restore", id: "transfer", output: destination })).rejects.toThrow(
			/already exists/,
		);
		expect(Buffer.from(await Bun.file(join(destination, "sessions", "session.jsonl")).arrayBuffer())).toEqual(
			Buffer.from(restored),
		);
	} finally {
		globalThis.fetch = previousFetch;
		for (const [key, value] of Object.entries({
			VEYYON_CHECKPOINT_URL: previousEnv.url,
			VEYYON_CHECKPOINT_TOKEN: previousEnv.token,
			VEYYON_CHECKPOINT_KEY: previousEnv.key,
			VEYYON_CHECKPOINT_NODE: previousEnv.node,
		})) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await Settings.init({ inMemory: true });
		await rm(root, { recursive: true, force: true });
	}
});
test("an explicitly forked native session remains available without checkpoint service access", async () => {
	const root = await mkdtemp(join(tmpdir(), "checkpoint-offline-fork-"));
	const source = join(root, "session.jsonl");
	const sourceBytes = Buffer.from(`${JSON.stringify({ type: "session", id: "offline-source", cwd: root })}\n`);
	await writeFile(source, sourceBytes);
	const previousFetch = globalThis.fetch;
	const previousLog = console.log;
	let output = "";
	globalThis.fetch = Object.assign(
		async () => {
			throw new Error("Offline fork attempted checkpoint service access");
		},
		{ preconnect: previousFetch.preconnect },
	);
	console.log = (...values: unknown[]) => {
		output = String(values[0]);
	};
	let directory: string | undefined;
	try {
		await runCheckpointCommand({ action: "fork", sessionFile: source });
		const fork = JSON.parse(output) as { sessionId: string; sourceSessionId: string; directory: string };
		directory = fork.directory;
		expect(fork.sourceSessionId).toBe("offline-source");
		expect(fork.sessionId).not.toBe("offline-source");
		expect(Buffer.from(await Bun.file(source).arrayBuffer())).toEqual(sourceBytes);
		const forkedHeader = JSON.parse(await Bun.file(join(directory, "sessions", "session.jsonl")).text());
		expect(forkedHeader.id).toBe(fork.sessionId);
		expect(forkedHeader.parentSessionId).toBe("offline-source");
	} finally {
		globalThis.fetch = previousFetch;
		console.log = previousLog;
		if (directory) await rm(directory, { recursive: true, force: true });
		await rm(root, { recursive: true, force: true });
	}
});
