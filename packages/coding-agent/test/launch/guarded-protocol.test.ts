/**
 * WHY THIS SUITE EXISTS.
 * -----------------------
 * Launch identity and generation guards prevent stale or mismatched operations from
 * accidentally affecting a newer daemon incarnation or an unrelated daemon that
 * replaced a terminated one under the same name (issue #1071).
 *
 * This suite tests the wire protocol codec for guarded operations:
 * 1. `encodeDaemonOperation` serializes guarded operations into `{ op: "guarded", operation: ... }`
 *    so legacy brokers reject unknown op instead of silently stripping the guard.
 * 2. `parseDaemonWireRequest` parses `{ op: "guarded", ... }` into ordinary operations carrying
 *    validated `expectedId` and `expectedGeneration`.
 * 3. Ordinary wire operations containing `expectedId` or `expectedGeneration` MUST be rejected
 *    rather than silently stripping the guard.
 * 4. Partial guard tuples (`expectedId` without `expectedGeneration`, or vice versa) MUST be
 *    rejected with "expectedId and expectedGeneration must be supplied together".
 * 5. Invalid guard values (empty string expectedId, zero/negative/non-integer generation) MUST be rejected.
 * 6. Guarded operations are restricted to `send`, `stop`, `wait`, and `restart`. Other operations
 *    (e.g., `start`, `logs`, `list`, `ping`, `describe`, `shutdown`) MUST reject guarded identity.
 * 7. Snapshot and completion record generation parsing: positive safe integer, optional for legacy.
 * 8. Legacy pre-fix wire request parser compatibility: proving that an unpatched parser
 *    rejects `{ op: "guarded", ... }` with "Unknown daemon operation: guarded".
 *
 * WHAT IT DOES NOT CATCH:
 * Real daemon process management and broker lifecycle concurrency (covered in
 * `guarded-control-never-follows-a-replacement.test.ts`).
 */

import { describe, expect, it } from "bun:test";
import {
	type DaemonOperation,
	encodeDaemonOperation,
	parseDaemonCompletionRecord,
	parseDaemonRpcResult,
	parseDaemonSnapshot,
	parseDaemonWireRequest,
} from "@veyyon/coding-agent/launch/protocol";
import {
	DAEMON_COMPLETIONS_SCHEMA_VERSION,
	parseDaemonCompletionsFile,
} from "@veyyon/coding-agent/launch/completions";
import { parseBaseDaemonWireRequest } from "../fixtures/launch-base-wire-parser";

const baseSnapshot = {
	name: "web",
	id: "abc-123",
	state: "running",
	createdAt: 1,
	startedAt: 2,
	restartCount: 0,
	outputBytes: 100,
	persist: true,
};

const baseCompletion = {
	name: "job",
	id: "uuid-1",
	terminatedBy: "process-exit",
	createdAt: 100,
	startedAt: 101,
	exitedAt: 200,
	restartCount: 0,
	outputBytes: 42,
	outputTail: "done",
};

describe("DaemonSnapshot and DaemonCompletionRecord generation field", () => {
	it("parses valid positive safe integer generation on snapshots", () => {
		const parsed = parseDaemonSnapshot({ ...baseSnapshot, generation: 1 });
		expect(parsed.generation).toBe(1);
		const parsedHigh = parseDaemonSnapshot({ ...baseSnapshot, generation: 42 });
		expect(parsedHigh.generation).toBe(42);
	});

	it("leaves generation undefined when missing (legacy snapshot compatibility)", () => {
		const parsed = parseDaemonSnapshot(baseSnapshot);
		expect(parsed.generation).toBeUndefined();
	});

	it("rejects non-positive, non-integer, or non-safe integer generation on snapshots", () => {
		expect(() => parseDaemonSnapshot({ ...baseSnapshot, generation: 0 })).toThrow(
			"daemon.generation must be a positive safe integer",
		);
		expect(() => parseDaemonSnapshot({ ...baseSnapshot, generation: -1 })).toThrow(
			"daemon.generation must be a positive safe integer",
		);
		expect(() => parseDaemonSnapshot({ ...baseSnapshot, generation: 1.5 })).toThrow(
			"daemon.generation must be a positive safe integer",
		);
		expect(() => parseDaemonSnapshot({ ...baseSnapshot, generation: Number.NaN })).toThrow(
			"daemon.generation must be a finite number",
		);
		expect(() => parseDaemonSnapshot({ ...baseSnapshot, generation: "1" })).toThrow(
			"daemon.generation must be a finite number",
		);
	});

	it("parses valid positive safe integer generation on completions", () => {
		const parsed = parseDaemonCompletionRecord({ ...baseCompletion, generation: 3 });
		expect(parsed.generation).toBe(3);
	});

	it("leaves generation undefined on completions when missing", () => {
		const parsed = parseDaemonCompletionRecord(baseCompletion);
		expect(parsed.generation).toBeUndefined();
	});

	it("rejects non-positive, non-integer generation on completions", () => {
		expect(() => parseDaemonCompletionRecord({ ...baseCompletion, generation: 0 })).toThrow(
			"completion.generation must be a positive safe integer",
		);
		expect(() => parseDaemonCompletionRecord({ ...baseCompletion, generation: -5 })).toThrow(
			"completion.generation must be a positive safe integer",
		);
	});
});

describe("encodeDaemonOperation", () => {
	it("leaves guardless operations untouched as ordinary wire operations", () => {
		const op: DaemonOperation = { op: "stop", name: "srv", timeoutMs: 5000 };
		expect(encodeDaemonOperation(op)).toBe(op);
		const listOp: DaemonOperation = { op: "list" };
		expect(encodeDaemonOperation(listOp)).toBe(listOp);
	});

	it("wraps guarded operations in { op: 'guarded', operation } envelope", () => {
		const op: DaemonOperation = {
			op: "stop",
			name: "srv",
			timeoutMs: 5000,
			expectedId: "id-1",
			expectedGeneration: 2,
		};
		const encoded = encodeDaemonOperation(op);
		expect(encoded).toEqual({
			op: "guarded",
			operation: op,
		});
	});

	it("supports guarded envelope on all 4 guarded operations: send, stop, wait, restart", () => {
		const ops: DaemonOperation[] = [
			{ op: "send", name: "srv", data: "hi", expectedId: "id-1", expectedGeneration: 1 },
			{ op: "stop", name: "srv", timeoutMs: 1000, expectedId: "id-1", expectedGeneration: 1 },
			{ op: "wait", name: "srv", for: "exit", timeoutMs: 1000, expectedId: "id-1", expectedGeneration: 1 },
			{ op: "restart", name: "srv", expectedId: "id-1", expectedGeneration: 1 },
		];
		for (const op of ops) {
			const encoded = encodeDaemonOperation(op);
			expect(encoded.op).toBe("guarded");
			expect((encoded as { op: "guarded"; operation: DaemonOperation }).operation).toEqual(op);
		}
	});

	it("rejects guarded identity on unsupported operations", () => {
		const unsupported: unknown[] = [
			{ op: "ping", expectedId: "id-1", expectedGeneration: 1 },
			{ op: "list", expectedId: "id-1", expectedGeneration: 1 },
			{
				op: "logs",
				name: "srv",
				lines: 10,
				head: false,
				follow: false,
				timeoutMs: 1000,
				expectedId: "id-1",
				expectedGeneration: 1,
			},
			{ op: "describe", name: "srv", expectedId: "id-1", expectedGeneration: 1 },
			{ op: "shutdown", expectedId: "id-1", expectedGeneration: 1 },
		];
		for (const bad of unsupported) {
			expect(() => encodeDaemonOperation(bad as DaemonOperation)).toThrow(/Guarded identity is not supported for/);
		}
	});

	it("rejects partial guard tuples", () => {
		expect(() =>
			encodeDaemonOperation({
				op: "stop",
				name: "srv",
				timeoutMs: 1000,
				expectedId: "id-1",
			} as unknown as DaemonOperation),
		).toThrow("expectedId and expectedGeneration must be supplied together");

		expect(() =>
			encodeDaemonOperation({
				op: "stop",
				name: "srv",
				timeoutMs: 1000,
				expectedGeneration: 1,
			} as unknown as DaemonOperation),
		).toThrow("expectedId and expectedGeneration must be supplied together");
	});

	it("rejects invalid expectedId and expectedGeneration values", () => {
		expect(() =>
			encodeDaemonOperation({
				op: "stop",
				name: "srv",
				timeoutMs: 1000,
				expectedId: "",
				expectedGeneration: 1,
			} as unknown as DaemonOperation),
		).toThrow("expectedId must be a non-empty string");

		expect(() =>
			encodeDaemonOperation({
				op: "stop",
				name: "srv",
				timeoutMs: 1000,
				expectedId: 123,
				expectedGeneration: 1,
			} as unknown as DaemonOperation),
		).toThrow("expectedId must be a non-empty string");

		expect(() =>
			encodeDaemonOperation({
				op: "stop",
				name: "srv",
				timeoutMs: 1000,
				expectedId: "id-1",
				expectedGeneration: 0,
			} as unknown as DaemonOperation),
		).toThrow("expectedGeneration must be a positive safe integer");

		expect(() =>
			encodeDaemonOperation({
				op: "stop",
				name: "srv",
				timeoutMs: 1000,
				expectedId: "id-1",
				expectedGeneration: -1,
			} as unknown as DaemonOperation),
		).toThrow("expectedGeneration must be a positive safe integer");

		expect(() =>
			encodeDaemonOperation({
				op: "stop",
				name: "srv",
				timeoutMs: 1000,
				expectedId: "id-1",
				expectedGeneration: 1.5,
			} as unknown as DaemonOperation),
		).toThrow("expectedGeneration must be a positive safe integer");
	});
});

describe("parseDaemonWireRequest guarded parsing", () => {
	it("parses an encoded guarded operation into DaemonOperation with expectedId and expectedGeneration", () => {
		const req = {
			id: "req-1",
			token: "tok",
			operation: {
				op: "guarded",
				operation: {
					op: "stop",
					name: "srv",
					timeoutMs: 5000,
					expectedId: "daemon-uuid",
					expectedGeneration: 4,
				},
			},
		};
		const parsed = parseDaemonWireRequest(req);
		expect(parsed.operation).toEqual({
			op: "stop",
			name: "srv",
			timeoutMs: 5000,
			expectedId: "daemon-uuid",
			expectedGeneration: 4,
		});
	});

	it("parses guarded send, wait, and restart operations", () => {
		const waitReq = {
			id: "req-2",
			token: "tok",
			operation: {
				op: "guarded",
				operation: {
					op: "wait",
					name: "srv",
					for: "exit",
					timeoutMs: 2000,
					expectedId: "id-w",
					expectedGeneration: 1,
				},
			},
		};
		expect(parseDaemonWireRequest(waitReq).operation).toEqual({
			op: "wait",
			name: "srv",
			for: "exit",
			pattern: undefined,
			timeoutMs: 2000,
			expectedId: "id-w",
			expectedGeneration: 1,
		});

		const sendReq = {
			id: "req-3",
			token: "tok",
			operation: {
				op: "guarded",
				operation: {
					op: "send",
					name: "srv",
					signal: "SIGTERM",
					expectedId: "id-s",
					expectedGeneration: 2,
				},
			},
		};
		expect(parseDaemonWireRequest(sendReq).operation).toEqual({
			op: "send",
			name: "srv",
			data: undefined,
			signal: "SIGTERM",
			expectedId: "id-s",
			expectedGeneration: 2,
		});

		const restartReq = {
			id: "req-4",
			token: "tok",
			operation: {
				op: "guarded",
				operation: {
					op: "restart",
					name: "srv",
					expectedId: "id-r",
					expectedGeneration: 3,
				},
			},
		};
		expect(parseDaemonWireRequest(restartReq).operation).toEqual({
			op: "restart",
			name: "srv",
			expectedId: "id-r",
			expectedGeneration: 3,
		});
	});

	it("rejects ordinary wire operations that contain guard fields without op: 'guarded'", () => {
		const unencodedGuarded = {
			id: "req-bad",
			token: "tok",
			operation: {
				op: "stop",
				name: "srv",
				timeoutMs: 5000,
				expectedId: "daemon-uuid",
				expectedGeneration: 4,
			},
		};
		expect(() => parseDaemonWireRequest(unencodedGuarded)).toThrow(
			"Guard fields are not allowed on ordinary wire operations",
		);
	});

	it("rejects guarded envelope wrapping unsupported operation", () => {
		const req = {
			id: "req-bad",
			token: "tok",
			operation: {
				op: "guarded",
				operation: {
					op: "list",
					expectedId: "id-1",
					expectedGeneration: 1,
				},
			},
		};
		expect(() => parseDaemonWireRequest(req)).toThrow("Guarded operation does not support list");
	});

	it("rejects guarded envelope with partial guard tuple", () => {
		const req = {
			id: "req-bad",
			token: "tok",
			operation: {
				op: "guarded",
				operation: {
					op: "stop",
					name: "srv",
					timeoutMs: 1000,
					expectedId: "id-1",
				},
			},
		};
		expect(() => parseDaemonWireRequest(req)).toThrow("expectedId and expectedGeneration must be supplied together");
	});
});

describe("legacy broker wire compatibility rejection", () => {
	it("proves that actual base wire parser fixture rejects an encoded guarded operation with unknown op", () => {
		const guardedOp: DaemonOperation = {
			op: "stop",
			name: "srv",
			timeoutMs: 1000,
			expectedId: "id-1",
			expectedGeneration: 2,
		};
		const encoded = encodeDaemonOperation(guardedOp);
		expect(encoded.op).toBe("guarded");

		const wireRequest = {
			id: "req-legacy",
			token: "tok-valid",
			operation: encoded,
		};

		expect(() => parseBaseDaemonWireRequest(wireRequest)).toThrow("Unknown daemon operation: guarded");
	});
});

describe("persisted completions schema stale-version behavior", () => {
	it("strictly enforces schema version 3 and rejects stale version 2 or missing version", () => {
		expect(DAEMON_COMPLETIONS_SCHEMA_VERSION).toBe(3);

		// Missing version
		expect(() => parseDaemonCompletionsFile({ records: [] })).toThrow(
			"Unsupported daemon completions schema version: missing (expected 3)",
		);

		// Stale legacy version 2
		expect(() => parseDaemonCompletionsFile({ version: 2, records: [] })).toThrow(
			"Unsupported daemon completions schema version: 2 (expected 3)",
		);

		// Future version 4
		expect(() => parseDaemonCompletionsFile({ version: 4, records: [] })).toThrow(
			"Unsupported daemon completions schema version: 4 (expected 3)",
		);
	});
});

describe("parseDaemonRpcResult with list capabilities", () => {
	it("parses optional capabilities.guardedIdentity from list response", () => {
		const result = parseDaemonRpcResult(
			{ op: "list" },
			{
				daemons: [{ ...baseSnapshot, generation: 1 }],
				completions: [],
				capabilities: { guardedIdentity: 1 },
			},
		);
		expect(result.op).toBe("list");
		if (result.op === "list") {
			expect(result.capabilities).toEqual({ guardedIdentity: 1 });
			expect(result.daemons[0]?.generation).toBe(1);
		}
	});

	it("parses list response without capabilities (legacy broker compatibility)", () => {
		const result = parseDaemonRpcResult(
			{ op: "list" },
			{
				daemons: [baseSnapshot],
				completions: [],
			},
		);
		expect(result.op).toBe("list");
		if (result.op === "list") {
			expect(result.capabilities).toBeUndefined();
			expect(result.daemons[0]?.generation).toBeUndefined();
		}
	});
});
