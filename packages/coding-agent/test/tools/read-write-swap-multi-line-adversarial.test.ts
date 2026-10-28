import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { executeHashlineSingle } from "@veyyon/coding-agent/edit";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { ReadTool } from "@veyyon/coding-agent/tools/fs/read";
import { WriteTool } from "@veyyon/coding-agent/tools/fs/write";
import { removeWithRetries } from "@veyyon/utils";
import { hashlineExecOptions } from "../helpers/hashline-exec";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";
import { toolResultText } from "../helpers/tool-result-text";
import { makeToolSession } from "../helpers/tool-session";

/**
 * Multi-line SWAP: replace a 2-line range with 3 lines.
 */

describe("write→read→multi-line SWAP adversarial", () => {
	let settingsState: SettingsTestState | undefined;
	let tmpDir: string;

	beforeAll(async () => {
		settingsState = beginSettingsTest();
		await Settings.init({ inMemory: true });
	});

	afterAll(() => {
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ml-swap-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	function session(): ToolSession {
		return makeToolSession({
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => path.join(tmpDir, "s.jsonl"),
			getSessionSpawns: () => "*",
			getArtifactsDir: () => path.join(tmpDir, "artifacts"),
			allocateOutputArtifact: async () => ({ id: "a", path: path.join(tmpDir, "a.log") }),
			settings: Settings.isolated({
				"lsp.formatOnWrite": false,
				"lsp.diagnosticsOnWrite": false,
				"read.summarize.enabled": false,
			}),
			enableLsp: false,
			getPlanModeState: () => ({ enabled: false }),
		});
	}

	it("SWAP 2.=3 replaces two lines with three", async () => {
		const s = session();
		const file = path.join(tmpDir, "m.ts");
		await new WriteTool(s).execute("w", { path: file, content: "L1\nL2\nL3\nL4\n" });
		const header = toolResultText(await new ReadTool(s).execute("r", { path: file })).split("\n")[0]!;
		await executeHashlineSingle(hashlineExecOptions(`${header}\nSWAP 2.=3:\n+A\n+B\n+C\n`, s));
		expect(await Bun.file(file).text()).toBe("L1\nA\nB\nC\nL4\n");
	});
});
