import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { WriteTool } from "@veyyon/coding-agent/tools/fs/write";
import { removeWithRetries } from "@veyyon/utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";
import { makeToolSession } from "../helpers/tool-session";

/**
 * WriteTool concurrent overwrites of the same path leave one complete payload.
 */

describe("WriteTool concurrent same-path overwrites", () => {
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
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "w-atom-"));
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
			settings: Settings.isolated({
				"lsp.formatOnWrite": false,
				"lsp.diagnosticsOnWrite": false,
			}),
			enableLsp: false,
			getPlanModeState: () => ({ enabled: false }),
		});
	}

	it("ten concurrent overwrites leave one full payload of length 1000", async () => {
		const tool = new WriteTool(session());
		const file = path.join(tmpDir, "race.ts");
		const payloads = Array.from({ length: 10 }, (_, i) => `${String(i).repeat(1000)}\n`);
		await Promise.all(payloads.map((content, i) => tool.execute(`w${i}`, { path: file, content })));
		const out = await Bun.file(file).text();
		expect(payloads.includes(out)).toBe(true);
		expect(out.length).toBe(1001);
	}, 20_000);

	it.skipIf(process.platform !== "win32")(
		"overwriting an existing file preserves its protected Windows DACL",
		async () => {
			const target = "protected.txt";
			const file = path.join(tmpDir, target);
			const aclFile = path.join(tmpDir, "acl.txt");
			const icacls = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
			const runIcacls = (...args: string[]) => {
				const result = spawnSync(icacls, [target, ...args], {
					cwd: tmpDir,
					encoding: "utf8",
					timeout: 10_000,
					windowsHide: true,
				});
				if (result.error) throw result.error;
				if (result.status !== 0) {
					throw new Error(
						`icacls ${args[0]} failed (${result.status ?? result.signal}): ${result.stdout}${result.stderr}`,
					);
				}
			};
			const readDacl = async () => {
				runIcacls("/save", aclFile);
				return (await fs.readFile(aclFile, "utf16le")).split(/\r?\n/)[1]?.split("S:", 1)[0];
			};
			await fs.writeFile(file, "initial\n", "utf8");
			// Retain the AppContainer's access when converting inherited ACEs to explicit ones.
			runIcacls("/inheritance:d");
			const originalDacl = await readDacl();
			expect(originalDacl).toMatch(/^D:[A-Z]*P[A-Z]*\(/);

			const nextContent = "updated\n";
			await new WriteTool(session()).execute("w-win-acl", { path: file, content: nextContent });

			expect(await Bun.file(file).text()).toBe(nextContent);
			expect(await readDacl()).toBe(originalDacl);
		},
		35_000,
	);
});
