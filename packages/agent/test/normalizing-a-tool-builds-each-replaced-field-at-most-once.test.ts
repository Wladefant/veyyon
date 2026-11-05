/**
 * WHY: normalizing a tool read its `description` twice: once while copying the tool's enumerable
 * properties and once to build the wire description. Several coding-agent tools render their
 * description from a prompt template on every read, and a wrapped tool exposes it through an
 * enumerable accessor, so every request rendered each of those templates twice.
 *
 * THE CLASS THIS CLOSES: a field the wire spec replaces (`parameters`, `wireParameters`,
 * `description`) being built while copying the rest of the tool. Each case wraps a tool in
 * enumerable accessors, the shape a wrapped tool has, and counts the reads of every replaced field
 * under each description mode.
 *
 * WHAT IT DOES NOT CATCH: a second read made by a caller of `normalizeTools`, such as a request
 * hook that reads the description again after normalization.
 */
import { describe, expect, it } from "bun:test";
import { normalizeTools } from "@veyyon/agent-core/tool-normalization";
import type { AgentTool } from "@veyyon/agent-core/types";
import { type } from "arktype";

const schema = type({ path: type("string").describe("file path") });

/** A tool whose every property is an enumerable accessor that counts its reads. */
function countingTool(name: string): { tool: AgentTool; reads: Map<string, number> } {
	const reads = new Map<string, number>();
	const fields: Record<string, () => unknown> = {
		name: () => name,
		label: () => name,
		description: () => `Reads ${name}.`,
		parameters: () => schema,
		examples: () => [{ call: { path: "a.ts" } }],
		execute: () => async () => ({ content: [], details: {} }),
	};
	const tool = {} as AgentTool;
	for (const [key, value] of Object.entries(fields)) {
		Object.defineProperty(tool, key, {
			enumerable: true,
			get() {
				reads.set(key, (reads.get(key) ?? 0) + 1);
				return value();
			},
		});
	}
	return { tool, reads };
}

describe("normalizing a tool builds each replaced field at most once", () => {
	it("renders the description once when descriptions ride the wire", () => {
		const { tool, reads } = countingTool("read");
		const [normalized] = normalizeTools([tool], true, "anthropic");

		expect(normalized?.description.startsWith("Reads read.")).toBe(true);
		expect(reads.get("description")).toBe(1);
	});

	it("never renders the description when descriptions are pruned", () => {
		const { tool, reads } = countingTool("read");
		const [normalized] = normalizeTools([tool], true, "anthropic", true);

		expect(normalized?.description).toBe("");
		expect(reads.get("description") ?? 0).toBe(0);
	});

	it("builds the parameters once to derive the wire schema, under both description modes", () => {
		for (const prune of [false, true]) {
			const { tool, reads } = countingTool("read");
			normalizeTools([tool], true, undefined, prune);

			expect(reads.get("parameters")).toBe(1);
		}
	});
});
