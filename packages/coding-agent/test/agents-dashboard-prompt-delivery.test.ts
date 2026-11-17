import "./helpers/tool-views-preload";
import { afterAll, beforeAll, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { submitInteractiveInput } from "@veyyon/coding-agent/main";
import { InteractiveMode } from "@veyyon/coding-agent/modes/terminal/interactive-mode";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { initTheme, setTheme, stopThemeWatcher } from "@veyyon/coding-agent/theme/theme";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TUI } from "@veyyon/tui";
import { TempDir } from "@veyyon/utils";
import { VirtualTerminal } from "../../../hosts/terminal/engine/test/virtual-terminal";

beforeAll(async () => {
	await initTheme();
	await setTheme("dark");
});

afterAll(() => stopThemeWatcher());

it("delivers queued prompts across /agents and restores composer input on Escape", async () => {
	using temp = TempDir.createSync("@pi-agents-prompt-delivery-");
	const cwd = temp.path();
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd, overrides: { "startup.quiet": true } });
	const firstCall = Promise.withResolvers<void>();
	const releaseFirstCall = Promise.withResolvers<void>();
	const model = createMockModel({
		responses: [
			async () => {
				firstCall.resolve();
				await releaseFirstCall.promise;
				return { content: ["First reply"] };
			},
		],
		handler: { content: ["Reply"] },
	});
	const auth = await AuthStorage.create(path.join(cwd, "auth.db"));
	auth.setRuntimeApiKey(model.provider, "test-key");
	const session = new AgentSession({
		agent: new Agent({
			streamFn: model.stream,
			initialState: { model, systemPrompt: ["Main"], tools: [], messages: [] },
		}),
		sessionManager: SessionManager.create(cwd, cwd),
		settings: Settings.isolated({ "startup.quiet": true }),
		modelRegistry: new ModelRegistry(auth),
	});
	const mode = new InteractiveMode(session, "test");
	const term = new VirtualTerminal(120, 40);
	mode.ui = new TUI(term);
	const watchGit = vi.spyOn(mode.statusLine, "watchGitState").mockImplementation(() => {});
	let firstTurn: Promise<void> | undefined;
	try {
		await mode.init();
		await term.waitForRender(mode.ui);
		firstTurn = session.prompt("Start the scripted turn");
		await firstCall.promise;
		await session.followUp("Queued before the dashboard opened");

		mode.editor.setText("/agents");
		term.sendInput("\r");
		await term.waitForRender(mode.ui);
		expect(term.getViewport().join("\n")).toContain("Agent Dashboard");

		// A submission that already reached the composer must not depend on who has keyboard focus.
		await mode.editor.onSubmit?.("Submitted while the dashboard was open");
		releaseFirstCall.resolve();
		await firstTurn;
		await session.waitForIdle();
		await term.waitForRender(mode.ui);
		expect(term.getViewport().join("\n")).toContain("Agent Dashboard");

		term.sendInput("\x1b");
		await term.waitForRender(mode.ui);
		expect(term.getViewport().join("\n")).not.toContain("Agent Dashboard");
		const nextTurn = mode.getUserInput().then(input => submitInteractiveInput(mode, session, input));
		term.sendInput("\x1b[200~Typed into the composer after Escape\x1b[201~");
		term.sendInput("\r");
		await nextTurn;

		const prompts = model.calls
			.at(-1)
			?.context.messages.filter(message => message.role === "user")
			.map(message =>
				typeof message.content === "string"
					? message.content
					: message.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join(""),
			);
		expect(prompts).toEqual([
			"Start the scripted turn",
			"Submitted while the dashboard was open",
			"Queued before the dashboard opened",
			"Typed into the composer after Escape",
		]);
	} finally {
		releaseFirstCall.resolve();
		await firstTurn?.catch(() => undefined);
		mode.stop();
		watchGit.mockRestore();
		await session.dispose();
		auth.close();
		resetSettingsForTest();
	}
});
