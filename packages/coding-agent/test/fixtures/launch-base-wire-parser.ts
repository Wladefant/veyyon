/**
 * Pinned historical baseline of `parseDaemonWireRequest` prior to guarded identity (#1071).
 * Recorded from base commit `a769e30419` (`src/launch/protocol.ts`).
 *
 * This fixture is executed by compatibility suites to verify that an unpatched legacy wire parser
 * strictly rejects `{ op: 'guarded', operation: ... }` requests (failing closed with
 * `Unknown daemon operation: guarded`), proving that guarded identity control never executes
 * silently or unguarded on an older broker.
 */

interface LegacyDaemonWireRequest {
	id: string;
	token: string;
	operation: unknown;
}

function record(value: unknown, context: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${context} must be an object`);
	}
	return value as Record<string, unknown>;
}

function stringValue(value: unknown, context: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${context} must be a non-empty string`);
	}
	return value;
}

function parseBaseDaemonOperation(value: unknown): unknown {
	const source = record(value, "daemon operation");
	const op = stringValue(source.op, "operation.op");
	switch (op) {
		case "ping":
		case "start":
		case "list":
		case "logs":
		case "wait":
		case "send":
		case "stop":
		case "restart":
		case "describe":
		case "shutdown":
			return source;
		default:
			throw new Error(`Unknown daemon operation: ${op}`);
	}
}

/**
 * Historical wire request parser from commit a769e30419.
 */
export function parseBaseDaemonWireRequest(value: unknown): LegacyDaemonWireRequest {
	const source = record(value, "daemon request");
	return {
		id: stringValue(source.id, "request.id"),
		token: stringValue(source.token, "request.token"),
		operation: parseBaseDaemonOperation(source.operation),
	};
}
