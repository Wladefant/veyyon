import { expect, it } from "bun:test";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { BashTool } from "@veyyon/coding-agent/tools/shell/bash";
import type { ClientBridge, ClientBridgeTerminalHandle } from "@veyyon/kernel/session/client-bridge";
import { useIsolatedGlobalSettings } from "./helpers/isolated-global-settings";
import { makeToolSession } from "./helpers/tool-session";

// A synthetic bridge only: no operator settings, secrets, editor or subprocess.
useIsolatedGlobalSettings();

const INVENTORY = ["ALPHA=fake-a", "BETA=fake-b", "GAMMA=fake-c", ""].join("\n");

function sessionFor(bridge: ClientBridge): ToolSession {
	return makeToolSession({
		cwd: "/tmp",
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		settings: {
			get(key: string) {
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				if (key === "bashInterceptor.enabled" || key === "astEdit.enabled") return false;
				return undefined;
			},
			getBashInterceptorRules() {
				return [];
			},
			getShellConfig() {
				return { shell: "/bin/bash", args: ["-l", "-c"], env: {}, prefix: undefined };
			},
		},
		getClientBridge: () => bridge,
	});
}

function bridge(handle: ClientBridgeTerminalHandle): ClientBridge {
	return { capabilities: { terminal: true }, createTerminal: async () => handle };
}

function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
	return result.content.filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
}

async function bounded<T>(promise: Promise<T>, phase: string): Promise<T> {
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(() => timeout.reject(new Error("Timed out awaiting " + phase)), 4_000);
	try {
		return await Promise.race([promise, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

it("refuses three fake environment assignments in ACP preview and completed BashTool output", async () => {
	const exit = Promise.withResolvers<{ exitCode: number; signal: null }>();
	const preview = Promise.withResolvers<void>();
	const updates: string[] = [];
	let releases = 0;
	const handle: ClientBridgeTerminalHandle = {
		terminalId: "synthetic-inventory",
		waitForExit: () => exit.promise,
		currentOutput: async () => ({ output: INVENTORY, truncated: false }),
		kill: async () => {},
		release: async () => {
			releases++;
		},
	};
	const tool = new BashTool(sessionFor(bridge(handle)));
	const running = tool.execute("synthetic-inventory", { command: "printf synthetic" }, undefined, update => {
		if (update.content.some(part => part.type === "text")) {
			updates.push(textOf(update));
			preview.resolve();
		}
	});
	try {
		await bounded(preview.promise, "first output poll");
	} finally {
		exit.resolve({ exitCode: 0, signal: null });
	}
	const completed = await bounded(running, "ACP terminal completion");
	const views = [...updates, textOf(completed)];
	for (const visible of views) {
		expect(visible).not.toContain("fake-a");
		expect(visible).not.toContain("fake-b");
		expect(visible).not.toContain("fake-c");
	}
	expect(views.join("\n")).toContain("[credential output withheld]");
	expect(releases).toBe(1);
}, 8_000);


it("holds partial inventories across cumulative ACP output snapshots until classification", async () => {
	const exit = Promise.withResolvers<{ exitCode: number; signal: null }>();
	const thirdPreview = Promise.withResolvers<void>();
	const snapshots = [
		"ALPHA=fake-a\\n",
		"ALPHA=fake-a\\nBETA=fake-b\\n",
		INVENTORY,
	];
	let outputReads = 0;
	const updates: string[] = [];
	const handle: ClientBridgeTerminalHandle = {
		terminalId: "synthetic-progressive-inventory",
		waitForExit: () => exit.promise,
		currentOutput: async () => ({
			output: snapshots[Math.min(outputReads++, snapshots.length - 1)]!,
			truncated: false,
		}),
		kill: async () => {},
		release: async () => {},
	};
	const running = new BashTool(sessionFor(bridge(handle))).execute(
		"synthetic-progressive-inventory",
		{ command: "printf synthetic" },
		undefined,
		update => {
			if (!update.content.some(part => part.type === "text")) return;
			updates.push(textOf(update));
			if (updates.length >= 3) thirdPreview.resolve();
		},
	);
	try {
		await bounded(thirdPreview.promise, "third inventory preview");
	} finally {
		exit.resolve({ exitCode: 0, signal: null });
	}
	const result = await bounded(running, "classified final result");
	expect(updates.slice(0, 2)).toEqual(["", ""]);
	for (const visible of [...updates, textOf(result)]) {
		expect(visible).not.toContain("fake-a");
		expect(visible).not.toContain("fake-b");
		expect(visible).not.toContain("fake-c");
	}
	expect(textOf(result)).toContain("[credential output withheld]");
}, 9_000);
it("preserves normal client terminal output and terminal identity", async () => {
	const handle: ClientBridgeTerminalHandle = {
		terminalId: "synthetic-ordinary",
		waitForExit: async () => ({ exitCode: 0, signal: null }),
		currentOutput: async () => ({ output: "ordinary hello\n", truncated: false }),
		kill: async () => {},
		release: async () => {},
	};
	const result = await bounded(
		new BashTool(sessionFor(bridge(handle))).execute("synthetic-ordinary", { command: "echo ordinary hello" }),
		"ACP normal completion",
	);
	expect(textOf(result)).toContain("ordinary hello");
	expect(textOf(result)).not.toContain("[credential output withheld]");
	expect(result.details?.terminalId).toBe("synthetic-ordinary");
}, 8_000);
