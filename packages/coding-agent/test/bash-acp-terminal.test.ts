import { afterEach, describe, expect, it, mock, spyOn, vi } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BLOCKED_OUTPUT_RECORD } from "@veyyon/coding-agent/secrets/producer-output";
import { DEFAULT_MAX_BYTES } from "@veyyon/coding-agent/session/streaming-output";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { BashTool } from "@veyyon/coding-agent/tools/shell/bash";
import type { ClientBridge, ClientBridgeTerminalHandle } from "@veyyon/kernel/session/client-bridge";
import { driveFakeTime, installFakeTime } from "./helpers/fake-time";
import { useIsolatedGlobalSettings } from "./helpers/isolated-global-settings";
import { makeToolSession } from "./helpers/tool-session";

// stub alone leaves it loading the developer's real ~/.veyyon agent.db.
useIsolatedGlobalSettings();

// `executeBash` initializes the GLOBAL Settings singleton itself, so a session
function makeSession(
	bridge: ClientBridge,
	options: { artifactThreshold?: number; artifactDirectory?: string } = {},
): ToolSession {
	return makeToolSession({
		cwd: "/tmp",
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		settings: {
			get(key: string) {
				if (key === "tools.artifactSpillThreshold") return options.artifactThreshold;
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				if (key === "bashInterceptor.enabled") return false;

				if (key === "astEdit.enabled") return false;
				return undefined;
			},
			getBashInterceptorRules() {
				return [];
			},
			getShellConfig() {
				// Fixed bash shell keeps the wrap assertions cross-platform: the fix
				// must reuse the resolved shell (Git Bash on Windows, `$SHELL` on
				// POSIX) instead of collapsing to `cmd.exe` — that's the contract
				// this test defends.
				return { shell: "/bin/bash", args: ["-l", "-c"], env: {}, prefix: undefined };
			},
		},
		...(options.artifactDirectory
			? {
					allocateOutputArtifact: async (toolType: string) => ({
						id: `${toolType}-output`,
						path: join(options.artifactDirectory!, `${toolType}-output.txt`),
					}),
				}
			: {}),
		getClientBridge: () => bridge,
	});
}

afterEach(() => {
	mock.restore();
	vi.useRealTimers();
});

describe("BashTool ACP terminal routing", () => {
	it("routes through bridge, emits terminalId update, and releases the handle", async () => {
		const stubText = "hello from terminal\n";

		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-xyz",
			waitForExit: async () => ({ exitCode: 0, signal: null }),
			currentOutput: async () => ({ output: stubText, truncated: false }),
			kill: async () => {},
			release: async () => {},
		};

		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};

		const createSpy = spyOn(bridge, "createTerminal");
		const releaseSpy = spyOn(handle, "release");

		const updates: Array<{ details?: { terminalId?: string } }> = [];

		const tool = new BashTool(makeSession(bridge));
		const result = await tool.execute("call-1", { command: "echo hi" }, undefined, update => {
			updates.push(update as { details?: { terminalId?: string } });
		});

		// createTerminal must send the resolved bash shell + `-l -c <line>` so
		// spec-conformant ACP clients that spawn `command` directly (no implicit
		// shell) still get bash semantics — never `cmd.exe`, which would break
		// `$VAR`, `$(...)`, `source`, and POSIX quoting on Windows.
		expect(createSpy).toHaveBeenCalledTimes(1);
		const params = createSpy.mock.calls[0]![0];
		expect(params.command).toBe("/bin/bash");
		expect(params.args).toEqual(["-l", "-c", "{\necho hi\n} </dev/null"]);

		// The first onUpdate must carry the terminalId so the editor can embed it
		expect(updates.length).toBeGreaterThanOrEqual(1);
		expect(updates[0]!.details?.terminalId).toBe("term-xyz");

		// The final result text must contain the stub output
		const text = result.content.find(c => c.type === "text");
		expect(text?.text).toContain("hello from terminal");
		expect(text?.text).not.toContain("[credential output withheld]");

		// The result details must carry terminalId for the ACP event mapper
		expect(result.details?.terminalId).toBe("term-xyz");

		// The handle must always be released
		expect(releaseSpy).toHaveBeenCalledTimes(1);
	});

	it("wraps shell metacharacters into args instead of packing them into command", async () => {
		// Regression for #4333: a bash line with `&&`, pipes, or spaces must not
		// be sent as raw `command` (spec-conformant ACP clients spawn command+args
		// directly and would ENOENT the whole line as argv[0]).
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-shell-wrap",
			waitForExit: async () => ({ exitCode: 0, signal: null }),
			currentOutput: async () => ({ output: "", truncated: false }),
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};
		const createSpy = spyOn(bridge, "createTerminal");

		const line = "git status && echo x | head";
		const tool = new BashTool(makeSession(bridge));
		await tool.execute("call-shell-wrap", { command: line });

		expect(createSpy).toHaveBeenCalledTimes(1);
		const params = createSpy.mock.calls[0]![0];
		expect(params.command).toBe("/bin/bash");
		expect(params.args).toEqual(["-l", "-c", `{\n${line}\n} </dev/null`]);
		// `args` must actually be present — the bug was omitting it entirely.
		expect(params.args).toBeDefined();
		expect(params.args?.length).toBeGreaterThan(0);
	});

	it("releases the client terminal when final output retrieval fails", async () => {
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-output-failure",
			waitForExit: async () => ({ exitCode: 0, signal: null }),
			currentOutput: async () => {
				throw new Error("client output unavailable");
			},
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};
		const releaseSpy = spyOn(handle, "release");

		const tool = new BashTool(makeSession(bridge));

		await expect(tool.execute("call-output-failure", { command: "echo hi" })).rejects.toThrow(
			/client output unavailable/,
		);
		expect(releaseSpy).toHaveBeenCalledTimes(1);
	});

	it("releases the client terminal when waiting for exit fails", async () => {
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-exit-failure",
			waitForExit: async () => {
				throw new Error("client wait unavailable");
			},
			currentOutput: async () => ({ output: "", truncated: false }),
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};
		const releaseSpy = spyOn(handle, "release");

		const tool = new BashTool(makeSession(bridge));

		await expect(tool.execute("call-exit-failure", { command: "echo hi" })).rejects.toThrow(
			/client wait unavailable/,
		);
		expect(releaseSpy).toHaveBeenCalledTimes(1);
	});

	it("kills and releases the client terminal when the command times out", async () => {
		const pendingExit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>();
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-timeout",
			waitForExit: async () => pendingExit.promise,
			currentOutput: async () => ({ output: "", truncated: false }),
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};
		const killSpy = spyOn(handle, "kill");
		const releaseSpy = spyOn(handle, "release");

		installFakeTime();

		const tool = new BashTool(makeSession(bridge));

		const failure = await driveFakeTime(tool.execute("call-timeout", { command: "sleep 60", timeout: 1 })).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toMatch(/Command timed out after 1 seconds/);
		expect(killSpy).toHaveBeenCalledTimes(1);
		expect(releaseSpy).toHaveBeenCalledTimes(1);
		pendingExit.resolve({ exitCode: null, signal: "TERM" });
	});
	// ACP's cumulative snapshots can split an inventory assignment across previews.
	// This covers previews, final reads, and spill data; output absent from terminal snapshots remains untested.
	it("withholds inventory values from cumulative previews, final output, and spilled artifacts", async () => {
		const inventory = "ALPHA=classified-alpha\nBETA=classified-beta\nGAMMA=classified-gamma\n";
		const benignPrefix = "ordinary inventory row\n".repeat(4_000);
		const rows = benignPrefix + inventory.repeat(100);
		const snapshots = ["ALPHA=classified-", "ALPHA=classified-alpha\nBETA=classified-beta\n", rows];
		let finalRead = false;
		let snapshotIndex = 0;
		const pendingExit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>();
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-inventory",
			waitForExit: async () => pendingExit.promise,
			currentOutput: async () => ({
				output: finalRead ? rows : snapshots[Math.min(snapshotIndex++, snapshots.length - 1)]!,
				truncated: false,
			}),
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};
		const artifactDirectory = await mkdtemp(join(tmpdir(), "bash-acp-inventory-"));
		try {
			const tool = new BashTool(makeSession(bridge, { artifactThreshold: 1, artifactDirectory }));
			const updates: string[] = [];
			const running = tool.execute(
				"call-inventory",
				{ command: "printf '%s\\n' 'ALPHA=classified-alpha' 'BETA=classified-beta' 'GAMMA=classified-gamma'" },
				undefined,
				update => updates.push(update.content.map(item => (item.type === "text" ? item.text : "")).join("")),
			);
			installFakeTime();
			setTimeout(() => {
				finalRead = true;
				pendingExit.resolve({ exitCode: 0, signal: null });
			}, 600);
			const result = await driveFakeTime(running);
			expect(updates.length).toBeGreaterThan(0);
			expect(updates.slice(0, 2)).toEqual(["", ""]);
			const text = result.content.find(item => item.type === "text")?.text ?? "";
			expect(text).toContain("ordinary inventory row");
			expect(text).toContain("artifact://bash-original-output");
			const files = await readdir(artifactDirectory);
			expect(files.length).toBeGreaterThan(0);
			for (const file of files) {
				const artifact = await readFile(join(artifactDirectory, file), "utf8");
				expect(artifact).toContain("[credential output withheld]");
				expect(artifact).not.toContain("ALPHA=classified-alpha");
				expect(artifact).not.toContain("BETA=classified-beta");
				expect(artifact).not.toContain("GAMMA=classified-gamma");
			}
			expect(text).toContain("[credential output withheld]");
			for (const output of [...updates, text]) {
				expect(output).not.toContain("ALPHA=classified-alpha");
				expect(output).not.toContain("BETA=classified-beta");
				expect(output).not.toContain("GAMMA=classified-gamma");
			}
		} finally {
			await rm(artifactDirectory, { recursive: true, force: true });
		}
	});

	it("withholds inventory values from the timeout final-read branch", async () => {
		const inventory =
			"ordinary inventory row\nALPHA=classified-alpha\nBETA=classified-beta\nGAMMA=classified-gamma\n";
		const pendingExit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>();
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-timeout-inventory",
			waitForExit: () => pendingExit.promise,
			currentOutput: async () => ({ output: inventory, truncated: false }),
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};
		installFakeTime();
		const tool = new BashTool(makeSession(bridge));
		const failure = await driveFakeTime(
			tool.execute("call-timeout-inventory", {
				command: "printf '%s\\n' 'ALPHA=classified-alpha' 'BETA=classified-beta' 'GAMMA=classified-gamma'",
				timeout: 1,
			}),
		).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain("ordinary inventory row");
		expect((failure as Error).message).toContain("[credential output withheld]");
		expect((failure as Error).message).not.toContain("ALPHA=classified-alpha");
		expect((failure as Error).message).not.toContain("BETA=classified-beta");
		expect((failure as Error).message).not.toContain("GAMMA=classified-gamma");
	});

	// ACP truncates a terminal buffer from the beginning at any character boundary, so a
	// truncated snapshot can lose the assignment name, table header or earlier rows that make
	// what remains an inventory. Both cases below keep that classifying part in the lost prefix.
	// Gap: a client that reports `truncated: false` for a cut buffer is outside this contract.
	const inventoryValues = ["classified-alpha", "classified-beta", "classified-gamma", "classified-delta"];
	const rollingSnapshot = (stream: string) => ({
		output: stream.slice(-DEFAULT_MAX_BYTES),
		truncated: stream.length > DEFAULT_MAX_BYTES,
	});
	const fillTo = (text: string, length: number) => {
		const rows = "ordinary output row\n".repeat(Math.ceil(length / 20));
		return `${text}${rows.slice(0, length - text.length - 1)}\n`;
	};
	// Trigger A: the first snapshot starts inside ALPHA's value; `ALPHA=` was cut away.
	const midValueStream = `ALPHA=${fillTo(
		"classified-alpha\nBETA=classified-beta\nGAMMA=classified-gamma\nDELTA=classified-delta\n",
		DEFAULT_MAX_BYTES,
	)}`;
	// Trigger B: a preview already withheld the whole inventory; later output evicts ALPHA.
	const withheldInventory = "ALPHA=classified-alpha\nBETA=classified-beta\nGAMMA=classified-gamma\n";
	const evictedStream = `ALPHA=classified-alpha\n${fillTo("BETA=classified-beta\nGAMMA=classified-gamma\n", DEFAULT_MAX_BYTES)}`;
	const truncatedCases = [
		{ name: "first snapshot starts mid-value", previews: [midValueStream], final: midValueStream, exitCode: 0 },
		{
			name: "buffer evicts the first row of a withheld inventory",
			previews: [withheldInventory, evictedStream],
			final: evictedStream,
			exitCode: 1,
		},
	];

	it.each(truncatedCases)("withholds a truncated snapshot whose classifying prefix was cut: $name", async testCase => {
		expect(rollingSnapshot(testCase.final).truncated).toBe(true);
		let finalRead = false;
		let previewIndex = 0;
		const pendingExit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>();
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-truncated-inventory",
			waitForExit: async () => pendingExit.promise,
			// The command exits once every staged preview has been read, so each one is polled
			// regardless of how much fake time the setup before the poll loop consumed.
			currentOutput: async () => {
				if (finalRead) return rollingSnapshot(testCase.final);
				const preview = testCase.previews[previewIndex++]!;
				if (previewIndex === testCase.previews.length) {
					finalRead = true;
					pendingExit.resolve({ exitCode: testCase.exitCode, signal: null });
				}
				return rollingSnapshot(preview);
			},
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};
		const artifactDirectory = await mkdtemp(join(tmpdir(), "bash-acp-truncated-"));
		try {
			const tool = new BashTool(makeSession(bridge, { artifactThreshold: 1, artifactDirectory }));
			const updates: string[] = [];
			const running = tool.execute("call-truncated-inventory", { command: "env" }, undefined, update =>
				updates.push(update.content.map(item => (item.type === "text" ? item.text : "")).join("")),
			);
			installFakeTime();
			const outcome = await driveFakeTime(running).then(
				result => result.content.find(item => item.type === "text")?.text ?? "",
				(error: unknown) => (error as Error).message,
			);
			// The terminalId update plus one update per staged preview: the truncated one was published.
			expect(previewIndex).toBe(testCase.previews.length);
			expect(updates.length).toBeGreaterThanOrEqual(testCase.previews.length + 1);
			expect(outcome).toContain(BLOCKED_OUTPUT_RECORD);
			const artifacts = await Promise.all(
				(await readdir(artifactDirectory)).map(file => readFile(join(artifactDirectory, file), "utf8")),
			);
			for (const output of [...updates, outcome, ...artifacts]) {
				for (const value of inventoryValues) expect(output).not.toContain(value);
			}
		} finally {
			await rm(artifactDirectory, { recursive: true, force: true });
		}
	});

	it("withholds a truncated mid-value snapshot from the timeout error", async () => {
		const pendingExit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>();
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-truncated-timeout",
			waitForExit: () => pendingExit.promise,
			currentOutput: async () => rollingSnapshot(midValueStream),
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};
		installFakeTime();
		const tool = new BashTool(makeSession(bridge));
		const failure = await driveFakeTime(tool.execute("call-truncated-timeout", { command: "env", timeout: 1 })).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain(BLOCKED_OUTPUT_RECORD);
		for (const value of inventoryValues) expect((failure as Error).message).not.toContain(value);
	});

	// The command deadline and the poll tick used to be `Bun.sleep` promises raced against the exit:
	// a command that finished first left both armed, the deadline for the rest of its timeout, holding
	// the event loop open long after the result was returned.
	it("leaves no timer armed once the client terminal reports the exit", async () => {
		const exit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>();
		let kills = 0;
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-fast-exit",
			waitForExit: async () => exit.promise,
			currentOutput: async () => ({ output: "done\n", truncated: false }),
			kill: async () => {
				kills++;
			},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};
		installFakeTime();

		const tool = new BashTool(makeSession(bridge));
		const running = tool.execute("call-fast-exit", { command: "echo done", timeout: 60 });
		// Two poll ticks pass before the exit lands, so the poll timer has been re-armed in between.
		setTimeout(() => exit.resolve({ exitCode: 0, signal: null }), 600);
		const result = await driveFakeTime(running);

		expect(result.content.find(c => c.type === "text")?.text).toContain("done");
		expect(kills).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});
});
