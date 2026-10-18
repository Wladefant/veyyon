import { expect, test } from "bun:test";
import { CheckpointClient, type CheckpointFetch } from "../src/session/cloud-checkpoints";
import { SynchronizedSession } from "../src/session/synchronized-session";

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
