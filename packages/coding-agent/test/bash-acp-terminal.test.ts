import { afterEach, describe, expect, it, mock, spyOn, vi } from "bun:test";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { BashTool } from "@veyyon/coding-agent/tools/shell/bash";
import type { ClientBridge, ClientBridgeTerminalHandle } from "@veyyon/kernel/session/client-bridge";
import { driveFakeTime, installFakeTime } from "./helpers/fake-time";
import { useIsolatedGlobalSettings } from "./helpers/isolated-global-settings";
import { makeToolSession } from "./helpers/tool-session";

// `executeBash` initializes the GLOBAL Settings singleton itself, so a session
// stub alone leaves it loading the developer's real ~/.veyyon agent.db.
useIsolatedGlobalSettings();

function makeSession(bridge: ClientBridge): ToolSession {
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

	// WHY: the original poll race included the deadline only outside the
	// terminal/output await, so a permanently pending client output RPC could
	// hide the expiry. The early observer prevents an old source test hang.
	it("enforces a command timeout while an ACP terminal/output poll is pending", async () => {
		const exit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>();
		const outputStarted = Promise.withResolvers<void>();
		const outputStuck = Promise.withResolvers<{ output: string; truncated: boolean }>();
		let kills = 0;
		let releases = 0;
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "output-poll-stalled",
			waitForExit: () => exit.promise,
			currentOutput: () => { outputStarted.resolve(); return outputStuck.promise; },
			kill: async () => { kills++; },
			release: async () => { releases++; },
		};
		const bridge: ClientBridge = { capabilities: { terminal: true }, createTerminal: async () => handle };
		installFakeTime();
		const tool = new BashTool(makeSession(bridge));
		const running = tool.execute("poll-stalled", { command: "echo never", timeout: 1 });
		const outcome = running.then(
			() => ({ kind: "success" as const }),
			(error: unknown) => ({ kind: "failure" as const, error }),
		);
		const observer = Promise.withResolvers<{ kind: "no-settlement" }>();
		// Allow the bounded 250ms post-kill output grace after the 1000ms
		// command deadline, but never let a stuck poll wait indefinitely.
		const observerTimer = setTimeout(() => observer.resolve({ kind: "no-settlement" }), 1_600);
		try {
			const observed = await driveFakeTime(Promise.race([outcome, observer.promise]));
			expect(observed.kind).toBe("failure");
			if (observed.kind !== "failure") throw new Error("The polling output call ignored its command deadline");
			expect(observed.error).toBeInstanceOf(Error);
			expect((observed.error as Error).message).toContain("Command timed out after 1 seconds");
			expect(kills).toBe(1);
			expect(releases).toBe(1);
		} finally {
			clearTimeout(observerTimer);
			exit.resolve({ exitCode: null, signal: "TERM" });
			outputStuck.resolve({ output: "", truncated: false });
		}
	}, 12_000);

	it("cancels a BashTool call whose final ACP terminal output never resolves", async () => {
		const entered = Promise.withResolvers<void>();
		const pendingOutput = Promise.withResolvers<{ output: string; truncated: boolean }>();
		let releases = 0;
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "final-read-stalled",
			waitForExit: async () => ({ exitCode: 0 }),
			currentOutput: () => { entered.resolve(); return pendingOutput.promise; },
			kill: async () => {},
			release: async () => { releases++; },
		};
		const bridge: ClientBridge = { capabilities: { terminal: true }, createTerminal: async () => handle };
		const controller = new AbortController();
		const tool = new BashTool(makeSession(bridge));
		const running = tool.execute("final-read-stalled", { command: "echo done" }, controller.signal);
		void running.catch(() => undefined);
		const timeout = Promise.withResolvers<never>();
		const timer = setTimeout(() => timeout.reject(new Error("Final output read did not start")), 3_000);
		try {
			await Promise.race([entered.promise, timeout.promise]);
			controller.abort();
			const finished = Promise.withResolvers<never>();
			const waiter = setTimeout(() => finished.reject(new Error("Cancelled final output read did not settle")), 3_000);
			try {
				await expect(Promise.race([running, finished.promise])).rejects.toThrow("Command aborted");
			} finally {
				clearTimeout(waiter);
			}
			expect(releases).toBe(1);
		} finally {
			clearTimeout(timer);
			controller.abort();
			pendingOutput.resolve({ output: "late output must not become success", truncated: false });
		}
	}, 9_000);

	it("keeps the finite command deadline while reading final ACP terminal output", async () => {
		const pendingOutput = Promise.withResolvers<{ output: string; truncated: boolean }>();
		let releases = 0;
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "final-read-deadline",
			waitForExit: async () => ({ exitCode: 0 }),
			currentOutput: () => pendingOutput.promise,
			kill: async () => {},
			release: async () => { releases++; },
		};
		const bridge: ClientBridge = { capabilities: { terminal: true }, createTerminal: async () => handle };
		installFakeTime();
		vi.spyOn(performance, "now").mockImplementation(() => Date.now());
		const tool = new BashTool(makeSession(bridge));
		const running = tool.execute("final-read-deadline", { command: "echo done", timeout: 1 });
		const outcome = running.then(
			() => ({ kind: "success" as const }),
			(error: unknown) => ({ kind: "failure" as const, error }),
		);
		const observer = Promise.withResolvers<{ kind: "no-settlement" }>();
		const timer = setTimeout(() => observer.resolve({ kind: "no-settlement" }), 1_200);
		try {
			const observed = await driveFakeTime(Promise.race([outcome, observer.promise]));
			expect(observed.kind).toBe("failure");
			if (observed.kind !== "failure") throw new Error("Final output ignored its command deadline");
			expect(observed.error).toBeInstanceOf(Error);
			expect((observed.error as Error).message).toContain("Command timed out after 1 seconds");
			expect(releases).toBe(1);
		} finally {
			clearTimeout(timer);
			pendingOutput.resolve({ output: "", truncated: false });
		}
	}, 12_000);

	it("does not hang a completed command on an unresponsive ACP terminal release RPC", async () => {
		const pendingRelease = Promise.withResolvers<void>();
		let releaseCalls = 0;
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "release-stalled",
			waitForExit: async () => ({ exitCode: 0 }),
			currentOutput: async () => ({ output: "completed\n", truncated: false }),
			kill: async () => {},
			release: () => { releaseCalls++; return pendingRelease.promise; },
		};
		const bridge: ClientBridge = { capabilities: { terminal: true }, createTerminal: async () => handle };
		const tool = new BashTool(makeSession(bridge));
		const finished = Promise.withResolvers<never>();
		const timer = setTimeout(() => finished.reject(new Error("Completed command stalled in terminal release")), 3_000);
		try {
			const result = await Promise.race([
				tool.execute("release-stalled", { command: "echo completed", timeout: 0 }),
				finished.promise,
			]);
			expect(result.content.find(item => item.type === "text")?.text).toContain("completed");
			expect(releaseCalls).toBe(1);
		} finally {
			clearTimeout(timer);
			pendingRelease.resolve();
		}
	}, 9_000);
});
