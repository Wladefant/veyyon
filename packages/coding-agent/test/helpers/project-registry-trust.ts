/**
 * Test helper: a project plugin registry that names `installPaths`, approved under the operator's trust record.
 *
 * Project scope loads only the `installPath` entries of a trusted registry. Approval goes through the production trust command.
 */
import * as path from "node:path";
import { runTrustCommand } from "@veyyon/coding-agent/cli/trust-cli";
import {
	addInstalledPlugin,
	buildPluginId,
	type InstalledPluginEntry,
	readInstalledPluginsRegistry,
	writeInstalledPluginsRegistry,
} from "@veyyon/coding-agent/extensibility/plugins/marketplace";

export interface TrustProjectRegistryOptions {
	/** The project working directory whose registry owner is trusted. */
	cwd: string;
	/** The profile agent directory that holds the trust record. */
	agentDir: string;
	/** The project's `.veyyon/plugins` directory, where the registry is written. */
	pluginsRoot: string;
	/** Absolute plugin directories the registry names. Each is registered as a project entry. */
	installPaths: string[];
}

/** Write the registry, then approve it through the production trust command. */
export async function trustProjectRegistry(opts: TrustProjectRegistryOptions): Promise<string> {
	const registryPath = path.join(opts.pluginsRoot, "installed_plugins.json");
	const when = "2025-01-01T00:00:00.000Z";
	let registry = await readInstalledPluginsRegistry(registryPath);
	for (const installPath of opts.installPaths) {
		const entry: InstalledPluginEntry = {
			scope: "project",
			installPath,
			version: "1.0.0",
			installedAt: when,
			lastUpdated: when,
		};
		registry = addInstalledPlugin(registry, buildPluginId(path.basename(installPath), "test-mkt"), entry);
	}
	await writeInstalledPluginsRegistry(registryPath, registry);
	await runTrustCommand({ cwd: opts.cwd, agentDir: opts.agentDir, action: "approve", paths: [registryPath] });
	return registryPath;
}
