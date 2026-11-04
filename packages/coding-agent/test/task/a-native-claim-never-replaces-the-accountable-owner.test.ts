/**
 * WHY: Native dispatch used the accountable owner as a disposable worker identity.
 * These scratch-ledger CLI tests cover every native lifecycle transition and reject
 * malformed, legacy-only, and stale identities. They do not prove live worker cancellation
 * or the installed Superboard ledger roundtrip.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { hermeticSpawnEnv, type HermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

type Request = Record<string, unknown>;
interface Ledger {
	version: number;
	requests: Record<string, Request>;
}
interface Fixture {
	root: HermeticSpawnEnv;
	ledgerPath: string;
	read(): Ledger;
	bytes(): string;
	call(command: string, ...args: string[]): Record<string, unknown>;
}

const bridge = path.resolve(import.meta.dirname, "../../src/task/native-ledger-bridge.py");
const python = process.platform === "win32" ? "python" : "python3";
const accountableOwner = "  person-1\tλ  ";
const roots: HermeticSpawnEnv[] = [];
const audit = [{ actor: "requester", reason: "Authorized scratch work", timestamp: "2026-01-01T00:00:00Z" }];
const retryable = { version: 1, state: "retryable", worker_id: null, run_id: null, task_handle: null };
const active = { version: 1, state: "active", worker_id: "worker-1", run_id: "run-1", task_handle: "agent://agent-1" };
const passingResult = JSON.stringify({
	stage: "build",
	verdict: "pass",
	checks: [{ purpose: "verification", exit_code: 0 }],
});

afterEach(() => {
	for (const root of roots.splice(0)) root.cleanup();
});

function fixture(overrides: Request = {}): Fixture {
	const root = hermeticSpawnEnv();
	roots.push(root);
	Object.assign(root.env, {
		VEYYON_WORKFLOWS_DIR: root.home,
		PYTHONPATH: root.home,
		PYTHONNOUSERSITE: "1",
	});
	const ledgerPath = path.join(root.home, "ledger.json");
	writeFileSync(
		ledgerPath,
		JSON.stringify({
			version: 2,
			requests: {
				request: {
					prompt: "Verify scratch behavior",
					state: "pending",
					stage: "review",
					owner: accountableOwner,
					authorization: {
						status: "authorized",
						timestamp: "2026-01-01T00:00:00Z",
						scope: "scratch",
						authorized_by: "person-1",
					},
					history: audit,
					...overrides,
				},
			},
		}),
	);
	return {
		root,
		ledgerPath,
		read: () => JSON.parse(readFileSync(ledgerPath, "utf8")) as Ledger,
		bytes: () => readFileSync(ledgerPath, "utf8"),
		call(command, ...args) {
			const result = spawnSync(python, [bridge, command, "--ledger", ledgerPath, ...args], {
				cwd: root.home,
				env: root.env,
				encoding: "utf8",
				timeout: 5_000,
				windowsHide: true,
			});
			expect(result.error, result.stderr).toBeUndefined();
			// Rejected dispatches use exit 1; other refusals are structured exit-0 responses.
			expect([0, 1], result.stderr).toContain(result.status);
			return JSON.parse(result.stdout) as Record<string, unknown>;
		},
	};
}

function assertAccountability(f: Fixture): Request {
	const ledger = f.read();
	expect(ledger.version).toBe(2);
	expect(ledger.requests.request.owner).toBe(accountableOwner);
	expect(ledger.requests.request.stage).toBe("review");
	expect((ledger.requests.request.history as unknown[]).slice(0, audit.length)).toEqual(audit);
	return ledger.requests.request;
}

function claim(f: Fixture): string {
	const result = f.call("claim", "--worker-id", "worker-1");
	expect(result.claimed).toBe(true);
	const ticket = result.ticket as Record<string, unknown>;
	expect(typeof ticket.runId).toBe("string");
	return ticket.runId as string;
}

function dispatch(f: Fixture, runId: string, handle = "agent://agent-1"): Record<string, unknown> {
	return f.call("record-dispatch", "--state-dir", f.root.home, "--ticket-id", "request", "--run-id", runId, "--task-handle", handle);
}

function complete(f: Fixture, runId: string, handle = "agent://agent-1", result = passingResult): Record<string, unknown> {
	return f.call("complete", "--ticket-id", "request", "--run-id", runId, "--task-handle", handle, "--result-json", result);
}

describe("accountable owner across native transitions", () => {
	test("first claim preserves the person and creates an undispatched v1 identity", () => {
		const f = fixture();
		const runId = claim(f);
		const request = assertAccountability(f);
		expect(request.native_claim).toEqual({ version: 1, state: "active", worker_id: "worker-1", run_id: runId, task_handle: null });
		expect(request.state).toBe("implementation");
		expect((request.history as unknown[]).length).toBe(audit.length + 1);
	});

	test("dispatch binds the handle without replacing the person and records its audit transition", () => {
		const f = fixture();
		const runId = claim(f);
		expect(dispatch(f, runId).recorded).toBe(true);
		const request = assertAccountability(f);
		expect(request.native_claim).toEqual({ version: 1, state: "active", worker_id: "worker-1", run_id: runId, task_handle: "agent://agent-1" });
		expect((request.history as unknown[]).length).toBe(audit.length + 2);
	});

	test("dispatch replay is idempotent and a different handle cannot take the run", () => {
		const f = fixture({ state: "implementation", native_claim: active });
		const before = f.bytes();
		expect(dispatch(f, "run-1").recorded).toBe(true);
		expect(f.bytes()).toBe(before);
		expect(dispatch(f, "run-1", "agent://other").recorded).toBe(false);
		expect(f.bytes()).toBe(before);
	});

	test("rollback fences the dispatched identity and preserves owner, stage, and audit", () => {
		const f = fixture();
		const runId = claim(f);
		expect(dispatch(f, runId).recorded).toBe(true);
		expect(f.call("rollback", "--ticket-id", "request", "--run-id", runId, "--previous-state", "qa").rolled_back).toBe(true);
		const request = assertAccountability(f);
		expect(request.state).toBe("qa");
		expect(request.native_claim).toEqual(retryable);
		const before = f.bytes();
		expect(complete(f, runId).completed).toBe(false);
		expect(f.bytes()).toBe(before);
	});

	test("orphan recovery uses native identity instead of the accountable person", () => {
		const f = fixture({ state: "qa", native_claim: active });
		expect(f.call("recover", "--running-worker-ids", accountableOwner).recovered).toEqual(["request"]);
		const request = assertAccountability(f);
		expect(request.state).toBe("qa");
		expect(request.native_claim).toEqual(retryable);
		expect((request.history as unknown[]).length).toBe(audit.length + 1);
	});

	for (const running of ["worker-1", "agent-1"]) {
		test(`recovery leaves the active claim intact when ${running} is running`, () => {
			const f = fixture({ state: "review", native_claim: active });
			const before = f.bytes();
			expect(f.call("recover", "--running-worker-ids", running).recovered).toEqual([]);
			expect(f.bytes()).toBe(before);
		});
	}

	for (const state of ["implementation", "qa", "review"]) {
		test(`never-native human-owned ${state} work cannot be claimed or recovered`, () => {
			const f = fixture({ state });
			const before = f.bytes();
			expect(f.call("claim", "--worker-id", "worker-1").claimed).toBe(false);
			expect(f.call("recover").recovered).toEqual([]);
			expect(f.bytes()).toBe(before);
		});
	}

	test("an explicit retryable native claim remains eligible despite its accountable owner", () => {
		const f = fixture({ state: "qa", native_claim: retryable });
		claim(f);
		assertAccountability(f);
		expect(f.read().requests.request.state).toBe("qa");
	});

	test("success advances only the request state and retires the live claim", () => {
		const f = fixture({ state: "implementation", native_claim: active });
		expect(complete(f, "run-1")).toMatchObject({ completed: true, ok: true, state: "QA" });
		const request = assertAccountability(f);
		expect(request.native_claim).toEqual(retryable);
		expect(request.evidence).toEqual([JSON.parse(passingResult)]);
		expect((request.history as unknown[]).length).toBe(audit.length + 1);
	});

	test("failure keeps the stage and accountable owner while retiring the live claim", () => {
		const f = fixture({ state: "qa", native_claim: active });
		expect(complete(f, "run-1", "agent://agent-1", JSON.stringify({ verdict: "fail", stage: "qa", checks: [] }))).toMatchObject({ completed: true, ok: false, state: "qa" });
		const request = assertAccountability(f);
		expect(request.native_claim).toEqual(retryable);
		expect(request.blocker).toBe("Worker returned verdict 'fail'");
		expect((request.history as unknown[]).length).toBe(audit.length + 1);
	});

	for (const [runId, handle] of [["old-run", "agent://agent-1"], ["run-1", "agent://old-agent"], ["run-1", ""]]) {
		test(`stale completion ${JSON.stringify([runId, handle])} leaves the entire ledger unchanged`, () => {
			const f = fixture({ state: "implementation", native_claim: active });
			const before = f.bytes();
			expect(complete(f, runId, handle).completed).toBe(false);
			expect(f.bytes()).toBe(before);
		});
	}

	test("an old completion cannot mutate a newer claim after rollback", () => {
		const f = fixture({ state: "implementation", native_claim: active });
		expect(f.call("rollback", "--ticket-id", "request", "--run-id", "run-1", "--previous-state", "implementation").rolled_back).toBe(true);
		const newRunId = claim(f);
		expect(newRunId).not.toBe("run-1");
		expect(dispatch(f, newRunId, "agent://new-agent").recorded).toBe(true);
		const before = f.bytes();
		expect(complete(f, "run-1").completed).toBe(false);
		expect(f.bytes()).toBe(before);
		assertAccountability(f);
	});
});

const invalidClaims: Array<[string, unknown]> = [
	["null", null],
	["array", []],
	["string", "active"],
	["unsupported version", { ...active, version: 2 }],
	["boolean version", { ...active, version: true }],
	["unsupported state", { ...active, state: "done" }],
	["retryable with live worker", { ...retryable, worker_id: "worker-1" }],
	["retryable with live run", { ...retryable, run_id: "run-1" }],
	["retryable with live handle", { ...retryable, task_handle: "agent://agent-1" }],
];
for (const key of Object.keys(active)) {
	const missing: Record<string, unknown> = { ...active };
	delete missing[key];
	invalidClaims.push([`missing ${key}`, missing]);
}
for (const key of ["worker_id", "run_id"]) {
	for (const value of [null, "", "  ", 1]) invalidClaims.push([`invalid ${key}: ${JSON.stringify(value)}`, { ...active, [key]: value }]);
}
for (const value of ["", "  ", 1]) invalidClaims.push([`invalid task_handle: ${JSON.stringify(value)}`, { ...active, task_handle: value }]);

describe("native identity fails closed", () => {
	for (const [name, nativeClaim] of invalidClaims) {
		test(name, () => {
			const f = fixture({ state: "implementation", native_claim: nativeClaim });
			assertRejectedWithoutMutation(f);
		});
	}
	for (const legacy of [
		{ native_run_id: "run-1" },
		{ native_task_handle: "agent://agent-1" },
		{ native_run_id: "run-1", native_task_handle: "agent://agent-1" },
		{ native_claim: active, native_run_id: "conflicting-run" },
		{ native_claim: active, native_task_handle: "agent://conflicting-agent" },
		{ native_claim: retryable, native_run_id: "run-1" },
	]) {
		test(`legacy-only or conflicting identity ${JSON.stringify(legacy)}`, () => {
			const f = fixture({ state: "implementation", ...legacy });
			assertRejectedWithoutMutation(f);
		});
	}

	test("an active claim cannot be reclaimed even when its request state is pending", () => {
		const f = fixture({ native_claim: active });
		const before = f.bytes();
		expect(f.call("claim", "--worker-id", "worker-2").claimed).toBe(false);
		expect(f.bytes()).toBe(before);
	});

	test("blank dispatch identity cannot bind an otherwise active run", () => {
		const f = fixture({ state: "implementation", native_claim: { ...active, task_handle: null } });
		const before = f.bytes();
		expect(dispatch(f, "run-1", " ").recorded).toBe(false);
		expect(f.bytes()).toBe(before);
	});

	test("rollback requires the exact current run", () => {
		const f = fixture({ state: "implementation", native_claim: active });
		const before = f.bytes();
		expect(f.call("rollback", "--ticket-id", "request", "--run-id", "old-run", "--previous-state", "pending").rolled_back).toBe(false);
		expect(f.bytes()).toBe(before);
	});
});

function assertRejectedWithoutMutation(f: Fixture): void {
	const before = f.bytes();
	expect(f.call("claim", "--worker-id", "worker-2").claimed).toBe(false);
	expect(f.bytes()).toBe(before);
	expect(dispatch(f, "run-1").recorded).toBe(false);
	expect(f.bytes()).toBe(before);
	expect(f.call("rollback", "--ticket-id", "request", "--run-id", "run-1", "--previous-state", "pending").rolled_back).toBe(false);
	expect(f.bytes()).toBe(before);
	expect(f.call("recover").recovered).toEqual([]);
	expect(f.bytes()).toBe(before);
	expect(complete(f, "run-1").completed).toBe(false);
	expect(f.bytes()).toBe(before);
}
