import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { WriteTool } from "@veyyon/coding-agent/tools/fs/write";
import { SearchTool } from "@veyyon/coding-agent/tools/search/search";
import { removeWithRetries } from "@veyyon/utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";
import { toolResultText } from "../helpers/tool-result-text";
import { makeToolSession } from "../helpers/tool-session";

describe("write→search(files) chain adversarial", () => {
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
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wg-chain-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	function session() {
		return makeToolSession({
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => path.join(tmpDir, "s.jsonl"),
			getSessionSpawns: () => "*",
			getArtifactsDir: () => path.join(tmpDir, "artifacts"),
			allocateOutputArtifact: async () => ({ id: "a", path: path.join(tmpDir, "a.log") }),
			settings: Settings.isolated({ "lsp.formatOnWrite": false, "lsp.diagnosticsOnWrite": false }),
			enableLsp: false,
			getPlanModeState: () => ({ enabled: false }),
		});
	}

	it("files written under src/ appear in **/*.ts search(files)", async () => {
		const s = session();
		const write = new WriteTool(s);
		await write.execute("w1", { path: path.join(tmpDir, "src", "a.ts"), content: "a\n" });
		await write.execute("w2", { path: path.join(tmpDir, "src", "b.ts"), content: "b\n" });
		const text = toolResultText(await new SearchTool(s).execute("g", { type: "files", input: "src/**/*.ts" }));
		expect(text).toContain("a.ts");
		expect(text).toContain("b.ts");
	});
});
