/**
 * WHY: `veyyon plugin uninstall --json name@marketplace` printed the human line
 * "✓ Uninstalled name@marketplace". The marketplace branch of `uninstall` never
 * read `--json`, while its npm branch and both branches of `enable`/`disable` did,
 * so a script parsing the output broke only for marketplace installs.
 *
 * THE CLASS THIS CLOSES: a lifecycle verb that honours a flag on one install
 * route and not the other. The suite sweeps `PLUGIN_LIFECYCLE_VERBS` at run time
 * across both routes (a marketplace install and a linked install), so a new verb
 * in that table is covered without an edit here.
 *
 * WHAT IT DOES NOT CATCH: a lifecycle verb dispatched outside
 * `PLUGIN_LIFECYCLE_VERBS`, and a verb whose effect is wrong but whose report is
 * well formed. The effect of each verb has its own suites.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { PLUGIN_LIFECYCLE_VERBS, runPluginCommand } from "@veyyon/coding-agent/cli/plugin-cli";
import { PluginManager } from "@veyyon/coding-agent/extensibility/plugins/manager";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import * as piUtils from "@veyyon/utils";
import { removeWithRetries } from "@veyyon/utils";

const MARKETPLACE = "verbs-market";
const MARKET_PLUGIN = "market-plugin";
const LINKED_PLUGIN = "linked-plugin";

/** The name each install route registers its plugin under. */
const ROUTES = {
	marketplace: `${MARKET_PLUGIN}@${MARKETPLACE}`,
	linked: LINKED_PLUGIN,
} as const;

describe("a plugin lifecycle verb prints json on every install route", () => {
	let tmpRoot: string;
	let out: string[];

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-plugin-verbs-"));
		const configRoot = path.join(tmpRoot, "config");
		const pluginsDir = path.join(tmpRoot, "plugins");
		const marketSrc = path.join(tmpRoot, "marketplace-src");
		const linkedSrc = path.join(tmpRoot, "linked-src");

		const pluginSrc = path.join(marketSrc, "plugins", MARKET_PLUGIN);
		await fs.mkdir(path.join(pluginSrc, ".claude-plugin"), { recursive: true });
		await fs.mkdir(path.join(pluginsDir, "node_modules"), { recursive: true });
		await fs.mkdir(configRoot, { recursive: true });
		await fs.mkdir(linkedSrc, { recursive: true });
		await Bun.write(
			path.join(pluginSrc, "package.json"),
			JSON.stringify({ name: MARKET_PLUGIN, version: "1.0.0", veyyon: { extensions: [] } }),
		);
		await Bun.write(
			path.join(pluginSrc, ".claude-plugin", "plugin.json"),
			JSON.stringify({ name: MARKET_PLUGIN, version: "1.0.0" }),
		);
		await Bun.write(
			path.join(linkedSrc, "package.json"),
			JSON.stringify({ name: LINKED_PLUGIN, version: "1.0.0", veyyon: { version: "1.0.0" } }),
		);

		const catalog = JSON.stringify({
			name: MARKETPLACE,
			owner: { name: "Test Author", email: "test@example.com" },
			plugins: [{ name: MARKET_PLUGIN, source: `./plugins/${MARKET_PLUGIN}`, version: "1.0.0" }],
		});
		await Bun.write(path.join(marketSrc, ".claude-plugin", "marketplace.json"), catalog);
		const catalogPath = path.join(pluginsDir, "cache", "marketplaces", MARKETPLACE, "marketplace.json");
		await Bun.write(catalogPath, catalog);
		await Bun.write(
			path.join(configRoot, "marketplaces.json"),
			JSON.stringify({
				version: 1,
				marketplaces: [
					{
						name: MARKETPLACE,
						sourceType: "local",
						sourceUri: marketSrc,
						catalogPath,
						addedAt: "2026-01-01T00:00:00.000Z",
						updatedAt: "2026-01-01T00:00:00.000Z",
					},
				],
			}),
		);

		vi.spyOn(piUtils, "getConfigRootDir").mockReturnValue(configRoot);
		vi.spyOn(piUtils, "getPluginsDir").mockReturnValue(pluginsDir);
		vi.spyOn(piUtils, "getPluginsNodeModules").mockReturnValue(path.join(pluginsDir, "node_modules"));
		vi.spyOn(piUtils, "getPluginsPackageJson").mockReturnValue(path.join(pluginsDir, "package.json"));
		vi.spyOn(piUtils, "getPluginsLockfile").mockReturnValue(path.join(tmpRoot, "veyyon-plugins.lock.json"));
		vi.spyOn(piUtils, "getProjectDir").mockReturnValue(tmpRoot);
		vi.spyOn(piUtils, "getProjectPluginOverridesPath").mockReturnValue(path.join(tmpRoot, "plugin-overrides.json"));

		out = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			out.push(stripVTControlCharacters(args.join(" ")));
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		// A handler that fails exits the process; surface that as a thrown error naming the code.
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`process.exit(${code})`);
		}) as (code?: number) => never);

		await runPluginCommand({ action: "install", args: [ROUTES.marketplace], flags: {} });
		await new PluginManager(tmpRoot).link(linkedSrc);
		out = [];
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await removeWithRetries(tmpRoot);
	});

	for (const [action, verb] of Object.entries(PLUGIN_LIFECYCLE_VERBS)) {
		for (const [route, name] of Object.entries(ROUTES)) {
			test(`${action} --json prints one json record for a ${route} plugin`, async () => {
				await runPluginCommand({ action: verb.action, args: [name], flags: { json: true } });

				expect(out.map(line => JSON.parse(line))).toEqual([{ [verb.jsonKey]: name }]);
			});

			test(`${action} without --json prints the success line for a ${route} plugin`, async () => {
				await runPluginCommand({ action: verb.action, args: [name], flags: {} });

				expect(out).toHaveLength(1);
				expect(out[0]).toEndWith(`${verb.done} ${name}`);
			});
		}
	}
});
