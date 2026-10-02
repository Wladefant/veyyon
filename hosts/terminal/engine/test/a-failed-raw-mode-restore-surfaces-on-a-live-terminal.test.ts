import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ProcessTerminal } from "@veyyon/tui/terminal";
import { setTerminalHeadless } from "@veyyon/utils";
import * as postmortem from "@veyyon/utils/postmortem";

/**
 * WHY: `stop()` restores stdin's raw mode inside a catch so a revoked pty (pane
 * recycled, ssh dropped), where Bun's node:tty shim throws, cannot abort the
 * teardown. The catch swallowed every failure, so a restore that failed on a live
 * terminal left stdin in raw mode with nothing reported.
 *
 * The contract: the failure is suppressed only once the terminal is known to be
 * disconnected; on a live terminal `stop()` throws it, after finishing the rest of
 * its teardown.
 *
 * What it does NOT catch: a restore that silently does nothing without throwing.
 */

const RESTORE_FAILURE = "setRawMode failed: ENOENT";

const stdinIsTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stdinSetRawMode = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) Object.defineProperty(target, key, descriptor);
	else delete (target as Record<string, unknown>)[key];
}

/** setRawMode that succeeds on start() and throws on every later call. */
function failRestoreAfterStart(): void {
	let started = false;
	Object.defineProperty(process.stdin, "setRawMode", {
		value: () => {
			if (started) throw new Error(RESTORE_FAILURE);
			started = true;
			return process.stdin;
		},
		configurable: true,
	});
}

function startTerminal(onDisconnect: () => void = () => {}): ProcessTerminal {
	const terminal = new ProcessTerminal();
	terminal.start(
		() => {},
		() => {},
		onDisconnect,
	);
	return terminal;
}

describe("ProcessTerminal raw-mode restore on stop()", () => {
	let previousHeadless: boolean;

	beforeEach(() => {
		previousHeadless = setTerminalHeadless(false);
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		vi.spyOn(process, "kill").mockReturnValue(true);
		vi.spyOn(postmortem, "quit").mockResolvedValue(undefined as never);
		vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		setTerminalHeadless(previousHeadless);
		vi.restoreAllMocks();
		restoreProperty(process.stdin, "isTTY", stdinIsTty);
		restoreProperty(process.stdout, "isTTY", stdoutIsTty);
		restoreProperty(process.stdin, "setRawMode", stdinSetRawMode);
	});

	it("throws a restore failure while the terminal is still live, after removing its stdin reader", () => {
		failRestoreAfterStart();
		const dataListeners = process.stdin.listenerCount("data");
		const terminal = startTerminal();

		expect(() => terminal.stop()).toThrow(RESTORE_FAILURE);
		expect(process.stdin.listenerCount("data")).toBe(dataListeners);
	});

	it("swallows a restore failure once the terminal has disconnected", () => {
		failRestoreAfterStart();
		let teardown: { error: unknown } | undefined;
		const terminal = startTerminal(() => {
			try {
				terminal.stop();
				teardown = { error: undefined };
			} catch (error) {
				teardown = { error };
			}
		});

		// stdin ending marks the pty revoked; the disconnect handler then tears down.
		process.stdin.emit("end");

		expect(teardown).toEqual({ error: undefined });
	});
});
