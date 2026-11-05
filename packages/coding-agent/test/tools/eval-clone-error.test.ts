import { afterAll, describe, expect, it } from "bun:test";
import { disposeAllVmContexts } from "@veyyon/coding-agent/eval/js/context-manager";
import { EvalTool } from "@veyyon/coding-agent/tools/shell/eval";
import { toolResultText } from "../helpers/tool-result-text";
import { makeToolSessionAt } from "../helpers/tool-session";

/**
 * Tool-call args cross the worker boundary by structured clone, and functions
 * are not cloneable. The clone failure must reject the awaiting cell — the
 * Worker `postMessage` contract — not shut down the subprocess kernel and
 * erase the eval session's accumulated state.
 */
describe("EvalTool non-serializable tool args", () => {
	afterAll(async () => {
		await disposeAllVmContexts();
	});

	it("fails the tool call inside the cell and keeps kernel state alive", async () => {
		const tool = new EvalTool(makeToolSessionAt(process.cwd()));

		const seed = await tool.execute("call-clone-seed", {
			language: "js",
			code: "globalThis.__cloneProbe = 41; console.log('seeded');",
		});
		expect(toolResultText(seed)).toContain("seeded");

		const bad = await tool.execute("call-clone-bad", {
			language: "js",
			code: [
				"try {",
				'\tawait __veyyon_call_tool__("read", { path: () => "x" });',
				'\tconsole.log("no-throw");',
				"} catch (error) {",
				'\tconsole.log("caught " + error.name);',
				"}",
			].join("\n"),
		});
		const badText = toolResultText(bad);
		expect(badText).toContain("caught DataCloneError");
		expect(badText).not.toContain("JS eval worker exited");

		const after = await tool.execute("call-clone-after", {
			language: "js",
			code: "console.log('probe=' + (globalThis.__cloneProbe + 1));",
		});
		expect(toolResultText(after)).toContain("probe=42");
	});
});
