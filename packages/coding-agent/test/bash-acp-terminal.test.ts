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

	// WHY: the ACP terminal/create RPC itself may never return. Aborting a
	// BashTool call must not wait for a handle before settling, and a handle
	// returned after abort must be killed/released without tool execution.
	async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
		const deadline = Promise.withResolvers<never>();
		const timer = setTimeout(() => deadline.reject(new Error("Timed out waiting for " + label)), 3_500);
		try {
			return await Promise.race([operation, deadline.promise]);
		} finally {
			clearTimeout(timer);
		}
	}

	it("refuses a pre-aborted ACP terminal request before sending terminal/create", async () => {
		let creates = 0;
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => {
				creates++;
				throw new Error("The client must not be contacted after abort");
			},
		};
		const controller = new AbortController();
		controller.abort();
		const tool = new BashTool(makeSession(bridge));
		await expect(bounded(tool.execute("pre-abort-terminal", { command: "echo never" }, controller.signal), "pre-aborted tool")).rejects.toThrow(
			"Command aborted",
		);
		expect(creates).toBe(0);
	}, 8_000);

	it("settles cancellation during a deferred ACP terminal/create and cleans a late returned handle", async () => {
		const creationEntered = Promise.withResolvers<void>();
		const provideHandle = Promise.withResolvers<ClientBridgeTerminalHandle>();
		const lateCleanupDone = Promise.withResolvers<void>();
		let killCalls = 0;
		let releaseCalls = 0;
		let waitCalls = 0;
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "deferred-ACP-terminal",
			waitForExit: async () => {
				waitCalls++;
				return { exitCode: 0 };
			},
			currentOutput: async () => ({ output: "must not be delivered", truncated: false }),
			kill: async () => {
				killCalls++;
			},
			release: async () => {
				releaseCalls++;
				lateCleanupDone.resolve();
			},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: () => {
				creationEntered.resolve();
				return provideHandle.promise;
			},
		};
		const controller = new AbortController();
		const tool = new BashTool(makeSession(bridge));
		const running = tool.execute("deferred-terminal", { command: "echo never" }, controller.signal);
		void running.catch(() => undefined);
		try {
			await bounded(creationEntered.promise, "deferred terminal/create entry");
			controller.abort();
			await expect(bounded(running, "cancelled BashTool result")).rejects.toThrow("Command aborted");
		} finally {
			controller.abort();
			provideHandle.resolve(handle);
		}
		await bounded(lateCleanupDone.promise, "late terminal cleanup");
		expect(killCalls).toBe(1);
		expect(releaseCalls).toBe(1);
		expect(waitCalls).toBe(0);
	}, 12_000);

	it("applies the command deadline to the ACP terminal/create phase and disposes a late handle", async () => {
		const creationEntered = Promise.withResolvers<void>();
		const provideHandle = Promise.withResolvers<ClientBridgeTerminalHandle>();
		const lateCleanupDone = Promise.withResolvers<void>();
		let killed = 0;
		let released = 0;
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "deadline-ACP-terminal",
			waitForExit: async () => ({ exitCode: 0 }),
			currentOutput: async () => ({ output: "", truncated: false }),
			kill: async () => { killed++; },
			release: async () => { released++; lateCleanupDone.resolve(); },
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: () => { creationEntered.resolve(); return provideHandle.promise; },
		};
		const tool = new BashTool(makeSession(bridge));
		const running = tool.execute("deadline-terminal", { command: "echo never", timeout: 1 });
		void running.catch(() => undefined);
		try {
			await bounded(creationEntered.promise, "deadline terminal/create entry");
			await expect(bounded(running, "terminal/create command deadline")).rejects.toThrow(
				"Command timed out after 1 seconds",
			);
		} finally {
			provideHandle.resolve(handle);
		}
		await bounded(lateCleanupDone.promise, "deadline terminal cleanup");
		expect(killed).toBe(1);
		expect(released).toBe(1);
	}, 12_000);

	// A successful terminal/create uses part of the SAME configured deadline.
	// Without subtracting its elapsed time, this fake-time test would finish
	// near 1600ms instead of the original 1000ms budget.
	it("shares one deadline between successful terminal creation and pending execution", async () => {
		const exit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>();
		let killed = 0;
		let released = 0;
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "combined-budget",
			waitForExit: async () => exit.promise,
			currentOutput: async () => ({ output: "", truncated: false }),
			kill: async () => { killed++; },
			release: async () => { released++; },
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => {
				const ready = Promise.withResolvers<ClientBridgeTerminalHandle>();
				setTimeout(() => ready.resolve(handle), 600);
				return ready.promise;
			},
		};
		installFakeTime();
		// Fake time advances setTimeout/Date. The production clock stays
		// monotonic; this narrowly makes it advance in lockstep for the test.
		vi.spyOn(performance, "now").mockImplementation(() => Date.now());
		const began = Date.now();
		const tool = new BashTool(makeSession(bridge));
		const failure = await driveFakeTime(
			tool.execute("combined-budget", { command: "echo never", timeout: 1 }),
		).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain("Command timed out after 1 seconds");
		expect(Date.now() - began).toBeGreaterThanOrEqual(1_000);
		expect(Date.now() - began).toBeLessThan(1_150);
		expect(killed).toBe(1);
		expect(released).toBe(1);
		exit.resolve({ exitCode: null, signal: "TERM" });
	}, 12_000);

	it("settles a cancelled tool even when terminal/create never resolves", async () => {
		const entered = Promise.withResolvers<void>();
		const unavailable = Promise.withResolvers<ClientBridgeTerminalHandle>();
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: () => { entered.resolve(); return unavailable.promise; },
		};
		const controller = new AbortController();
		const tool = new BashTool(makeSession(bridge));
		const running = tool.execute("no-create-response", { command: "echo never" }, controller.signal);
		void running.catch(() => undefined);
		try {
			await bounded(entered.promise, "unresponsive client terminal/create");
			controller.abort();
			await expect(bounded(running, "unresponsive client cancellation")).rejects.toThrow("Command aborted");
		} finally {
			controller.abort();
		}
	}, 8_000);

	it("cleans exactly one handle when abort races a successful terminal/create handoff", async () => {
		const controller = new AbortController();
		const released = Promise.withResolvers<void>();
		let kills = 0;
		let releases = 0;
		let waits = 0;
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "handoff-race",
			waitForExit: async () => { waits++; return { exitCode: 0 }; },
			currentOutput: async () => ({ output: "", truncated: false }),
			kill: async () => { kills++; },
			release: async () => { releases++; released.resolve(); },
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => {
				queueMicrotask(() => controller.abort());
				return handle;
			},
		};
		const tool = new BashTool(makeSession(bridge));
		await expect(
			bounded(tool.execute("handoff-race", { command: "echo never" }, controller.signal), "handoff abort"),
		).rejects.toThrow("Command aborted");
		await bounded(released.promise, "handoff abort terminal cleanup");
		expect(kills).toBe(1);
		expect(releases).toBe(1);
		expect(waits).toBe(0);
	}, 8_000);

	it("releases a terminal returned after abort even if its kill RPC refuses", async () => {
		const entered = Promise.withResolvers<void>();
		const provide = Promise.withResolvers<ClientBridgeTerminalHandle>();
		const released = Promise.withResolvers<void>();
		let releases = 0;
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "kill-error",
			waitForExit: async () => ({ exitCode: 0 }),
			currentOutput: async () => ({ output: "", truncated: false }),
			kill: async () => { throw new Error("synthetic editor kill refusal"); },
			release: async () => { releases++; released.resolve(); },
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: () => { entered.resolve(); return provide.promise; },
		};
		const controller = new AbortController();
		const tool = new BashTool(makeSession(bridge));
		const running = tool.execute("kill-error", { command: "echo never" }, controller.signal);
		void running.catch(() => undefined);
		try {
			await bounded(entered.promise, "kill-error terminal create");
			controller.abort();
			await expect(bounded(running, "kill-error cancellation")).rejects.toThrow("Command aborted");
		} finally {
			provide.resolve(handle);
		}
		await bounded(released.promise, "release despite rejected kill");
		expect(releases).toBe(1);
	}, 8_000);

	it("attempts terminal release after a bounded wait for a hung late kill", async () => {
		const entered = Promise.withResolvers<void>();
		const provide = Promise.withResolvers<ClientBridgeTerminalHandle>();
		const released = Promise.withResolvers<void>();
		const neverKilled = Promise.withResolvers<void>();
		let releases = 0;
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "kill-unresponsive",
			waitForExit: async () => ({ exitCode: 0 }),
			currentOutput: async () => ({ output: "", truncated: false }),
			kill: () => neverKilled.promise,
			release: async () => { releases++; released.resolve(); },
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: () => { entered.resolve(); return provide.promise; },
		};
		const controller = new AbortController();
		const tool = new BashTool(makeSession(bridge));
		const running = tool.execute("kill-unresponsive", { command: "echo never" }, controller.signal);
		void running.catch(() => undefined);
		try {
			await bounded(entered.promise, "unresponsive-kill terminal creation");
			controller.abort();
			await expect(bounded(running, "unresponsive-kill cancellation")).rejects.toThrow("Command aborted");
		} finally {
			provide.resolve(handle);
		}
		await bounded(released.promise, "bounded late kill then release");
		expect(releases).toBe(1);
	}, 8_000);
});
