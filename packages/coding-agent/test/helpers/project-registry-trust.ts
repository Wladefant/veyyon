/**
 * Test helper: a project plugin registry that names `installPaths`, approved under the operator's trust record.
 *
 * Project scope loads only the `installPath` entries of a trusted registry, so a fixture that wants a project plugin
 * loaded must write the registry and record its exact bytes as approved. This mirrors what `veyyon trust` records.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describeProjectExecutable, ProjectTrust } from "@veyyon/coding-agent/config/project-trust";
import { projectTrustKey } from "@veyyon/coding-agent/discovery/helpers";
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

/** Write `<pluginsRoot>/installed_plugins.json` naming `installPaths`, then trust its exact bytes. Returns its path. */
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

	const trustRoot = await projectTrustKey(opts.cwd);
	const executable = await describeProjectExecutable(registryPath, trustRoot);
	if (!executable) throw new Error(`project registry is not readable: ${registryPath}`);
	await fs.mkdir(opts.agentDir, { recursive: true });
	const trust = await ProjectTrust.load(opts.agentDir);
	await trust.trust(trustRoot, [executable]);
	return registryPath;
}
