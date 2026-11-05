/**
 * A key pressed on the account card answers on the card.
 *
 * WHY: `r` read as a key that did nothing. Two defects made it so. Its outcome, like every other
 * card action's, was written to the transcript, which sits under the fullscreen card until the card
 * closes. And the usage bars were refolded from the five-minute usage cache while the health probe
 * that `r` runs had just read the usage endpoint live and thrown the reading away, so the bars stayed
 * where they were. A third defect rode along: `r` on the add entry, which selects no account, probed
 * every stored credential of every provider instead of the provider on screen.
 *
 * The class: a card action whose outcome lands only off-screen, and a refresh that refreshes nothing
 * the operator can see. This file drives the real controller, the real card and a real credential
 * store; only the provider's network (the health probe and the usage fan-out) is stubbed.
 *
 * What it does NOT catch: whether a provider's own usage endpoint returns fresh numbers, and the
 * wording of the transcript record each action also writes.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
	AuthStorage,
	type CheckCredentialsOptions,
	type CredentialHealthResult,
	SqliteAuthCredentialStore,
	type UsageReport,
} from "@veyyon/ai";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AccountManagerComponent } from "@veyyon/coding-agent/modes/terminal/components/account/account-manager";
import { SelectorController } from "@veyyon/coding-agent/modes/terminal/controllers/selector-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import { formatProviderName } from "@veyyon/coding-agent/session/account-format";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { useIsolatedAgentDir } from "../../../helpers/isolated-agent-dir";

useIsolatedAgentDir({ globalSettings: true });

const SESSION_ID = "session-card-notice-test";
const ENTER = "\r";
const DOWN = "\x1b[B";
const ANTHROPIC = formatProviderName("anthropic");

let tempDir = "";
let store: SqliteAuthCredentialStore | undefined;
let authStorage: AuthStorage | undefined;

beforeAll(async () => {
	await initTheme();
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-card-notice-"));
	store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
	authStorage = new AuthStorage(store);
});

afterAll(async () => {
	store?.close();
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
	vi.restoreAllMocks();
});

function credential(email: string, accountId: string) {
	return {
		type: "oauth" as const,
		access: `access-${accountId}`,
		refresh: `refresh-${accountId}`,
		expires: Date.now() + 8 * 60 * 60_000,
		accountId,
		email,
	};
}

/** One account's five-hour window at `usedFraction`, the way Anthropic's usage endpoint reports it. */
function usageReport(email: string, usedFraction: number, fetchedAt: number): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt,
		metadata: { email },
		limits: [
			{
				id: "five-hour",
				label: "Claude 5 Hour",
				scope: { provider: "anthropic", windowId: "5h" },
				window: { id: "5h", label: "5 Hour", durationMs: 5 * 60 * 60_000 },
				amount: { usedFraction, unit: "percent" },
			},
		],
	};
}

type HealthAnswer = (options: CheckCredentialsOptions | undefined) => Promise<CredentialHealthResult[]>;

interface Harness {
	readonly card: AccountManagerComponent;
	readonly frame: () => string;
	/** The credential ids each health probe was asked about, in order; `undefined` is every row. */
	readonly probed: (readonly number[] | undefined)[];
	readonly ids: { first: number; second: number; codex: number };
}

/**
 * Two Anthropic accounts and one OpenAI Codex account, the card open on Anthropic.
 *
 * The usage fan-out answers from a cache taken an hour ago: 13% on the first account, 42% on the
 * second. `health` answers each health probe after the card's opening one.
 */
async function openCard(health: HealthAnswer): Promise<Harness> {
	const storage = authStorage;
	if (!storage) throw new Error("no auth storage");
	await storage.set("anthropic", [
		credential("first@example.com", "acct-first"),
		credential("second@example.com", "acct-second"),
	]);
	await storage.set("openai-codex", [credential("codex@example.com", "acct-codex")]);
	const [first, second] = storage.listStoredCredentials("anthropic");
	const [codex] = storage.listStoredCredentials("openai-codex");
	if (!first || !second || !codex) throw new Error("credentials were not stored");

	const probed: (readonly number[] | undefined)[] = [];
	let opening = true;
	vi.spyOn(storage, "checkCredentials").mockImplementation(async options => {
		probed.push(options?.credentialIds);
		if (opening) {
			opening = false;
			return [];
		}
		return health(options);
	});

	const hourAgo = Date.now() - 60 * 60_000;
	const cards: AccountManagerComponent[] = [];
	const ctx = {
		editorContainer: { children: [], clear: () => {}, addChild: () => {} },
		editor: {},
		present: vi.fn(),
		ui: {
			setFocus: vi.fn(),
			requestRender: vi.fn(),
			requestComponentRender: vi.fn(),
			showOverlay: vi.fn((component: unknown) => {
				if (component instanceof AccountManagerComponent) cards.push(component);
				return { hide: vi.fn() };
			}),
		},
		session: {
			sessionId: SESSION_ID,
			settings: Settings.instance,
			modelRegistry: {
				authStorage: storage,
				refresh: vi.fn(async () => undefined),
				refreshInBackground: vi.fn(),
			},
			fetchUsageReports: async () => [
				usageReport("first@example.com", 0.13, hourAgo),
				usageReport("second@example.com", 0.42, hourAgo),
			],
		},
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
		refreshComposerShortcuts: vi.fn(),
		dismissWelcome: vi.fn(),
	} as unknown as InteractiveModeContext;

	await new SelectorController(ctx).showAccountManager("anthropic");
	const card = cards[0];
	if (!card || cards.length !== 1) throw new Error(`expected one mounted card, got ${cards.length}`);
	return {
		card,
		frame: () =>
			card
				.render(200)
				.map(line => stripVTControlCharacters(line))
				.join("\n"),
		probed,
		ids: { first: first.id, second: second.id, codex: codex.id },
	};
}

/** Wait for `predicate`, bounded, so a notice that never lands fails by name instead of hanging. */
async function until(predicate: () => boolean, what: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (predicate()) return;
		const tick = Promise.withResolvers<void>();
		setTimeout(tick.resolve, 1);
		await tick.promise;
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** The percentage the five-hour bar of the account labelled `email` shows. */
function fiveHourPercent(frame: string, email: string): string | undefined {
	const lines = frame.split("\n");
	const at = lines.findIndex(line => line.includes(email));
	if (at < 0) return undefined;
	for (const line of lines.slice(at + 1)) {
		const percent = /5 Hour\s.*\]\s(\d+%)/.exec(line)?.[1];
		if (percent) return percent;
	}
	return undefined;
}

describe("a key pressed on the account card answers on the card", () => {
	it("r says it is checking at once, then what the provider answered, and redraws the bars", async () => {
		const answer = Promise.withResolvers<CredentialHealthResult[]>();
		const harness = await openCard(() => answer.promise);
		expect(fiveHourPercent(harness.frame(), "first@example.com")).toBe("13%");

		harness.card.handleInput("r");
		const subject = `first@example.com (${ANTHROPIC})`;
		expect(harness.frame()).toContain(`Checking ${subject}…`);
		expect(harness.probed.at(-1)).toEqual([harness.ids.first]);

		answer.resolve([
			{
				id: harness.ids.first,
				provider: "anthropic",
				type: "oauth",
				ok: true,
				report: usageReport("first@example.com", 0.87, Date.now()),
			},
		]);
		await until(() => harness.frame().includes(`${subject}: signed in · usage updated`), "the result notice");
		const frame = harness.frame();
		expect(frame).not.toContain("Checking");
		expect(fiveHourPercent(frame, "first@example.com")).toBe("87%");
		// The probe answered for the first account only: the sibling keeps the cached reading.
		expect(fiveHourPercent(frame, "second@example.com")).toBe("42%");
	});

	it("r on an account the provider refuses reports the refusal on the card", async () => {
		const harness = await openCard(async () => [
			{ id: harness.ids.first, provider: "anthropic", type: "oauth", ok: false, reason: "invalid_grant" },
		]);
		harness.card.handleInput("r");
		await until(
			() => harness.frame().includes(`first@example.com (${ANTHROPIC}): check failed: invalid_grant`),
			"the refusal notice",
		);
	});

	it("r on an account with no usage probe says it could not be checked, and why", async () => {
		const harness = await openCard(async () => [
			{
				id: harness.ids.first,
				provider: "anthropic",
				type: "oauth",
				ok: null,
				reason: "usage probe returned no data for this credential",
			},
		]);
		harness.card.handleInput("r");
		await until(
			() =>
				harness
					.frame()
					.includes(
						`first@example.com (${ANTHROPIC}): could not be checked: usage probe returned no data for this credential`,
					),
			"the unverifiable notice",
		);
	});

	it("r whose probe fails outright says the check did not run", async () => {
		const harness = await openCard(async () => {
			throw new Error("credential store is locked");
		});
		harness.card.handleInput("r");
		await until(
			() =>
				harness
					.frame()
					.includes(`first@example.com (${ANTHROPIC}): the check did not run: credential store is locked`),
			"the failed-probe notice",
		);
	});

	it("r on the add entry checks the provider on screen and no other", async () => {
		const harness = await openCard(async options =>
			(options?.credentialIds ?? []).map(id => ({ id, provider: "anthropic", type: "oauth" as const, ok: true })),
		);
		// Two accounts, then the add entry.
		harness.card.handleInput(DOWN);
		harness.card.handleInput(DOWN);
		harness.card.handleInput("r");
		expect(harness.probed.at(-1)).toEqual([harness.ids.first, harness.ids.second]);
		expect(harness.probed.at(-1)).not.toContain(harness.ids.codex);
		await until(
			() => harness.frame().includes(`${ANTHROPIC}: checked 2 accounts · 2 signed in`),
			"the provider-wide notice",
		);
	});

	it("enter reports the account it moved traffic to on the card", async () => {
		const harness = await openCard(async () => []);
		harness.card.handleInput(DOWN);
		harness.card.handleInput(ENTER);
		expect(harness.frame()).toContain(`${ANTHROPIC}: now using second@example.com everywhere on this machine`);
	});
});
