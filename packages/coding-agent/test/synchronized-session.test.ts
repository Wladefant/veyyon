import { expect, test } from "bun:test";
import { CheckpointClient, type CheckpointFetch } from "../src/checkpoints/cloud-checkpoints";
import { SynchronizedSession } from "../src/checkpoints/synchronized-session";

test("server epoch loss blocks admission and does not reacquire silently", async () => {
	let owns = true;
	let acquisitions = 0;
	const fake: CheckpointFetch = async input => {
		const path = new URL(String(input)).pathname;
		if (path.endsWith("/lease")) {
			acquisitions++;
			return Response.json({
				ownerNode: "node",
				epoch: 1,
				expiresAt: "2099-01-01T00:00:00Z",
				headSequence: 0,
				manifestHash: "",
			});
		}
		if (path.endsWith("/renew") && !owns) return Response.json({ error: "stale" }, { status: 409 });
		return Response.json({
			ownerNode: "node",
			epoch: 1,
			expiresAt: "2099-01-01T00:00:00Z",
			headSequence: 0,
			manifestHash: "",
		});
	};
	const client = new CheckpointClient({
		baseUrl: "https://test",
		token: "test",
		key: new Uint8Array(32),
		fetch: fake,
	});
	const session = new SynchronizedSession("s", client);
	await session.admit();
	owns = false;
	await expect(session.admit()).rejects.toThrow(/409/);
	await expect(session.admit()).rejects.toThrow(/fork/);
	expect(acquisitions).toBe(1);
	await session.close();
});

test("a second device cannot admit the same cloud session while its owner lease is live", async () => {
	let owner: string | undefined;
	let epoch = 0;
	const fake: CheckpointFetch = async (input, init) => {
		const action = new URL(String(input)).pathname.split("/").pop();
		const body = init?.body ? (JSON.parse(String(init.body)) as { ownerNode: string; epoch?: number }) : undefined;
		if (action === "lease") {
			if (owner && owner !== body?.ownerNode)
				return Response.json({ error: "owned" }, { status: 409 });
			owner = body?.ownerNode;
			return Response.json({
				ownerNode: owner,
				epoch: ++epoch,
				expiresAt: "2099-01-01T00:00:00Z",
				headSequence: 0,
				manifestHash: "",
			});
		}
		if (action === "renew" && owner !== body?.ownerNode)
			return Response.json({ error: "stale writer" }, { status: 409 });
		return Response.json({
			ownerNode: body?.ownerNode ?? owner,
			epoch,
			expiresAt: "2099-01-01T00:00:00Z",
			headSequence: 0,
			manifestHash: "",
		});
	};
	const first = new SynchronizedSession(
		"shared",
		new CheckpointClient({
			baseUrl: "https://test",
			token: "test",
			key: new Uint8Array(32),
			fetch: fake,
		}),
	);
	const second = new SynchronizedSession(
		"shared",
		new CheckpointClient({
			baseUrl: "https://test",
			token: "test",
			key: new Uint8Array(32),
			fetch: fake,
		}),
	);
	await first.admit();
	await expect(second.admit()).rejects.toThrow(/409/);
	await first.close();
	await second.close();
});
