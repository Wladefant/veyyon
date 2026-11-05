/**
 * WHY THIS EXISTS. The `/mcp add` wizard tests a server connection after the last connection field,
 * then pauses on the outcome ("Connection successful!", "Adding server anyway...") before it opens the
 * review step. Both halves ran outside any keystroke: the check is awaited and the pause is a timer.
 *
 * The class this closes is an asynchronous step change that ignores the card's current state:
 *  - the outcome and the review step were drawn without asking the host for a repaint, so the card
 *    kept showing the field it had left until the next key arrived;
 *  - Esc during the check or the pause stepped back, and the settled check or the timer then pulled
 *    the wizard forward to the review step anyway;
 *  - a dismissed wizard still ran its pause timer and asked the host to repaint a card it had closed.
 *
 * Every case drives the real component through `handleInput` and observes the rendered body and the
 * repaint requests it makes; the clock is faked so the pause is crossed deterministically.
 *
 * WHAT IT DOES NOT CATCH. The OAuth branch of the check after endpoints are discovered, which launches
 * a browser flow, and the host overlay that mounts the card.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as oauthDiscovery from "@veyyon/coding-agent/mcp/oauth-discovery";
import type { MCPServerConfig } from "@veyyon/coding-agent/mcp/types";
import { MCPAddWizard } from "@veyyon/coding-agent/modes/terminal/components/dialogs/mcp-add-wizard";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { drainMicrotasks } from "../../../../../utils/test/helpers/drain-microtasks";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../../helpers/stdout-geometry";

const WIDTH = 110;
const SUCCESS_PAUSE_MS = 1000;
const FAILURE_PAUSE_MS = 2000;

let geometry: StubbedStdoutGeometry;

beforeEach(async () => {
	await initTheme(false);
	geometry = stubStdoutGeometry({ columns: WIDTH, rows: 40 });
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	geometry.restore();
});

interface Harness {
	wizard: MCPAddWizard;
	repaints: () => number;
	body: () => string;
}

function makeWizard(onTestConnection: (config: MCPServerConfig) => Promise<void>): Harness {
	let repaints = 0;
	const wizard = new MCPAddWizard(
		() => {},
		() => {},
		undefined,
		onTestConnection,
		() => {
			repaints += 1;
		},
		"local-server",
	);
	return {
		wizard,
		repaints: () => repaints,
		body: () =>
			wizard
				.render(WIDTH)
				.map(line => Bun.stripANSI(line))
				.join("\n"),
	};
}

/** Transport list → stdio → command "node" → empty arguments, whose Enter starts the check. */
function reachArgumentsStep(wizard: MCPAddWizard): void {
	wizard.handleInput("\n");
	for (const ch of "node") wizard.handleInput(ch);
	wizard.handleInput("\n");
}

/** Transport list → http → a valid URL, whose Enter starts the check. */
function submitHttpUrl(wizard: MCPAddWizard): void {
	wizard.handleInput("\x1b[B");
	wizard.handleInput("\n");
	for (const ch of "https://api.example.com/mcp") wizard.handleInput(ch);
	wizard.handleInput("\n");
}

describe("a successful connection check", () => {
	it("repaints the outcome and then the review step without waiting for a key", async () => {
		const h = makeWizard(async () => {});
		reachArgumentsStep(h.wizard);
		expect(h.body()).toContain("Step 4: Arguments");

		h.wizard.handleInput("\n");
		const beforeCheck = h.repaints();
		await drainMicrotasks(10);

		expect(h.body()).toContain("Connection successful!");
		expect(h.repaints()).toBeGreaterThan(beforeCheck);

		const beforeAdvance = h.repaints();
		vi.advanceTimersByTime(SUCCESS_PAUSE_MS);

		expect(h.body()).toContain("Review Configuration");
		expect(h.repaints()).toBeGreaterThan(beforeAdvance);
	});

	it("stays on the step Esc returned to when the pause ends", async () => {
		const h = makeWizard(async () => {});
		reachArgumentsStep(h.wizard);
		h.wizard.handleInput("\n");
		await drainMicrotasks(10);
		expect(h.body()).toContain("Connection successful!");

		h.wizard.handleInput("\x1b");
		expect(h.body()).toContain("Step 3: Command");

		vi.advanceTimersByTime(SUCCESS_PAUSE_MS * 5);
		expect(h.body()).toContain("Step 3: Command");
		expect(h.body()).not.toContain("Review Configuration");
	});

	it("is dropped when Esc leaves the step before the check settles", async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		const h = makeWizard(() => promise);
		reachArgumentsStep(h.wizard);
		h.wizard.handleInput("\n");

		h.wizard.handleInput("\x1b");
		expect(h.body()).toContain("Step 3: Command");

		resolve();
		await drainMicrotasks(10);
		vi.advanceTimersByTime(SUCCESS_PAUSE_MS * 5);

		expect(h.body()).toContain("Step 3: Command");
		expect(h.body()).not.toContain("Connection successful!");
		expect(h.body()).not.toContain("Review Configuration");
	});

	it("asks for no repaint once the wizard is dismissed during the pause", async () => {
		const h = makeWizard(async () => {});
		reachArgumentsStep(h.wizard);
		h.wizard.handleInput("\n");
		await drainMicrotasks(10);
		expect(h.body()).toContain("Connection successful!");

		h.wizard.dispose();
		expect(vi.getTimerCount()).toBe(0);

		const atDismiss = h.repaints();
		vi.advanceTimersByTime(SUCCESS_PAUSE_MS * 5);
		expect(h.repaints()).toBe(atDismiss);
	});
});

describe("a failed connection check", () => {
	it("repaints the failure and then the review step without waiting for a key", async () => {
		const h = makeWizard(async () => {
			throw new Error("spawn node ENOENT");
		});
		reachArgumentsStep(h.wizard);
		h.wizard.handleInput("\n");
		const beforeCheck = h.repaints();
		await drainMicrotasks(10);

		expect(h.body()).toContain("Connection failed");
		expect(h.repaints()).toBeGreaterThan(beforeCheck);

		vi.advanceTimersByTime(FAILURE_PAUSE_MS - 1);
		expect(h.body()).toContain("Connection failed");

		const beforeAdvance = h.repaints();
		vi.advanceTimersByTime(1);
		expect(h.body()).toContain("Review Configuration");
		expect(h.repaints()).toBeGreaterThan(beforeAdvance);
	});

	it("stays on the step Esc returned to when the pause ends", async () => {
		const h = makeWizard(async () => {
			throw new Error("spawn node ENOENT");
		});
		reachArgumentsStep(h.wizard);
		h.wizard.handleInput("\n");
		await drainMicrotasks(10);
		expect(h.body()).toContain("Connection failed");

		h.wizard.handleInput("\x1b");
		vi.advanceTimersByTime(FAILURE_PAUSE_MS * 5);

		expect(h.body()).toContain("Step 3: Command");
		expect(h.body()).not.toContain("Review Configuration");
	});
});

describe("a check abandoned while it is in flight", () => {
	it("leaves the step Esc returned to when a failing check settles afterwards", async () => {
		const { promise, reject } = Promise.withResolvers<void>();
		const h = makeWizard(() => promise);
		reachArgumentsStep(h.wizard);
		h.wizard.handleInput("\n");

		h.wizard.handleInput("\x1b");
		reject(new Error("spawn node ENOENT"));
		await drainMicrotasks(10);
		vi.advanceTimersByTime(FAILURE_PAUSE_MS * 5);

		expect(h.body()).toContain("Step 3: Command");
		expect(h.body()).not.toContain("Connection failed");
		expect(h.body()).not.toContain("Review Configuration");
	});

	it("leaves the step Esc returned to when OAuth discovery for a refused check settles afterwards", async () => {
		const discovery = Promise.withResolvers<null>();
		vi.spyOn(oauthDiscovery, "discoverOAuthEndpoints").mockReturnValue(discovery.promise);
		const h = makeWizard(async () => {
			throw new Error("401 Unauthorized: API key required");
		});
		submitHttpUrl(h.wizard);
		await drainMicrotasks(10);

		h.wizard.handleInput("\x1b");
		expect(h.body()).toContain("Step 2: Transport Type");

		discovery.resolve(null);
		await drainMicrotasks(10);

		expect(h.body()).toContain("Step 2: Transport Type");
		expect(h.body()).not.toContain("API Key Required");
	});
});

describe("a check that needs a credential", () => {
	it("repaints the API key step once discovery finds no OAuth endpoints", async () => {
		vi.spyOn(oauthDiscovery, "discoverOAuthEndpoints").mockResolvedValue(null);
		const h = makeWizard(async () => {
			throw new Error("401 Unauthorized: API key required");
		});
		submitHttpUrl(h.wizard);
		const beforeCheck = h.repaints();
		await drainMicrotasks(10);

		expect(h.body()).toContain("API Key Required");
		expect(h.repaints()).toBeGreaterThan(beforeCheck);
	});
});

describe("a check superseded by a newer one", () => {
	it("shows the newer check's outcome even when the older one settles last", async () => {
		const older = Promise.withResolvers<void>();
		const newer = Promise.withResolvers<void>();
		const pending = [older.promise, newer.promise];
		const h = makeWizard(() => pending.shift() ?? Promise.resolve());
		reachArgumentsStep(h.wizard);
		h.wizard.handleInput("\n");
		h.wizard.handleInput("\n");

		newer.resolve();
		await drainMicrotasks(10);
		older.reject(new Error("spawn node ENOENT"));
		await drainMicrotasks(10);

		expect(h.body()).toContain("Connection successful!");
		expect(h.body()).not.toContain("Connection failed");
		vi.advanceTimersByTime(SUCCESS_PAUSE_MS);
		expect(h.body()).toContain("Review Configuration");
	});
});
