import { expect, test } from "bun:test";
import { CheckpointClient, type CheckpointFetch } from "../src/checkpoints/cloud-checkpoints";
import { SynchronizedSession } from "../src/checkpoints/synchronized-session";

const SECOND_RUNTIME_ID = "00000000-0000-4000-8000-000000000002";

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
			if (owner && owner !== body?.ownerNode) return Response.json({ error: "owned" }, { status: 409 });
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
		undefined,
		SECOND_RUNTIME_ID,
	);
	await first.admit();
	await expect(second.admit()).rejects.toThrow(/409/);
	await first.close();
	await second.close();
});

test("a transfer claim is single-use across runtimes sharing the destination device", async () => {
	const previousNode = process.env.VEYYON_CHECKPOINT_NODE;
	process.env.VEYYON_CHECKPOINT_NODE = "destination-device";
	let claimed = false;
	let owner = "destination-device";
	let epoch = 4;
	let pendingToken: string | undefined;
	const fake: CheckpointFetch = async (input, init) => {
		const action = new URL(String(input)).pathname.split("/").pop();
		const body = init?.body
			? (JSON.parse(String(init.body)) as {
					ownerNode: string;
					targetNode?: string;
					claimToken?: string;
					resumeToken?: string;
					transferId?: string;
					epoch?: number;
					leaseEpoch?: number;
				})
			: undefined;
		if (action === "claim") {
			if (
				claimed ||
				body?.targetNode !== "destination-device" ||
				body.transferId !== "transfer-1" ||
				body.claimToken !== "a-long-enough-claim-capability" ||
				body.epoch !== 4
			)
				return Response.json({ error: "claim spent" }, { status: 409 });
			claimed = true;
			owner = body.ownerNode;
			epoch++;
			pendingToken = "a-long-enough-resume-capability";
			return Response.json({
				ownerNode: owner,
				epoch,
				expiresAt: "2099-01-01T00:00:00Z",
				headSequence: 0,
				manifestHash: "",
				resumeToken: pendingToken,
			});
		}
		if (action === "finalize") {
			if (body?.ownerNode !== owner || body.leaseEpoch !== epoch || body.resumeToken !== pendingToken)
				return Response.json({ error: "stale finalize" }, { status: 409 });
			return Response.json({ ok: true });
		}
		if ((action === "renew" || action === "release") && owner !== body?.ownerNode)
			return Response.json({ error: "stale writer" }, { status: 409 });
		if (action === "release") epoch++;
		return Response.json({
			ownerNode: body?.ownerNode ?? owner,
			epoch,
			expiresAt: "2099-01-01T00:00:00Z",
			headSequence: 0,
			manifestHash: "",
		});
	};
	const marker = {
		version: 1 as const,
		sessionId: "transferred",
		targetNode: "destination-device",
		transferId: "transfer-1",
		transferEpoch: 4,
		claimToken: "a-long-enough-claim-capability",
		epoch: 4,
	};
	const persistOwnership = async () => {};
	try {
		const first = new SynchronizedSession(
			"transferred",
			new CheckpointClient({ baseUrl: "https://test", token: "test", key: new Uint8Array(32), fetch: fake }),
			marker,
			undefined,
			persistOwnership,
		);
		const second = new SynchronizedSession(
			"transferred",
			new CheckpointClient({ baseUrl: "https://test", token: "test", key: new Uint8Array(32), fetch: fake }),
			marker,
			SECOND_RUNTIME_ID,
			persistOwnership,
		);
		await first.admit();
		expect(first.ownerNode).not.toBe("destination-device");
		await expect(second.admit()).rejects.toThrow(/409/);
		await first.close();
		await second.close();
	} finally {
		if (previousNode === undefined) delete process.env.VEYYON_CHECKPOINT_NODE;
		else process.env.VEYYON_CHECKPOINT_NODE = previousNode;
	}
});
// WHY: prompt/tool admissions can overlap before the initial remote lease is granted.
// Without coalescing, the same process sends duplicate /lease (or one-time /claim)
// requests and can race the authority's ownership handshake.
test("concurrent admission shares one in-flight checkpoint lease acquisition", async () => {
	const entered = Promise.withResolvers<void>();
	const allowLease = Promise.withResolvers<void>();
	const actions: string[] = [];
	const lease = {
		ownerNode: "test-owner",
		epoch: 1,
		expiresAt: "2099-01-01T00:00:00Z",
		headSequence: 0,
		manifestHash: "",
	};
	const fake: CheckpointFetch = async input => {
		const action = new URL(String(input)).pathname.split("/").pop()!;
		actions.push(action);
		if (action === "lease") {
			entered.resolve();
			await allowLease.promise;
		}
		return Response.json(lease);
	};
	const session = new SynchronizedSession(
		"concurrent-admission",
		new CheckpointClient({ baseUrl: "https://test", token: "test", key: new Uint8Array(32), fetch: fake }),
	);
	const first = session.admit();
	const second = session.admit();
	await entered.promise;
	expect(actions).toEqual(["lease"]);
	allowLease.resolve();
	await Promise.all([first, second]);
	expect(actions).toEqual(["lease", "renew"]);
	await session.close();
	expect(actions).toEqual(["lease", "renew", "release"]);
});

// WHY: a shutdown while /lease is unresolved used to release nothing and return,
// then the late admission installed a timer and admitted work after close.
test("close during checkpoint lease acquisition releases the late grant and refuses admission", async () => {
	const entered = Promise.withResolvers<void>();
	const allowLease = Promise.withResolvers<void>();
	const actions: string[] = [];
	const lease = {
		ownerNode: "test-owner",
		epoch: 1,
		expiresAt: "2099-01-01T00:00:00Z",
		headSequence: 0,
		manifestHash: "",
	};
	const fake: CheckpointFetch = async input => {
		const action = new URL(String(input)).pathname.split("/").pop()!;
		actions.push(action);
		if (action === "lease") {
			entered.resolve();
			await allowLease.promise;
		}
		return Response.json(lease);
	};
	const session = new SynchronizedSession(
		"late-admission",
		new CheckpointClient({ baseUrl: "https://test", token: "test", key: new Uint8Array(32), fetch: fake }),
	);
	const admission = session.admit();
	await entered.promise;
	const closing = session.close();
	allowLease.resolve();
	await expect(admission).rejects.toThrow(/Synchronized ownership lost/);
	await closing;
	expect(actions).toEqual(["lease", "release"]);
	await expect(session.admit()).rejects.toThrow(/Synchronized ownership lost/);
	expect(actions).toEqual(["lease", "release"]);
});

// WHY: an expired authority grant is already a lost fence even if the remote
// renew endpoint might succeed later. An unadmitted prompt cannot reacquire.
test("an expired checkpoint lease permanently fences subsequent admissions", async () => {
	const actions: string[] = [];
	const fake: CheckpointFetch = async input => {
		const action = new URL(String(input)).pathname.split("/").pop()!;
		actions.push(action);
		return Response.json({
			ownerNode: "test-owner",
			epoch: 1,
			expiresAt: "2000-01-01T00:00:00Z",
			headSequence: 0,
			manifestHash: "",
		});
	};
	const session = new SynchronizedSession(
		"expired-admission",
		new CheckpointClient({ baseUrl: "https://test", token: "test", key: new Uint8Array(32), fetch: fake }),
	);
	await expect(session.admit()).rejects.toThrow(/Checkpoint lease lost/);
	await expect(session.admit()).rejects.toThrow(/Synchronized ownership lost/);
	expect(actions).toEqual(["lease"]);
	await session.close();
	expect(actions).toEqual(["lease", "release"]);
});

// WHY: a single-use transfer claim is also asynchronous. Closing while it is
// pending must not finalize a resume token or admit the transferred session.
test("close during transfer claim releases the late grant without persisting a resume marker", async () => {
	const previousNode = process.env.VEYYON_CHECKPOINT_NODE;
	process.env.VEYYON_CHECKPOINT_NODE = "destination-device";
	const entered = Promise.withResolvers<void>();
	const allowClaim = Promise.withResolvers<void>();
	const actions: string[] = [];
	let persisted = 0;
	const fake: CheckpointFetch = async input => {
		const action = new URL(String(input)).pathname.split("/").pop()!;
		actions.push(action);
		if (action === "claim") {
			entered.resolve();
			await allowClaim.promise;
		}
		return Response.json({
			ownerNode: "runtime-owner",
			epoch: 5,
			expiresAt: "2099-01-01T00:00:00Z",
			headSequence: 0,
			manifestHash: "",
			resumeToken: "a-long-enough-pending-resume-capability",
		});
	};
	const marker = {
		version: 1 as const,
		sessionId: "closing-transfer",
		targetNode: "destination-device",
		transferId: "transfer-closing",
		transferEpoch: 4,
		claimToken: "a-long-enough-claim-capability",
		epoch: 4,
	};
	try {
		const session = new SynchronizedSession(
			"closing-transfer",
			new CheckpointClient({ baseUrl: "https://test", token: "test", key: new Uint8Array(32), fetch: fake }),
			marker,
			undefined,
			async () => { persisted++; },
		);
		const admission = session.admit();
		await entered.promise;
		const closing = session.close();
		allowClaim.resolve();
		await expect(admission).rejects.toThrow(/Synchronized ownership lost/);
		await closing;
		expect(persisted).toBe(0);
		expect(actions).toEqual(["claim", "release"]);
	} finally {
		allowClaim.resolve();
		if (previousNode === undefined) delete process.env.VEYYON_CHECKPOINT_NODE;
		else process.env.VEYYON_CHECKPOINT_NODE = previousNode;
	}
});


// WHY: rejected ownership must not keep renewing. A successful lease renews,
// but an in-flight timer renewal must finish before close sends /release.
test("lost admission never renews and close drains the periodic renewal before release", async () => {
	const expiredActions: string[] = [];
	const expiredFetch: CheckpointFetch = async input => {
		const action = new URL(String(input)).pathname.split("/").pop()!;
		expiredActions.push(action);
		return Response.json({
			ownerNode: "expired-owner",
			epoch: 1,
			expiresAt: "2000-01-01T00:00:00Z",
			headSequence: 0,
			manifestHash: "",
		});
	};
	const expired = new SynchronizedSession(
		"expired-periodic",
		new CheckpointClient({ baseUrl: "https://test", token: "test", key: new Uint8Array(32), fetch: expiredFetch }),
		undefined,
		undefined,
		undefined,
		8,
	);
	await expect(expired.admit()).rejects.toThrow(/Checkpoint lease lost/);

	const started = Promise.withResolvers<void>();
	const finishPeriodic = Promise.withResolvers<void>();
	const controlActions: string[] = [];
	let renewals = 0;
	const validLease = {
		ownerNode: "valid-owner",
		epoch: 2,
		expiresAt: "2099-01-01T00:00:00Z",
		headSequence: 0,
		manifestHash: "",
	};
	const controlFetch: CheckpointFetch = async input => {
		const action = new URL(String(input)).pathname.split("/").pop()!;
		controlActions.push(action);
		if (action === "renew" && ++renewals === 2) {
			started.resolve();
			await finishPeriodic.promise;
		}
		return Response.json(validLease);
	};
	const live = new SynchronizedSession(
		"valid-periodic",
		new CheckpointClient({ baseUrl: "https://test", token: "test", key: new Uint8Array(32), fetch: controlFetch }),
		undefined,
		undefined,
		undefined,
		8,
	);
	let closing: Promise<void> | undefined;
	let deadline: ReturnType<typeof setTimeout> | undefined;
	try {
		await live.admit();
		deadline = setTimeout(() => started.reject(new Error("Periodic renewal never fired")), 3000);
		await started.promise;
		// The expired session had an earlier opportunity to schedule its tick.
		expect(expiredActions).toEqual(["lease"]);
		closing = live.close();
		await new Promise<void>(resolve => setTimeout(resolve, 25));
		expect(controlActions).not.toContain("release");
		finishPeriodic.resolve();
		await closing;
		expect(controlActions).toEqual(["lease", "renew", "renew", "release"]);
		expect(expiredActions).toEqual(["lease"]);
	} finally {
		clearTimeout(deadline);
		finishPeriodic.resolve();
		await (closing ?? live.close());
		await expired.close();
	}
});

// WHY: after successful transfer finalization, close retains the previously
// persisted resume capability and advances its epoch on authority release.
test("successful transfer retains its persisted resume capability on release", async () => {
	const previousNode = process.env.VEYYON_CHECKPOINT_NODE;
	process.env.VEYYON_CHECKPOINT_NODE = "destination-device";
	const actions: string[] = [];
	const persisted: Array<{ token: string; epoch: number }> = [];
	const token = "a-long-enough-resume-capability";
	const fake: CheckpointFetch = async input => {
		const action = new URL(String(input)).pathname.split("/").pop()!;
		actions.push(action);
		if (action === "finalize") return Response.json({ ok: true });
		return Response.json({
			ownerNode: "runtime-owner",
			epoch: action === "release" ? 6 : 5,
			expiresAt: "2099-01-01T00:00:00Z",
			headSequence: 0,
			manifestHash: "",
			...(action === "claim" ? { resumeToken: token } : {}),
		});
	};
	const claim = {
		version: 1 as const,
		sessionId: "successful-transfer",
		targetNode: "destination-device",
		transferId: "transfer-success",
		transferEpoch: 4,
		claimToken: "a-long-enough-claim-capability",
		epoch: 4,
	};
	const session = new SynchronizedSession(
		"successful-transfer",
		new CheckpointClient({ baseUrl: "https://test", token: "test", key: new Uint8Array(32), fetch: fake }),
		claim,
		undefined,
		async (resumeToken, epoch) => { persisted.push({ token: resumeToken, epoch }); },
	);
	try {
		await session.admit();
		await session.close();
		expect(persisted).toEqual([{ token, epoch: 5 }, { token, epoch: 6 }]);
		expect(actions).toEqual(["claim", "finalize", "renew", "release"]);
	} finally {
		if (previousNode === undefined) delete process.env.VEYYON_CHECKPOINT_NODE;
		else process.env.VEYYON_CHECKPOINT_NODE = previousNode;
	}
});
