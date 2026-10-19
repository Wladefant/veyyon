/**
 * WHY: a discovered custom tool (`.veyyon/tools/`, `.claude/tools/`, a plugin) is built by a
 * factory that receives a `CustomToolAPI`, and the documented way for that tool to prompt or notify
 * is the factory-scoped `api.ui`, guarded by `api.hasUI`. The loader starts both as a no-op UI and
 * `false`, and exposes `setUIContext` for the host to install the real one; no host ever called it,
 * so every custom tool in every mode saw `hasUI === false` and a UI that dropped every call. The
 * session now installs the host's UI on the custom tools whenever the host installs it for tools.
 *
 * Not caught here: what each host's UI does with a call, which the hosts' own suites own.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ExtensionUIContext } from "@veyyon/coding-agent/extensibility/extensions/types";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { getProjectDir, setProjectDir, TempDir } from "@veyyon/utils";
import { useIsolatedConfigRoot } from "./helpers/isolated-agent-dir";

useIsolatedConfigRoot();

const TOOL_SOURCE = [
	"export default function (api) {",
	"  return {",
	"    name: 'ui_probe',",
	"    description: 'reports whether its factory API reaches a host UI',",
	"    parameters: api.typebox.Type.Object({}),",
	"    async execute() {",
	"      if (api.hasUI) api.ui.notify('probe reached the host', 'info');",
	"      return { content: [{ type: 'text', text: String(api.hasUI) }] };",
	"    },",
	"  };",
	"}",
].join("\n");

interface Fixture {
	root: TempDir;
	authStorage: AuthStorage;
	session: AgentSession;
	setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
	originalProjectDir: string;
}

let fixture: Fixture | undefined;

afterEach(async () => {
	if (!fixture) return;
	await fixture.session.dispose();
	fixture.authStorage.close();
	setProjectDir(fixture.originalProjectDir);
	await fixture.root.remove();
	fixture = undefined;
});

async function sessionWithProbeTool(): Promise<Fixture> {
	const originalProjectDir = getProjectDir();
	const root = TempDir.createSync("custom-tool-host-ui-");
	const cwd = path.resolve(root.join("project"));
	await fs.mkdir(cwd, { recursive: true });
	const toolPath = root.join("ui-probe.ts");
	await fs.writeFile(toolPath, TOOL_SOURCE);
	const authStorage = await AuthStorage.create(root.join("auth.db"));
	const { session, setToolUIContext } = await createAgentSession({
		cwd,
		agentDir: path.resolve(root.join("agent")),
		sessionManager: SessionManager.inMemory(cwd),
		settings: Settings.isolated(),
		modelRegistry: new ModelRegistry(authStorage, root.join("models.yml")),
		preloadedCustomToolPaths: [{ path: toolPath }],
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
	});
	return { root, authStorage, session, setToolUIContext, originalProjectDir };
}

async function runProbe(session: AgentSession): Promise<string> {
	const tool = session.getToolByName("ui_probe");
	if (!tool) throw new Error("the discovered probe tool is not registered");
	const result = await tool.execute("call-1", {});
	const [first] = result.content;
	return first?.type === "text" ? first.text : "";
}

describe("a discovered custom tool and its host's UI", () => {
	it("prompts through the UI the host installs for tools", async () => {
		fixture = await sessionWithProbeTool();
		const notices: string[] = [];
		const ui = { notify: (message: string) => notices.push(message) } as unknown as ExtensionUIContext;

		fixture.setToolUIContext(ui, true);

		expect(await runProbe(fixture.session)).toBe("true");
		expect(notices).toEqual(["probe reached the host"]);
	});

	it("reports no UI until a host installs one", async () => {
		fixture = await sessionWithProbeTool();

		expect(await runProbe(fixture.session)).toBe("false");
	});
});
