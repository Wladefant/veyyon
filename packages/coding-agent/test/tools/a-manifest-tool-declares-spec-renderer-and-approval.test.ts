import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import { BUILTIN_TOOLS, HIDDEN_TOOLS, type ToolSession } from "../../src/tools";
import { toolRenderers } from "../../src/tools/renderers";

const VALID_APPROVAL_TIERS: Record<string, true> = {
	read: true,
	write: true,
	exec: true,
	execute: true,
	danger: true,
	network: true,
	prompt: true,
	deny: true,
};

const NON_RENDERING_TOOLS: Record<string, true> = {
	checkpoint: true,
	rewind: true,
	memory_edit: true,
	yield: true,
	report_tool_issue: true,
};
function createTestSession(): ToolSession {
	const settings = Settings.isolated();
	settings.set("argot.enabled", true);
	settings.set("memory.backend", "mnemopi");
	settings.set("fetch.enabled", true);

	return {
		cwd: "/workspace",
		hasUI: true,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => "main",
		getArgotSession: () => undefined,
		getMnemopiSessionState: () => undefined,
		getHindsightSessionState: () => undefined,
		getCheckpointState: () => undefined,
		getLastCompletedRewind: () => undefined,
	};
}

describe("Manifest tool contracts", () => {
	const session = createTestSession();
	const allManifestTools = { ...BUILTIN_TOOLS, ...HIDDEN_TOOLS };

	it("declares non-empty tool registry", () => {
		expect(Object.keys(allManifestTools).length).toBeGreaterThan(20);
	});

	for (const [manifestKey, factory] of Object.entries(allManifestTools)) {
		it(`tool \`${manifestKey}\` matches name, description, schema, approval, and renderer`, async () => {
			const tool = await factory(session);
			if (!tool) {
				// Tool conditionally skipped (e.g. absent backend)
				return;
			}

			expect(tool.name).toBe(manifestKey);
			expect(typeof tool.description).toBe("string");
			expect(tool.description.trim().length).toBeGreaterThan(0);
			expect(tool.parameters).toBeDefined();

			if (tool.approval !== undefined) {
				const approvalVal = typeof tool.approval === "function" ? tool.approval({}) : tool.approval;
				expect(typeof approvalVal === "string" && VALID_APPROVAL_TIERS[approvalVal] === true).toBe(true);
			}

			if (!NON_RENDERING_TOOLS[manifestKey]) {
				const hasRenderer = Boolean(tool.view) || Boolean(toolRenderers[manifestKey]);
				expect(hasRenderer).toBe(true);
			}
		});
	}
});
