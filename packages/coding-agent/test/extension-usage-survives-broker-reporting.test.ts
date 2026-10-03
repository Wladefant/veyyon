/**
 * WHY: Broker aggregation must not hide a usage backend installed only in this process.
 * Drives the extension loader and provider registry, including source removal.
 * The external broker and quota endpoint are fixed responses; OAuth rotation is not covered.
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import type { UsageReport } from "@veyyon/ai/usage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { loadCliExtensionProviders } from "@veyyon/coding-agent/session/factory-extensions";
import { TempDir } from "@veyyon/utils";

const execFileAsync = promisify(execFile);

const EXTENSION = `export default function (pi) {
 pi.registerProvider("ext-usage", {
  usage: {
   cacheVersion: "extension-v1",
   async fetchUsage() {
    return { provider: "ext-usage", fetchedAt: 1, limits: [], metadata: { source: "extension" } };
   }
  }
 });
 pi.registerProvider("anthropic", {
  usage: {
   async fetchUsage() {
    return { provider: "anthropic", fetchedAt: 1, limits: [], metadata: { source: "wrong-local" } };
   }
  }
 });
}`;

class BrokerUsageStore extends SqliteAuthCredentialStore {
	async fetchUsageReports(): Promise<UsageReport[]> {
		return [{ provider: "anthropic", fetchedAt: 1, limits: [], metadata: { source: "broker" } }];
	}
}

test.each([false, true])("extension usage respects broker reports and caller override=%s", async callerOverride => {
	const tmp = await TempDir.create("@extension-broker-usage-");
	const source = callerOverride ? "caller" : "broker";
	const storage = new AuthStorage(new BrokerUsageStore(new Database(":memory:")), {
		usageProviderResolver: () => undefined,
		fetchUsageReports: callerOverride
			? async () => [{ provider: "anthropic", fetchedAt: 1, limits: [], metadata: { source } }]
			: undefined,
	});
	const registry = new ModelRegistry(storage, tmp.join("models.yml"), { snapshotIo: false });
	try {
		const extensionPath = tmp.join("usage.ts");
		await fs.writeFile(extensionPath, EXTENSION);
		await storage.set("ext-usage", { type: "api_key", key: "fake-extension-key" });
		await storage.set("anthropic", { type: "api_key", key: "fake-broker-key" });
		expect((await storage.fetchUsageReports())?.map(report => report.provider)).toEqual(["anthropic"]);

		await loadCliExtensionProviders(registry, Settings.isolated(), tmp.path(), {
			disableExtensionDiscovery: true,
			additionalExtensionPaths: [extensionPath],
		});
		const expected = [["anthropic", source]];
		if (!callerOverride) expected.push(["ext-usage", "extension"]);
		expect((await storage.fetchUsageReports())?.map(report => [report.provider, report.metadata?.source])).toEqual(
			expected,
		);

		registry.syncExtensionSources([]);
		expect((await storage.fetchUsageReports())?.map(report => [report.provider, report.metadata?.source])).toEqual([
			["anthropic", source],
		]);
	} finally {
		registry.syncExtensionSources([]);
		storage.close();
		await tmp.remove();
	}
});

test("the usage CLI loads a user-configured extension usage backend", async () => {
	const tmp = await TempDir.create("@usage-cli-extension-");
	try {
		const configDir = tmp.join("config");
		const extensionDir = tmp.join(".veyyon", "extensions");
		await fs.mkdir(extensionDir, { recursive: true });
		await fs.writeFile(path.join(extensionDir, "usage.ts"), EXTENSION);
		const agentDir = path.join(configDir, "profiles", "default", "agent");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(
			path.join(agentDir, "config.yml"),
			`extensions:\n  - ${JSON.stringify(path.join(extensionDir, "usage.ts"))}\n`,
		);
		const storage = new AuthStorage(
			await SqliteAuthCredentialStore.open(path.join(configDir, "shared-auth", "agent.db")),
		);
		try {
			await storage.set("ext-usage", { type: "api_key", key: "fake-extension-key" });
		} finally {
			storage.close();
		}
		const result = await execFileAsync(
			process.execPath,
			[path.resolve(import.meta.dirname, "../src/cli.ts"), "usage", "--json", "--provider", "ext-usage"],
			{
				cwd: tmp.path(),
				env: {
					...process.env,
					VEYYON_CONFIG_DIR: configDir,
					VEYYON_PROFILE: "default",
					VEYYON_AUTH_BROKER_URL: "",
					VEYYON_AUTH_BROKER_TOKEN: "",
				},
				timeout: 60_000,
				maxBuffer: 4 * 1024 * 1024,
			},
		);
		if (!result.stdout.trim()) throw new Error(`Usage CLI returned no JSON. Stderr: ${result.stderr}`);
		const payload = JSON.parse(result.stdout) as { reports: UsageReport[] };
		expect(payload.reports.map(report => [report.provider, report.metadata?.source])).toEqual([
			["ext-usage", "extension"],
		]);
	} finally {
		await tmp.remove();
	}
});
