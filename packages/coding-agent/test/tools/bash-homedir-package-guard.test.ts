import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import { BashTool } from "@veyyon/coding-agent/tools/shell/bash";
import { useIsolatedGlobalSettings } from "../helpers/isolated-global-settings";
import { makeToolSession } from "../helpers/tool-session";

// `executeBash` initializes the GLOBAL Settings singleton itself, so a session
// stub alone leaves it loading the developer's real ~/.veyyon agent.db.
useIsolatedGlobalSettings();

function bashSession(cwd: string) {
	return makeToolSession({
		cwd,
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getSessionId: () => "bash-homedir-guard",
		allocateOutputArtifact: async () => ({ id: "out-1", path: "/tmp/out-1.txt" }),
		settings: {
			get(key: string) {
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				return undefined;
			},
			getBashInterceptorRules() {
				return [];
			},
		},
		getClientBridge: () => undefined,
	});
}

describe("BashTool homedir package-manager guard (Refs #98)", () => {
	it("refuses package manager commands when explicit cwd is the home directory", async () => {
		const tool = new BashTool(bashSession(os.tmpdir()) as never);
		await expect(
			tool.execute("b1", { command: "npm install express", cwd: os.homedir(), timeout: 10 }),
		).rejects.toThrow(/package-manager command would run in the home directory/);
		await expect(tool.execute("b2", { command: "bun add lodash", cwd: os.homedir(), timeout: 10 })).rejects.toThrow(
			/package-manager command would run in the home directory/,
		);
		await expect(
			tool.execute("b3", { command: "npx create-react-app my-app", cwd: os.homedir(), timeout: 10 }),
		).rejects.toThrow(/package-manager command would run in the home directory/);
	});

	it("refuses package manager commands when session cwd defaults to home directory", async () => {
		const tool = new BashTool(bashSession(os.homedir()) as never);
		await expect(tool.execute("b4", { command: "pnpm add axios", timeout: 10 })).rejects.toThrow(
			/package-manager command would run in the home directory/,
		);
		await expect(tool.execute("b5", { command: "yarn install", timeout: 10 })).rejects.toThrow(
			/package-manager command would run in the home directory/,
		);
	});
});
