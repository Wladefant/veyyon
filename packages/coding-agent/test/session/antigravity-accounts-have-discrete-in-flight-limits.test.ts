/**
 * Antigravity accounts have discrete in-flight request limits.
 *
 * Replaces the single shared Antigravity usage limit with discrete controls keyed by
 * authenticated account identity. Verifies that two accounts display, persist, and apply
 * distinct limits, with backward-compatible loading of legacy single-limit configs and
 * clean migration to the per-account shape.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	__providerInFlightForTesting,
	AuthStorage,
	configureProviderMaxInFlightRequests,
	resolveProviderInFlightLimit,
	resolveProviderInFlightSlotKey,
	SqliteAuthCredentialStore,
	streamSimple,
} from "@veyyon/ai";
import { clearCustomApis } from "@veyyon/ai/api-registry";
import { createMockModel, registerMockApi } from "@veyyon/ai/providers/mock";
import type { Context } from "@veyyon/ai/types";
import {
	migrateAntigravityLimits,
	normalizeProviderMaxInFlightRequests,
	resetSettingsForTest,
	Settings,
	settings,
	validateProviderMaxInFlightRequests,
} from "@veyyon/coding-agent/config/settings";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/terminal/components/selectors/settings-selector";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { stripAnsi } from "@veyyon/utils/strip-ansi";

function sampleContext(): Context {
	return {
		systemPrompt: [],
		messages: [{ role: "user", content: "hello", timestamp: 0 }],
	};
}

describe("Antigravity discrete per-account limits", () => {
	let store: SqliteAuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	let limiterRoot: string | undefined;
	let tempConfigDir: string | undefined;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		limiterRoot = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-antigravity-test-"));
		__providerInFlightForTesting.setRoot(limiterRoot);

		tempConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-config-test-"));

		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempConfigDir });

		store = new SqliteAuthCredentialStore(new Database(":memory:"));
		authStorage = new AuthStorage(store);
		await authStorage.reload();

		await authStorage.set("google-antigravity", [
			{
				type: "oauth",
				access: "access-alice",
				refresh: "refresh-alice",
				expires: Date.now() + 3600_000,
				email: "alice@example.com",
				projectId: "project-alice",
			},
			{
				type: "oauth",
				access: "access-bob",
				refresh: "refresh-bob",
				expires: Date.now() + 3600_000,
				email: "bob@example.com",
				projectId: "project-bob",
			},
		]);
	});

	afterEach(async () => {
		clearCustomApis();
		configureProviderMaxInFlightRequests(undefined);
		__providerInFlightForTesting.setRoot(undefined);
		resetSettingsForTest();

		if (limiterRoot !== undefined) {
			await fs.rm(limiterRoot, { recursive: true, force: true });
			limiterRoot = undefined;
		}
		if (tempConfigDir !== undefined) {
			await fs.rm(tempConfigDir, { recursive: true, force: true });
			tempConfigDir = undefined;
		}

		store?.close();
		store = null;
		authStorage = null;
	});

	test("resolves distinct limits and slot keys for two Antigravity accounts", () => {
		const limits: Record<string, number> = {
			"google-antigravity:alice@example.com": 2,
			"google-antigravity:bob@example.com": 5,
		};

		const aliceLimit = resolveProviderInFlightLimit("google-antigravity", limits, "alice@example.com");
		const aliceSlot = resolveProviderInFlightSlotKey("google-antigravity", "alice@example.com", limits);

		const bobLimit = resolveProviderInFlightLimit("google-antigravity", limits, "bob@example.com");
		const bobSlot = resolveProviderInFlightSlotKey("google-antigravity", "bob@example.com", limits);

		expect(aliceLimit).toBe(2);
		expect(aliceSlot).toBe("google-antigravity:alice@example.com");

		expect(bobLimit).toBe(5);
		expect(bobSlot).toBe("google-antigravity:bob@example.com");

		// Unknown account with no limit falls back to undefined if no shared limit exists
		expect(resolveProviderInFlightLimit("google-antigravity", limits, "charlie@example.com")).toBeUndefined();
		expect(resolveProviderInFlightSlotKey("google-antigravity", "charlie@example.com", limits)).toBe(
			"google-antigravity",
		);
	});

	test("backward-compatible loading falls back to legacy shared limit before migration", () => {
		const legacyLimits: Record<string, number> = {
			"google-antigravity": 3,
		};

		// Both accounts pick up the shared legacy limit when per-account limit is not yet set
		expect(resolveProviderInFlightLimit("google-antigravity", legacyLimits, "alice@example.com")).toBe(3);
		expect(resolveProviderInFlightLimit("google-antigravity", legacyLimits, "bob@example.com")).toBe(3);
		// Slot key falls back to provider since no account-specific limit key exists
		expect(resolveProviderInFlightSlotKey("google-antigravity", "alice@example.com", legacyLimits)).toBe(
			"google-antigravity",
		);
	});

	test("migrates legacy shared limit cleanly to discrete per-account entries", () => {
		const legacyLimits: Record<string, number> = {
			"google-antigravity": 4,
			anthropic: 8,
		};

		const migrated = migrateAntigravityLimits(legacyLimits, ["alice@example.com", "bob@example.com"]);

		expect(migrated).toEqual({
			anthropic: 8,
			"google-antigravity:alice@example.com": 4,
			"google-antigravity:bob@example.com": 4,
		});
		expect(migrated["google-antigravity"]).toBeUndefined();

		// If an account already had a discrete limit configured, it is preserved
		const partiallyConfigured: Record<string, number> = {
			"google-antigravity": 3,
			"google-antigravity:alice@example.com": 1,
		};
		const migratedPartial = migrateAntigravityLimits(partiallyConfigured, ["alice@example.com", "bob@example.com"]);
		expect(migratedPartial).toEqual({
			"google-antigravity:alice@example.com": 1,
			"google-antigravity:bob@example.com": 3,
		});
	});

	test("persists and reloads discrete per-account limits in settings", async () => {
		const agentDir = path.join(tempConfigDir!, "agent");
		await fs.mkdir(agentDir, { recursive: true });

		const testSettings = await Settings.loadIsolated({ agentDir, cwd: agentDir });

		const perAccountLimits: Record<string, number> = {
			"google-antigravity:alice@example.com": 2,
			"google-antigravity:bob@example.com": 6,
		};

		testSettings.set("providers.maxInFlightRequests", perAccountLimits);
		await testSettings.flush();
		expect(testSettings.get("providers.maxInFlightRequests")).toEqual(perAccountLimits);

		// Reload from disk into a fresh Settings instance
		const reloadedSettings = await Settings.loadIsolated({ agentDir, cwd: agentDir });
		const reloaded = reloadedSettings.get("providers.maxInFlightRequests");
		expect(reloaded).toEqual(perAccountLimits);
		expect(validateProviderMaxInFlightRequests(reloaded)).toEqual(perAccountLimits);
		expect(normalizeProviderMaxInFlightRequests(reloaded)).toEqual(perAccountLimits);
	});

	test("applies distinct concurrent request limits independently in stream Simple", async () => {
		registerMockApi();

		const limits: Record<string, number> = {
			"google-antigravity:alice@example.com": 1,
			"google-antigravity:bob@example.com": 2,
		};

		const aliceFirstStarted = Promise.withResolvers<void>();
		const aliceReleaseFirst = Promise.withResolvers<void>();
		const bobBothActive = Promise.withResolvers<void>();
		const bobRelease = Promise.withResolvers<void>();

		let aliceActive = 0;
		let aliceMaxActive = 0;
		let bobActive = 0;
		let bobMaxActive = 0;

		const mock = createMockModel({
			provider: "google-antigravity",
			handler: async (_context, options) => {
				const isAlice = options?.accountIdentity === "alice@example.com";
				if (isAlice) {
					aliceActive++;
					aliceMaxActive = Math.max(aliceMaxActive, aliceActive);
					if (aliceActive === 1) {
						aliceFirstStarted.resolve();
						await aliceReleaseFirst.promise;
					}
					aliceActive--;
					return { content: ["alice response"] };
				}
				bobActive++;
				bobMaxActive = Math.max(bobMaxActive, bobActive);
				if (bobActive === 2) {
					bobBothActive.resolve();
				}
				await bobRelease.promise;
				bobActive--;
				return { content: ["bob response"] };
			},
		});

		// Start Alice call 1 (holds the 1 slot for Alice)
		const aliceCall1 = streamSimple(mock.model, sampleContext(), {
			maxInFlightRequests: limits,
			accountIdentity: "alice@example.com",
		});
		await aliceFirstStarted.promise;

		// Start Bob call 1 and Bob call 2 concurrently (Bob has limit 2)
		const bobCall1 = streamSimple(mock.model, sampleContext(), {
			maxInFlightRequests: limits,
			accountIdentity: "bob@example.com",
		});
		const bobCall2 = streamSimple(mock.model, sampleContext(), {
			maxInFlightRequests: limits,
			accountIdentity: "bob@example.com",
		});

		// Wait until both Bob calls are concurrently active in handler
		await bobBothActive.promise;
		expect(bobMaxActive).toBe(2);
		expect(aliceMaxActive).toBe(1);

		// Release Bob calls
		bobRelease.resolve();
		const [bobRes1, bobRes2] = await Promise.all([bobCall1.result(), bobCall2.result()]);
		expect(bobRes1.content).toEqual([{ type: "text", text: "bob response" }]);
		expect(bobRes2.content).toEqual([{ type: "text", text: "bob response" }]);

		// Release Alice call 1
		aliceReleaseFirst.resolve();
		const aliceRes1 = await aliceCall1.result();
		expect(aliceRes1.content).toEqual([{ type: "text", text: "alice response" }]);
	});

	test("settings selector displays discrete per-account controls for Antigravity", () => {
		if (!authStorage) throw new Error("setup error");

		settings.set("providers.maxInFlightRequests", {
			"google-antigravity:alice@example.com": 2,
			"google-antigravity:bob@example.com": 5,
		});

		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["default"],
				availablePersonalities: [],
				providers: ["google-antigravity", "openai"],
				cwd: process.cwd(),
				authStorage,
			},
			{
				onChange: () => {},
			},
		);

		const formatted = selector.formatProviderLimitsValue(settings.get("providers.maxInFlightRequests"));
		expect(formatted).toContain("google-antigravity:alice@example.com: 2");
		expect(formatted).toContain("google-antigravity:bob@example.com: 5");

		// Open submenu and check that discrete items are built
		const submenu = selector.createProviderLimitsInput(() => {});
		expect(submenu).toBeDefined();

		const rendered = submenu.render(120).map(stripAnsi).join("\n");
		expect(rendered).toContain("google-antigravity (alice@");
		expect(rendered).toContain("Limit: 2");
		expect(rendered).toContain("google-antigravity (bob@");
		expect(rendered).toContain("Limit: 5");

		const selectItems = submenu.mouseTarget()?.items ?? [];
		expect(selectItems.find(i => i.value === "google-antigravity:alice@example.com")).toEqual({
			value: "google-antigravity:alice@example.com",
			label: "google-antigravity (alice@example.com)",
			description: "Limit: 2",
		});
		expect(selectItems.find(i => i.value === "google-antigravity:bob@example.com")).toEqual({
			value: "google-antigravity:bob@example.com",
			label: "google-antigravity (bob@example.com)",
			description: "Limit: 5",
		});

		// Ensure AuthStorage lists the account identities
		const accountIdentities = authStorage.listOAuthAccountIdentities("google-antigravity");
		expect(accountIdentities).toEqual(["alice@example.com", "bob@example.com"]);
	});
});
