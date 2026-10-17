/**
 * Construct every registered tool, the hidden ones included, for a suite that sweeps them.
 *
 * A tool the sweep cannot construct is a hole, not a pass, so the session turns on every feature
 * that gates a factory: `ask` needs a UI, `debug`, the four memory tools, `learn`, `manage_skill`
 * and the two Argot tools read settings, `irc` needs a registry and an agent id,
 * `search_tool_bm25` needs the three discovery callbacks, `ssh` resolves its hosts from `ssh.json`
 * and `debug` its adapters from `dap.json`, both in the profile directory the caller supplies.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool } from "@veyyon/agent-core";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { BUILTIN_TOOLS, HIDDEN_TOOLS } from "@veyyon/coding-agent/tools/index";
import { ArgotSession } from "argot";
import { makeToolSession } from "./tool-session";

/**
 * Settings the sweep session answers, so a tool gated behind a feature flag is swept rather than
 * skipped. Everything else falls to its own default.
 */
const SWEEP_SETTINGS: Record<string, unknown> = {
	"argot.enabled": true,
	"autolearn.enabled": true,
	"debug.enabled": true,
	"memory.backend": "mnemopi",
	// Off by default: starting servers is expensive. The sweep still has to construct `lsp`, so it
	// turns the gate on rather than dropping the tool.
	"lsp.enabled": true,
	"lsp.tool": true,
	// "auto" resolves to "off" below the tool-count threshold, which would drop `search_tool_bm25`
	// out of the sweep.
	"tools.discoveryMode": "all",
};

export interface EveryToolSweep {
	/** Every tool a factory returned, in factory order. */
	tools: AgentTool[];
	/** Factory names that threw. */
	unconstructable: string[];
	/** Factory names that returned null for this session. */
	notRegistered: string[];
}

/** Construct every tool in `BUILTIN_TOOLS` and `HIDDEN_TOOLS` against a session rooted at `profileDir`. */
export async function constructEveryTool(profileDir: string): Promise<EveryToolSweep> {
	// One host is all `loadSshTool` needs to register the tool; without it the factory returns null
	// and `ssh` drops out of the sweep.
	await fs.writeFile(path.join(profileDir, "ssh.json"), JSON.stringify({ hosts: { probe: { host: "127.0.0.1" } } }));
	// `debug` is gated the same way on a resolvable adapter command, so a host with no debugger
	// installed would drop it out of the sweep. This binary is the adapter.
	await fs.writeFile(
		path.join(profileDir, "dap.json"),
		JSON.stringify({ adapters: { probe: { command: process.execPath, languages: ["javascript"] } } }),
	);
	const argotSession = new ArgotSession();
	const session = makeToolSession({
		// `dap.json` sits here, and `getAdapterConfigs` reads it from the session cwd.
		cwd: profileDir,
		hasUI: true,
		agentRegistry: new AgentRegistry(),
		getAgentId: () => "Main",
		getArgotSession: () => argotSession,
		isToolDiscoveryEnabled: () => true,
		getSelectedDiscoveredToolNames: () => [],
		activateDiscoveredTools: async () => [],
		settings: {
			get: (key: string) => SWEEP_SETTINGS[key],
			getAgentDir: () => profileDir,
		},
	});
	const sweep: EveryToolSweep = { tools: [], unconstructable: [], notRegistered: [] };
	for (const [name, factory] of Object.entries({ ...BUILTIN_TOOLS, ...HIDDEN_TOOLS })) {
		let tool: AgentTool | null;
		try {
			tool = await factory(session);
		} catch {
			sweep.unconstructable.push(name);
			continue;
		}
		if (tool) sweep.tools.push(tool);
		else sweep.notRegistered.push(name);
	}
	return sweep;
}
