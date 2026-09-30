/**
 * Creates one agent session in a fresh process and prints, as JSON: whether the package barrel
 * (`src/index.ts`) was evaluated, the Zod modules evaluated once the session exists and again once
 * every active tool's parameters are converted to the wire schema a request sends, the active tool
 * names, the slash commands the session's extensions registered, and the types of
 * `api.pi.createAgentSession` and `api.zod.object` as an author's inline extension received them.
 * Then it calls every built-in and hidden tool factory with every tool-enabling setting on, converts
 * each tool it gets to the wire schema, and prints the Zod modules evaluated after that and the
 * factories that returned no tool.
 * argv[2] is the scratch directory; argv[3] is `author` to pass one author inline extension.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { toolWireSchema } from "@veyyon/ai/utils/schema";
import { getBundledModel } from "@veyyon/catalog/models";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { postmortem } from "@veyyon/utils";
import { type SettingPath, Settings } from "../../src/config/settings";
import type { ExtensionFactory } from "../../src/extensibility/extensions";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { createAgentSession } from "../../src/sdk";
import { BUILTIN_TOOLS, HIDDEN_TOOLS, type ToolSession } from "../../src/tools";

const PACKAGE_BARREL = path.join("packages", "coding-agent", "src", "index.ts");
const ZOD_MODULE = `${path.sep}node_modules${path.sep}zod${path.sep}`;

function zodModules(): string[] {
	return Object.keys(require.cache).filter(file => path.normalize(file).includes(ZOD_MODULE));
}

/** Every setting a built-in factory reads before it returns a tool, turned on. */
const EVERY_TOOL_ENABLED: Partial<Record<SettingPath, unknown>> = {
	"astEdit.enabled": true,
	"debug.enabled": true,
	"github.enabled": true,
	"lsp.enabled": true,
	"inspect_image.enabled": true,
	"web_search.enabled": true,
	"browser.enabled": true,
	"checkpoint.enabled": true,
	"todo.enabled": true,
	"goal.enabled": true,
	"memory.backend": "mnemopi",
	"autolearn.enabled": true,
	"argot.enabled": true,
	"tools.discoveryMode": "all",
};

/**
 * Calls every built-in and hidden factory and converts each tool it returns; returns the names that
 * returned none. `dir` is the sweep's profile and working directory: `ssh` registers only with a host
 * in the profile's `ssh.json`, and `debug` only with an adapter in the working directory's `dap.json`.
 */
async function convertEveryFirstPartyTool(dir: string): Promise<string[]> {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "ssh.json"), JSON.stringify({ hosts: { probe: { host: "127.0.0.1" } } }));
	fs.writeFileSync(
		path.join(dir, "dap.json"),
		JSON.stringify({ adapters: { probe: { command: process.execPath, languages: ["javascript"] } } }),
	);
	const toolSession: ToolSession = {
		cwd: dir,
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: await Settings.loadIsolated({ cwd: dir, agentDir: dir, inMemory: true, overrides: EVERY_TOOL_ENABLED }),
		isToolDiscoveryEnabled: () => true,
		getSelectedDiscoveredToolNames: () => [],
		activateDiscoveredTools: async names => names,
		getArgotSession: () => ({ loaded: false }) as never,
		agentRegistry: new AgentRegistry(),
		getAgentId: () => "Main",
	};
	const unbuilt: string[] = [];
	for (const [name, factory] of Object.entries({ ...BUILTIN_TOOLS, ...HIDDEN_TOOLS })) {
		const tool = await factory(toolSession);
		if (tool) toolWireSchema(tool);
		else unbuilt.push(name);
	}
	return unbuilt.sort();
}

try {
	const scratch = process.argv[2];
	if (!scratch) throw new Error("usage: session-package-barrel.ts <scratch-dir> [author]");
	const cwd = path.join(scratch, "project");
	fs.mkdirSync(cwd, { recursive: true });
	let authorPi: string | null = null;
	let authorZod: string | null = null;
	const author: ExtensionFactory = api => {
		authorPi = typeof api.pi.createAgentSession;
		authorZod = typeof api.zod.object;
	};
	const { session } = await createAgentSession({
		cwd,
		agentDir: path.join(scratch, "agent"),
		sessionManager: SessionManager.inMemory(cwd),
		settings: Settings.isolated(),
		model: getBundledModel<"anthropic-messages">("anthropic", "claude-sonnet-4-5"),
		extensions: process.argv[3] === "author" ? [author] : undefined,
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
	});
	const barrelLoaded = Object.keys(require.cache).some(file => path.normalize(file).endsWith(PACKAGE_BARREL));
	const zodAtCreate = zodModules();
	const tools = session.getActiveToolNames().sort();
	for (const name of tools) {
		const tool = session.getToolByName(name);
		if (!tool) throw new Error(`active tool ${name} has no definition`);
		toolWireSchema(tool);
	}
	const zodAtWire = zodModules();
	const commands = (session.extensionRunner?.getRegisteredCommands() ?? []).map(command => command.name).sort();
	const unbuiltFactories = await convertEveryFirstPartyTool(path.join(scratch, "sweep"));
	const zodAtEveryTool = zodModules();
	process.stdout.write(
		`${JSON.stringify({ barrelLoaded, zodAtCreate, zodAtWire, zodAtEveryTool, unbuiltFactories, tools, commands, authorPi, authorZod })}\n`,
	);
	await session.dispose();
} finally {
	await postmortem.cleanup();
}
