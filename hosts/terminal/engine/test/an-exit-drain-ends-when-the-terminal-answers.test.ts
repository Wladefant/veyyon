import "./warm-natives"; // load the native addon under the real platform before any process.platform mock
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ProcessTerminal } from "@veyyon/tui/terminal";
import { setTerminalHeadless } from "@veyyon/utils";
import { drainMicrotasks } from "../../../../packages/utils/test/helpers/drain-microtasks";
import { restoreProperty } from "../../../../packages/utils/test/helpers/restore-global";

/**
 * WHY. Before handing the terminal back, the TUI drains stdin so a key the terminal encoded under a
 * keyboard protocol (a Kitty key release) cannot reach the parent shell. The drain ended only after
 * 50 ms with no input, so every exit from the TUI held the terminal for at least 50 ms, which was most
 * of the time between Ctrl+D and the shell prompt. A fixed quiet window is also the wrong end
 * condition for a slow SSH link, whose in-flight bytes can arrive after it closes.
 *
 * THE CLASS. On a terminal that answers DA1, the drain ends when the answer to a DA1 query written
 * after the keyboard protocols are popped arrives: the terminal answers in the order it reads, so
 * nothing encoded under the popped protocol can follow that answer. The drain never takes an earlier
 * probe's answer for its own, swallows everything that arrives before its answer, hands later input
 * back to the input handler, and still ends at `maxMs` when no answer comes. A terminal that never
 * answered DA1 is not asked, and keeps the quiet window.
 *
 * The suite drives the real `ProcessTerminal`: stdout is captured and terminal replies are injected
 * on stdin, because the contract is the bytes written and the input delivered.
 *
 * WHAT THIS DOES NOT CATCH. That a real terminal answers DA1 in read order is terminal behavior, not
 * something a unit test can assert. The answer state reset in `stop()` is not exercised.
 */

const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stdinSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");

const DA1_QUERY = "\x1b[c";
const DA1_ANSWER = "\x1b[?62;22c";
const KITTY_FLAGS_ANSWER = "\x1b[?0u";
const KITTY_POP = "\x1b[<u";
/** Ctrl+D released, as a Kitty terminal reports it under event-type reporting. */
const KITTY_RELEASE = "\x1b[100;5:3u";
/** A bound no passing test reaches: a drain that waits for it fails on the test timeout instead. */
const NEVER_MS = 60_000;

describe("an exit drain ends when the terminal answers", () => {
	let previousHeadless = false;
	let live: ProcessTerminal | undefined;

	beforeEach(() => {
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(), configurable: true });
		previousHeadless = setTerminalHeadless(false);
	});

	afterEach(() => {
		live?.stop();
		live = undefined;
		vi.restoreAllMocks();
		setTerminalHeadless(previousHeadless);
		restoreProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
		restoreProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
		restoreProperty(process.stdin, "setRawMode", stdinSetRawModeDescriptor);
	});

	function setup() {
		const writes: string[] = [];
		const inputs: string[] = [];
		vi.spyOn(process, "kill").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			writes.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		});

		const terminal = new ProcessTerminal();
		live = terminal;
		terminal.start(
			data => inputs.push(data),
			() => {},
		);
		const sent = () => writes.join("");
		const asked = () => sent().split(DA1_QUERY).length - 1;
		let answered = 0;
		const type = (data: string) => process.stdin.emit("data", data);
		/** Answer the DA1 queries written so far, oldest first, up to `count` of them. */
		const answer = (count = asked() - answered) => {
			for (let i = 0; i < count; i++, answered++) type(DA1_ANSWER);
		};
		return { terminal, sent, inputs, asked, answer, type };
	}

	it("writes its query after the keyboard protocol is popped and ends on the answer", async () => {
		const { terminal, sent, answer, type } = setup();
		type(KITTY_FLAGS_ANSWER);
		answer();
		const mark = sent().length;

		const drained = terminal.drainInput(NEVER_MS, NEVER_MS);
		expect(sent().slice(mark)).toBe(`${KITTY_POP}${DA1_QUERY}`);
		answer();
		await drained;
	});

	it("swallows what arrives before its answer and hands later input back", async () => {
		const { terminal, inputs, answer, type } = setup();
		answer();
		type("a");

		const drained = terminal.drainInput(NEVER_MS, NEVER_MS);
		type(KITTY_RELEASE);
		answer();
		await drained;
		type("b");

		expect(inputs).toEqual(["a", "b"]);
	});

	it("does not end on the answer to a probe written before it", async () => {
		const { terminal, asked, answer } = setup();
		const startupQueries = asked();
		expect(startupQueries).toBeGreaterThan(1);
		answer(1);

		let ended = false;
		const drained = terminal.drainInput(NEVER_MS, NEVER_MS).then(() => {
			ended = true;
		});
		for (let i = 1; i < startupQueries; i++) {
			answer(1);
			await drainMicrotasks(4);
			expect(ended).toBe(false);
		}
		answer(1);
		await drained;
		expect(ended).toBe(true);
	});

	it("ends at maxMs when the answer never comes, and hands input back", async () => {
		const { terminal, inputs, answer, type } = setup();
		answer();

		const started = performance.now();
		await terminal.drainInput(40, NEVER_MS);
		const elapsed = performance.now() - started;
		type("z");

		expect(elapsed).toBeGreaterThanOrEqual(35);
		expect(elapsed).toBeLessThan(NEVER_MS);
		expect(inputs).toEqual(["z"]);
	});

	it("does not ask a terminal that never answered, and drains it for the quiet window", async () => {
		const { terminal, sent } = setup();
		const mark = sent().length;

		const started = performance.now();
		await terminal.drainInput(NEVER_MS, 20);
		const elapsed = performance.now() - started;

		expect(sent().slice(mark)).not.toContain(DA1_QUERY);
		expect(elapsed).toBeGreaterThanOrEqual(15);
		expect(elapsed).toBeLessThan(NEVER_MS);
	});
});
