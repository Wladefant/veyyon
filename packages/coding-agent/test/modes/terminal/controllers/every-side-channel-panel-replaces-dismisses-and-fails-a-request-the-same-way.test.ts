/**
 * WHY: `/btw` and `/omfg` each kept a private copy of the same request lifecycle: show a panel,
 * abort and replace the one already open, dismiss it on Escape, close it on dispose, and paint a
 * failure only while the request is still on screen. The copies could drift apart one branch at a
 * time. Both controllers now hold a `SidePanelSlot` (`controllers/side-panel-slot.ts`), and this
 * suite drives every side-channel controller through the real class against the same invariants.
 *
 * The class: a replaced request that keeps running, a replaced request whose late failure paints
 * over its successor, an Escape that dismisses without cancelling the model turn, a dispose that
 * leaves a turn running, and a failure that never reaches the panel or reports a cancellation as an
 * error.
 *
 * The sweep reads `components/dialogs/` at run time: a new `*-panel.ts` turns this suite red until
 * it gets a harness here or a recorded reason in `NOT_A_SIDE_CHANNEL_REQUEST`.
 *
 * Not caught: the slot's guard that skips painting a replaced panel. A closed panel already
 * ignores every later outcome (pinned by the dialogs suite), so removing the guard paints nothing.
 * The controllers' own flows after a turn returns (copy, branch, save, amend) belong to
 * `btw-controller.test.ts` and `omfg-controller.test.ts`.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@veyyon/ai";
import { emptyUsage } from "@veyyon/catalog/models";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { BtwPanelComponent } from "@veyyon/coding-agent/modes/terminal/components/dialogs/btw-panel";
import { BtwController } from "@veyyon/coding-agent/modes/terminal/controllers/btw-controller";
import {
	OmfgController,
	type OmfgControllerContext,
} from "@veyyon/coding-agent/modes/terminal/controllers/omfg-controller";
import { SidePanelSlot } from "@veyyon/coding-agent/modes/terminal/controllers/side-panel-slot";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { type Component, Container, type TUI } from "@veyyon/tui";

const DIALOGS_DIR = path.join(import.meta.dirname, "../../../../src/modes/terminal/components/dialogs");

/** Panels under `components/dialogs/` that no side-channel request shows, with the reason. */
const NOT_A_SIDE_CHANNEL_REQUEST: Record<string, string> = {
	"rollback-panel": "a settings sub-page the settings selector mounts; it runs no model turn",
};

interface TurnResult {
	replyText: string;
	assistantMessage: AssistantMessage;
}

interface Turn {
	signal: AbortSignal;
	settle: PromiseWithResolvers<TurnResult>;
}

interface SideChannelController {
	start(text: string): Promise<void>;
	hasActiveRequest(): boolean;
	handleEscape(): boolean;
	dispose(): void;
}

interface Harness {
	controller: SideChannelController;
	container: Container;
	/** Every model turn the controller started, in order, each held open until the test settles it. */
	turns: Turn[];
}

function reply(text: string): TurnResult {
	return {
		replyText: text,
		assistantMessage: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		},
	};
}

function heldSession(turns: Turn[]): InteractiveModeContext["session"] {
	return {
		model: { provider: "anthropic", id: "claude-sonnet-4-5" },
		messages: [],
		runEphemeralTurn(args: { signal?: AbortSignal }): Promise<TurnResult> {
			const settle = Promise.withResolvers<TurnResult>();
			turns.push({ signal: args.signal as AbortSignal, settle });
			return settle.promise;
		},
	} as unknown as InteractiveModeContext["session"];
}

const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;

function unexpectedPrompt(): never {
	throw new Error("a lifecycle case never reaches a prompt");
}

/** One harness per side-channel panel, keyed by the panel module's basename. */
const HARNESSES: Record<string, () => Harness> = {
	"btw-panel": () => {
		const turns: Turn[] = [];
		const container = new Container();
		const ctx = {
			ui,
			btwContainer: container,
			session: heldSession(turns),
			sessionManager: { getLeafId: () => "leaf-1" },
			showStatus() {},
			showError() {},
		} as unknown as InteractiveModeContext;
		return { controller: new BtwController(ctx), container, turns };
	},
	"omfg-panel": () => {
		const turns: Turn[] = [];
		const container = new Container();
		const ctx: OmfgControllerContext = {
			ui,
			omfgContainer: container,
			session: heldSession(turns),
			sessionManager: { getCwd: () => "/repo" } as unknown as InteractiveModeContext["sessionManager"],
			settings: { getAgentDir: () => "/agent" } as unknown as InteractiveModeContext["settings"],
			showStatus() {},
			showError() {},
			showHookConfirm: unexpectedPrompt,
			showHookInput: unexpectedPrompt,
			showHookSelector: unexpectedPrompt,
		};
		return { controller: new OmfgController(ctx), container, turns };
	},
};

function painted(component: Component | undefined): string {
	if (!component) throw new Error("the slot shows no panel");
	return component
		.render(100)
		.map(row => stripVTControlCharacters(row))
		.join("\n");
}

/** Let a settled turn's continuation and the slot's failure handler run. */
async function settleWork(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	await initTheme();
});

describe("every side-channel panel replaces, dismisses and fails a request the same way", () => {
	it("gives every panel under components/dialogs a harness or a recorded reason", () => {
		const panels = fs
			.readdirSync(DIALOGS_DIR)
			.filter(name => name.endsWith("-panel.ts"))
			.map(name => name.slice(0, -".ts".length))
			.sort();
		const unclaimed = panels.filter(panel => !(panel in HARNESSES) && !(panel in NOT_A_SIDE_CHANNEL_REQUEST));
		expect(unclaimed).toEqual([]);
		expect(Object.keys(NOT_A_SIDE_CHANNEL_REQUEST)).toEqual(["rollback-panel"]);
		expect(panels.filter(panel => panel in HARNESSES)).toEqual(Object.keys(HARNESSES).sort());
	});

	for (const [panel, harness] of Object.entries(HARNESSES)) {
		describe(panel, () => {
			it("aborts the open request when a second one starts, and keeps only the new panel", async () => {
				const { controller, container, turns } = harness();
				await controller.start("first");
				const firstPanel = container.children[0];
				await controller.start("second");

				expect(turns.map(turn => turn.signal.aborted)).toEqual([true, false]);
				expect(container.children).toHaveLength(1);
				expect(container.children[0]).not.toBe(firstPanel);

				turns[0]?.settle.reject(new Error("the replaced turn failed late"));
				await settleWork();
				expect(painted(container.children[0])).not.toContain("the replaced turn failed late");
				expect(controller.hasActiveRequest()).toBe(true);
			});

			it("paints a failure on the open panel and keeps it open", async () => {
				const { controller, container, turns } = harness();
				await controller.start("question");
				turns[0]?.settle.reject(new Error("provider refused the request"));
				await settleWork();

				const text = painted(container.children[0]);
				expect(text).toContain("provider refused the request");
				expect(text).toContain("Error · Esc dismiss");
				expect(controller.hasActiveRequest()).toBe(true);
			});

			it("cancels a running request on Escape, empties the slot, and finds nothing on a second Escape", async () => {
				const { controller, container, turns } = harness();
				await controller.start("question");

				expect(controller.handleEscape()).toBe(true);
				expect(turns[0]?.signal.aborted).toBe(true);
				expect(container.children).toHaveLength(0);
				expect(controller.hasActiveRequest()).toBe(false);
				expect(controller.handleEscape()).toBe(false);
			});

			it("keeps a dismissed request off screen when its turn finishes afterwards", async () => {
				const { controller, container, turns } = harness();
				await controller.start("question");
				controller.handleEscape();

				turns[0]?.settle.resolve(reply("a reply nobody is waiting for"));
				await settleWork();
				expect(container.children).toHaveLength(0);
				expect(controller.hasActiveRequest()).toBe(false);
			});

			it("cancels a running request on dispose and empties the slot", async () => {
				const { controller, container, turns } = harness();
				await controller.start("question");
				controller.dispose();

				expect(turns[0]?.signal.aborted).toBe(true);
				expect(container.children).toHaveLength(0);
				expect(controller.hasActiveRequest()).toBe(false);
			});
		});
	}

	it("paints a request cancelled while still open as cancelled, not as an error", async () => {
		const container = new Container();
		const slot = new SidePanelSlot({ container: () => container, requestRender() {} });
		const request = {
			component: new BtwPanelComponent({ question: "why", tui: ui }),
			abortController: new AbortController(),
		};
		slot.show(request);
		request.abortController.abort();
		await slot.run(request, async () => {
			throw new Error("The operation was aborted.");
		});

		const text = painted(container.children[0]);
		expect(text).toContain("Cancelled · Esc dismiss");
		expect(text).not.toContain("The operation was aborted.");
	});
});
