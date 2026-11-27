import { afterEach, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as utils from "@veyyon/utils";
import { serveTerminalControl, type TerminalOwner } from "../src/launch/terminal-control";
import { startTerminalControl } from "../src/launch/terminal-control-session";
import { AgentRegistry } from "../src/registry/agent-registry";
import type { AgentSession } from "../src/session/agent-session";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const close of cleanup.splice(0).reverse()) await close();
});

type Owner = TerminalOwner & { ownerGeneration?: string };

async function scratch() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "registry-ipc-"));
	cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
	return root;
}

async function ownerAt(root: string): Promise<Owner> {
	const directory = path.join(root, "run", "terminals");
	const filename = (await fs.readdir(directory)).find(name => name.endsWith(".json"))!;
	return JSON.parse(await fs.readFile(path.join(directory, filename), "utf8"));
}

async function request(owner: Owner, ...overrides: Record<string, unknown>[]) {
	const reply = Promise.withResolvers<{ ok: boolean; result?: Record<string, unknown>; error?: string }>();
	const socket = net.createConnection(owner.endpoint);
	socket.setEncoding("utf8");
	socket.on("error", reply.reject);
	socket.on("close", () => reply.reject(new Error("closed")));
	socket.on("connect", () => {
		socket.write(
			`${overrides
				.map(fields =>
					JSON.stringify({
						version: 1,
						id: "probe",
						op: "registrySnapshot",
						sessionId: owner.sessionId,
						ownerGeneration: owner.ownerGeneration,
						token: owner.token,
						...fields,
					}),
				)
				.join("\n")}\n`,
		);
	});
	let frame = "";
	socket.on("data", chunk => {
		frame += chunk;
		const end = frame.indexOf("\n");
		if (end >= 0) reply.resolve(JSON.parse(frame.slice(0, end)));
	});
	try {
		return await reply.promise;
	} finally {
		socket.destroy();
	}
}

function register(input: Parameters<AgentRegistry["register"]>[0]) {
	const registry = AgentRegistry.global();
	cleanup.push(() => {
		registry.unregister(input.id);
	});
	return registry.register(input);
}

async function interactive() {
	const root = await scratch();
	let conversation = "snapshot-session";
	const abortEntered = Promise.withResolvers<void>();
	const abortRelease = Promise.withResolvers<void>();
	cleanup.push(() => {
		abortRelease.resolve();
	});
	const manager = {
		getSessionId: () => conversation,
		getLeafId: () => "leaf",
		getCwd: () => root,
		getSessionFile: () => path.join(root, "session.jsonl"),
		getEntries: () => [],
	};
	const session = {
		registryAgentId: "snapshot-root",
		sessionManager: manager,
		isStreaming: false,
		async abort() {
			abortEntered.resolve();
			await abortRelease.promise;
		},
		model: { provider: "provider", id: "previous" },
		*liveAdvisorStates() {
			yield {
				name: "Review",
				slug: "review",
				model: { provider: "p", id: "review-model" },
				isStreaming: true,
				lastActivity: 43,
			};
		},
	};
	register({ id: "snapshot-root", kind: "main", displayName: "Main", session: session as unknown as AgentSession });
	spyOn(utils, "getConfigRootDir").mockReturnValue(root);
	const control = await startTerminalControl({ sessionManager: manager, session } as never);
	cleanup.push(control);
	return {
		root,
		control,
		owner: await ownerAt(root),
		session,
		abortEntered: abortEntered.promise,
		switchSession: () => {
			conversation = "after";
		},
	};
}

test("the terminal publishes only its own in-memory roster, including live advisors and current models", async () => {
	const { owner, session } = await interactive();
	const before = Date.now();
	session.model.id = "current";
	const worker = register({
		id: "snapshot-child",
		parentId: "snapshot-root",
		kind: "sub",
		displayName: "Worker",
		session: { model: { provider: "p", id: "current-child" }, *liveAdvisorStates() {} } as unknown as AgentSession,
		sessionFile: "/private/transcript",
		model: "stale-child",
		lastActivity: 42,
	});
	worker.pendingApproval = { toolName: "private-tool", reason: "private-reason", since: 42 };
	worker.waitingOnPeer = true;
	register({
		id: "snapshot-parked",
		parentId: worker.id,
		kind: "sub",
		displayName: "Parked",
		session: null,
		status: "parked",
		model: "stale-parked",
	});
	register({
		id: "snapshot-aborted",
		parentId: worker.id,
		kind: "sub",
		displayName: "Aborted",
		session: null,
		status: "aborted",
	});
	register({
		id: "snapshot-root/advisor:review",
		parentId: "snapshot-root",
		kind: "advisor",
		displayName: "Archived review",
		session: null,
		status: "parked",
	});
	register({ id: "foreign-snapshot-root", kind: "main", displayName: "Foreign", scope: "foreign", session: null });
	register({ id: "unattributed-snapshot", kind: "sub", displayName: "Unknown", session: null });

	expect(owner.capabilities).toContain("registry-snapshot-v1");
	expect(owner.ownerGeneration).toBeTruthy();
	const frame = await request(owner, {});
	expect(frame).toMatchObject({
		ok: true,
		result: {
			version: 1,
			sessionId: owner.sessionId,
			ownerGeneration: owner.ownerGeneration,
			coverage: "complete",
			truncated: false,
		},
	});
	const result = frame.result!;
	expect(result.observedAt).toBeWithin(before, Date.now() + 1);
	const rows = result.agents as Record<string, unknown>[];
	expect(rows.map(row => row.id).sort()).toEqual([
		"snapshot-aborted",
		"snapshot-child",
		"snapshot-parked",
		"snapshot-root",
		"snapshot-root/advisor:review",
	]);
	expect(rows.find(row => row.id === "snapshot-root")).toMatchObject({
		kind: "root",
		parentId: null,
		model: "provider/current",
		status: "idle",
		live: true,
	});
	expect(rows.find(row => row.id === worker.id)).toEqual({
		id: worker.id,
		rootId: "snapshot-root",
		parentId: "snapshot-root",
		kind: "subagent",
		displayName: "Worker",
		model: "p/current-child",
		status: "running",
		live: true,
		lastActivity: 42,
		waitingOnPeer: true,
		blockedOnApproval: true,
	});
	expect(rows.find(row => row.id === "snapshot-root/advisor:review")).toMatchObject({
		kind: "advisor",
		parentId: "snapshot-root",
		model: "p/review-model",
		live: true,
	});
	for (const id of ["snapshot-parked", "snapshot-aborted"])
		expect(rows.find(row => row.id === id)).toMatchObject({ live: false, model: null });
	expect(JSON.stringify(result)).not.toMatch(/private|stale|foreign|unattributed/);
});

test("the socket rejects an invalid token, session, generation and detached owner", async () => {
	const { root, control, owner, switchSession } = await interactive();
	await expect(request(owner, { token: "bad" })).rejects.toThrow();
	expect(await request(owner, { sessionId: "different" })).toMatchObject({ ok: false });
	expect(await request(owner, { ownerGeneration: "different" })).toMatchObject({ ok: false });
	expect(await request(owner, {})).toMatchObject({ ok: true });
	switchSession();
	expect(await request(owner, {})).toMatchObject({ ok: false });
	await control.refreshIdentity();
	const rebound = await ownerAt(root);
	expect(rebound.sessionId).toBe("after");
	expect(rebound.ownerGeneration).not.toBe(owner.ownerGeneration);
	expect(await request(rebound, { op: "ping" })).toMatchObject({
		ok: true,
		result: { sessionId: "after", ownerGeneration: rebound.ownerGeneration },
	});
});

test("snapshot replies do not wait for an in-flight mutation on the same socket", async () => {
	const { owner, session, abortEntered } = await interactive();
	session.isStreaming = true;
	const response = request(owner, { id: "abort", op: "abort" }, {});
	await abortEntered;
	expect(await response).toMatchObject({ ok: true, id: "probe" });
});

test("rotation publishes the new owner generation and token together", async () => {
	const { owner, root } = await interactive();
	expect(await request(owner, { op: "rotate" })).toMatchObject({ ok: true });
	const next = await ownerAt(root);
	expect(next.ownerGeneration).not.toBe(owner.ownerGeneration);
	expect(next.token !== owner.token).toBe(true);
	await expect(request(owner, {})).rejects.toThrow();
	expect(await request(next, { ownerGeneration: owner.ownerGeneration })).toMatchObject({ ok: false });
	expect(await request(next, {})).toMatchObject({ ok: true, result: { ownerGeneration: next.ownerGeneration } });
});

test("large rosters return a bounded, explicitly partial projection", async () => {
	const { owner } = await interactive();
	for (let i = 0; i < 500; ++i) {
		register({
			id: `snapshot-bulk-${i}`,
			parentId: "snapshot-root",
			kind: "sub",
			displayName: "Worker",
			session: null,
			status: "parked",
		});
	}
	const { result, ok } = await request(owner, {});
	expect(ok).toBe(true);
	expect(result).toMatchObject({ coverage: "partial", truncated: true });
	const rows = result!.agents as Record<string, unknown>[];
	expect(rows).toHaveLength(128);
	expect(rows[0]).toMatchObject({ id: "snapshot-root" });
});

test("an unsupported terminal does not advertise or return an empty snapshot", async () => {
	const root = await scratch();
	cleanup.push(
		await serveTerminalControl(
			{
				identity: () => ({ sessionId: "unsupported", cwd: root, sessionFile: "" }),
				deliver: async () => "started",
				abort: async () => false,
				history: () => [],
				subscribe: () => () => {},
			},
			root,
		),
	);
	const owner = await ownerAt(root);
	expect(owner.capabilities).not.toContain("registry-snapshot-v1");
	expect(await request(owner, {})).toMatchObject({ ok: false });
});
