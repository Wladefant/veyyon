import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
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

	function astraWindow(): number | null | undefined {
		const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.json"), { fetch: offlineFetch });
		return registry.getAll().find(m => m.provider === "openai-codex" && m.id === "gpt-6-astra")?.contextWindow;
	}

	test("caps at the standard-pricing window by default", () => {
		expect(astraWindow()).toBe(272_000);
	});

	test("allows the advertised maximum with extendedContext on", () => {
		settings.set("extendedContext", true);
		expect(astraWindow()).toBe(922_000);
	});
});
