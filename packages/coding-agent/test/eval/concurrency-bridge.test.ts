import { describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { runEvalConcurrency } from "@veyyon/coding-agent/eval/concurrency-bridge";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { makeToolSession } from "../helpers/tool-session";

/**
 * runEvalConcurrency resolves the worker-pool ceiling for an eval cell's
 * parallel()/pipeline() helpers from the live `agent.maxConcurrency` setting. The
 * contract mirrors the `task` tool: 0 means unbounded, and a negative value
 * collapses to 0 (unbounded) rather than throwing or spawning a bogus pool size. A
 * regression that let a negative or NaN through would either crash the pool
 * (Invalid array length) or silently cap fan-out at one. The values are stored in a
 * real settings store, which serves the declared default in place of a value that
 * is not a finite number.
 */

function session(raw: unknown): ToolSession {
	return makeToolSession({ settings: Settings.isolated({ "agent.maxConcurrency": raw }) });
}

const DECLARED_DEFAULT = Settings.isolated().get("agent.maxConcurrency");

describe("runEvalConcurrency", () => {
	it("passes through a positive integer ceiling", () => {
		expect(runEvalConcurrency(undefined, { session: session(8) })).toEqual({ limit: 8 });
	});

	it("keeps 0 (unbounded) as 0", () => {
		expect(runEvalConcurrency(undefined, { session: session(0) })).toEqual({ limit: 0 });
	});

	it("collapses a negative ceiling to 0 (unbounded)", () => {
		expect(runEvalConcurrency(undefined, { session: session(-5) })).toEqual({ limit: 0 });
	});

	it("truncates a fractional ceiling toward zero", () => {
		expect(runEvalConcurrency(undefined, { session: session(3.9) })).toEqual({ limit: 3 });
	});

	it("uses the declared default for a stored value that is not a finite number", () => {
		expect(DECLARED_DEFAULT).toBeGreaterThan(0);
		for (const raw of [Number.NaN, Number.POSITIVE_INFINITY, "5", null]) {
			expect(runEvalConcurrency(undefined, { session: session(raw) })).toEqual({ limit: DECLARED_DEFAULT });
		}
	});
});
