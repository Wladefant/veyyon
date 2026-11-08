import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { ReadTool } from "@veyyon/coding-agent/tools/fs/read";
import { SetCwdTool } from "@veyyon/coding-agent/tools/fs/set-cwd";
import { toolResultText } from "../helpers/tool-result-text";
import { makeToolSessionAt } from "../helpers/tool-session";

describe("read selectors after changing the session cwd", () => {
	it("reads requested lines through portable, Windows, and drive-case selectors", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "read-selector-set-cwd-"));
		const start = path.join(root, "start");
		const destination = path.join(root, "destination");
		await fs.mkdir(start);
		await fs.mkdir(destination);
		const file = path.join(destination, "rel", "file.ts");
		await fs.mkdir(path.dirname(file));
		await fs.writeFile(file, "line one\nline two\nline three\nline four\n", "utf8");
		try {
			const manager = SessionManager.inMemory(start);
			const session = makeToolSessionAt(start, {
				setCwd: (cwd, options) => manager.setCwd(cwd, options),
			});
			Object.defineProperty(session, "cwd", { get: () => manager.getCwd(), configurable: true });
			const setCwdPath = process.platform === "win32"
				? path.resolve(destination).replace(/^([A-Z]):/, (_, drive: string) => `${drive.toLowerCase()}:`).replaceAll("\\", "/")
				: destination;
			const moved = await new SetCwdTool(session).execute("set-cwd", { path: setCwdPath });
			expect(manager.getCwd()).toBe(path.resolve(destination));
			expect(toolResultText(moved)).toContain(path.resolve(destination));

			const reader = new ReadTool(session);
			const targets = [
				"rel/file.ts:2-3",
				`${file}:2-3`,
				...(process.platform === "win32"
					? [
							`${file.replaceAll("/", "\\")}:2-3`,
							`${file.replaceAll("\\", "/")}:2-3`,
							"rel\\file.ts:2-3",
							`${path.resolve(destination).replace(/^([A-Z]):/, (_, drive: string) => `${drive.toLowerCase()}:`).replaceAll("\\", "/")}/rel/file.ts:2-3`,
						]
					: []),
			];
			for (const target of targets) {
				const result = await reader.execute("read", { path: target });
				const text = toolResultText(result);
				expect(text).toContain("line two");
				expect(text).toContain("line three");
				expect(text).toContain("2:line two");
				expect(text).toContain("3:line three");
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
