import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { buildModel } from "@veyyon/catalog/build";
import { writeModelCache } from "@veyyon/catalog/model-cache";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { settings } from "@veyyon/coding-agent/config/settings-instance";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";

/**
 * WHY: the catalog row for a Codex subscription model advertises 1M (or a 922K ceiling), but a session
 * that sends past 272K crosses the premium long-context price tier. The registry is the one place every
 * reader (compaction, budget, gauge) takes `contextWindow` from, so it must hand out the standard window
 * unless `extendedContext` is on, and the ceiling (never the 1M floor) when it is.
 * Not caught: a user `modelOverrides` contextWindow, which wins by design.
 */
describe("ModelRegistry extended context", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	const offlineFetch: FetchImpl = () => Promise.reject(new Error("network disabled in this test"));

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		tempDir = path.join(os.tmpdir(), `pi-test-extended-context-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
	});

	afterEach(() => {
		authStorage.close();
		resetSettingsForTest();
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	function windowOf(id: string, options?: { snapshotIo: boolean }): number | null | undefined {
		const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.json"), {
			fetch: offlineFetch,
			...options,
		});
		return registry.getAll().find(m => m.provider === "openai-codex" && m.id === id)?.contextWindow;
	}

	// gpt-5.6-sol is bundled at 1,000,000, so only the clamp can bring it to 272,000. gpt-6-astra is already
	// bundled at 272,000 and passes without the clamp.
	test("caps a 1M-window row at the standard-pricing window by default", () => {
		expect(windowOf("gpt-5.6-sol")).toBe(272_000);
	});

	test("allows the advertised maximum with extendedContext on", () => {
		settings.set("extendedContext", true);
		expect(windowOf("gpt-5.6-sol")).toBe(872_000);
		expect(windowOf("gpt-6-astra")).toBe(922_000);
	});

	// The static stage stores the discovery-derived rows AFTER the window policy ran, so a snapshot written in one
	// mode would serve the other mode's windows unless the extendedContext flag is part of its fingerprint. Bundled
	// rows never pass through the stage, so this drives a cached discovery row instead.
	test("a cached snapshot written in one mode is not served in the other", () => {
		writeModelCache(
			"cerebras",
			Date.now(),
			[
				buildModel({
					id: "cached-1m",
					name: "Cached 1M",
					provider: "cerebras",
					api: "openai-completions",
					baseUrl: "https://cached.example.test/v1",
					contextWindow: 1_000_000,
					maxContextWindow: 872_000,
					longContextCost: { inputThreshold: 272_000, input: 2, output: 3, cacheRead: 1, cacheWrite: 2 },
					maxTokens: 4_000,
					input: ["text"],
					reasoning: false,
					cost: { input: 1, output: 1.5, cacheRead: 0.5, cacheWrite: 1 },
				}),
			],
			false,
			"extended-context-contract",
			path.join(tempDir, "models.db"),
		);
		fs.writeFileSync(
			path.join(tempDir, "models.json"),
			JSON.stringify({ providers: { cerebras: { auth: "none" } } }),
		);
		const cachedWindow = () =>
			new ModelRegistry(authStorage, path.join(tempDir, "models.json"), {
				fetch: offlineFetch,
				snapshotIo: true,
			}).find("cerebras", "cached-1m")?.contextWindow;

		expect(cachedWindow()).toBe(272_000);
		settings.set("extendedContext", true);
		expect(cachedWindow()).toBe(872_000);
		settings.set("extendedContext", false);
		expect(cachedWindow()).toBe(272_000);
	});
});
