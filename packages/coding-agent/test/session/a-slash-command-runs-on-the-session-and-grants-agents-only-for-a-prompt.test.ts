/**
 * WHY: the session resolves a typed `/name` to an extension or custom command, runs it with a
 * command context, and grants the agents a command declares for the turn its prompt starts. These
 * moved out of `agent-session.ts` into `agent-session-commands.ts`, and three of their branches had
 * no test at all: a command's declared agents granted only when it produced a prompt, a throwing
 * custom command reported and counted as handled, and an extension command refused when queued.
 * The class closed: a dispatch branch that changes what runs, what is granted or how a failure
 * surfaces while every suite stays green. The real session is the host throughout; only the
 * extension runner, a dependency the session is handed, is a stand-in.
 *
 * Not caught here: the extension runner's own command context, which its suites own, and the turn
 * that consumes a grant, which `task/disabled-agent-means-disabled.test.ts` covers.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { CustomCommand, LoadedCustomCommand } from "@veyyon/coding-agent/extensibility/custom-commands";
import type {
	ExtensionCommandContext,
	ExtensionError,
	ExtensionRunner,
	RegisteredCommand,
} from "@veyyon/coding-agent/extensibility/extensions";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import {
	type SessionCommandHost,
	throwIfExtensionCommand,
	tryExecuteCustomCommand,
	tryExecuteExtensionCommand,
} from "@veyyon/coding-agent/session/agent-session-commands";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { logger } from "@veyyon/utils";

const model = { provider: "test", id: "command-model", api: "openai-completions" } as Model;

let session: AgentSession | undefined;
afterEach(async () => {
	vi.restoreAllMocks();
	await session?.dispose();
	session = undefined;
});

function makeSession(): AgentSession {
	session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({}),
		modelRegistry: {} as ModelRegistry,
	});
	return session;
}

function loaded(command: CustomCommand): LoadedCustomCommand {
	return { path: `${command.name}.ts`, resolvedPath: `/repo/${command.name}.ts`, source: "project", command };
}

/** An extension runner holding `commands`, recording every error it is asked to emit. */
function runnerWith(commands: RegisteredCommand[]): { runner: ExtensionRunner; errors: ExtensionError[] } {
	const errors: ExtensionError[] = [];
	const byName = new Map(commands.map(command => [command.name, command]));
	const runner = {
		getCommand: (name: string) => byName.get(name),
		createCommandContext: () => ({}) as ExtensionCommandContext,
		emitError: (error: ExtensionError) => errors.push(error),
	} as unknown as ExtensionRunner;
	return { runner, errors };
}

describe("a custom command run on the session", () => {
	it("returns the prompt it produced and grants each agent it declares", async () => {
		const host = makeSession();
		const granted: string[] = [];
		const prompt = await tryExecuteCustomCommand(
			host,
			[loaded({ name: "audit", description: "", spawnsAgents: ["reviewer", "scout"], execute: () => "Audit it" })],
			"/audit",
			agent => granted.push(agent),
		);
		expect(prompt).toBe("Audit it");
		expect(granted).toEqual(["reviewer", "scout"]);
	});

	it.each([
		["returns nothing", () => undefined],
		["returns an empty prompt", () => ""],
	])("grants nothing and counts as handled when it %s", async (_label, execute) => {
		const host = makeSession();
		const granted: string[] = [];
		const prompt = await tryExecuteCustomCommand(
			host,
			[loaded({ name: "quiet", description: "", spawnsAgents: ["reviewer"], execute })],
			"/quiet",
			agent => granted.push(agent),
		);
		expect(prompt).toBe("");
		expect(granted).toEqual([]);
	});

	it("receives its parsed arguments when typed in the `/<plugin> <name>` form", async () => {
		const host = makeSession();
		let received: string[] | undefined;
		const prompt = await tryExecuteCustomCommand(
			host,
			[
				loaded({
					name: "plug:run",
					description: "",
					execute: args => {
						received = args;
						return "ran";
					},
				}),
			],
			'/plug run first "second arg"',
			() => {},
		);
		expect(prompt).toBe("ran");
		expect(received).toEqual(["first", "second arg"]);
	});

	it("answers null for text no command registered, and runs nothing", async () => {
		const host = makeSession();
		let ran = false;
		const prompt = await tryExecuteCustomCommand(
			host,
			[
				loaded({
					name: "known",
					description: "",
					execute: () => {
						ran = true;
					},
				}),
			],
			"/unknown",
			() => {},
		);
		expect(prompt).toBeNull();
		expect(ran).toBe(false);
	});

	it("is emitted as a `custom-command:<name>` error through the extension runner when it throws", async () => {
		const { runner, errors } = runnerWith([]);
		const host = { extensionRunner: runner, obfuscateProviderText: (text: string) => text } as SessionCommandHost;
		const prompt = await tryExecuteCustomCommand(
			host,
			[
				loaded({
					name: "boom",
					description: "",
					execute: () => {
						throw new Error("disk full");
					},
				}),
			],
			"/boom",
			() => {},
		);
		expect(prompt).toBe("");
		expect(errors).toEqual([{ extensionPath: "custom-command:boom", event: "command", error: "disk full" }]);
	});

	it("is logged with its name and counts as handled when it throws on a session without a runner", async () => {
		const host = makeSession();
		const logged: Array<{ message: string; context: unknown }> = [];
		vi.spyOn(logger, "error").mockImplementation((message: string, context?: unknown) => {
			logged.push({ message, context });
		});
		const granted: string[] = [];
		const prompt = await tryExecuteCustomCommand(
			host,
			[
				loaded({
					name: "boom",
					description: "",
					spawnsAgents: ["reviewer"],
					execute: () => {
						throw new Error("disk full");
					},
				}),
			],
			"/boom",
			agent => granted.push(agent),
		);
		expect(prompt).toBe("");
		expect(granted).toEqual([]);
		expect(logged).toEqual([
			{ message: "Custom command failed", context: { commandName: "boom", error: "disk full" } },
		]);
	});
});

describe("an extension command", () => {
	it("runs its handler with the argument text and reports handled", async () => {
		const calls: string[] = [];
		const { runner, errors } = runnerWith([{ name: "deploy", handler: async args => void calls.push(args) }]);
		expect(await tryExecuteExtensionCommand(runner, "/deploy prod now")).toBe(true);
		expect(calls).toEqual(["prod now"]);
		expect(errors).toEqual([]);
	});

	it("is emitted as a `command:<name>` error and still counts as handled when its handler throws", async () => {
		const { runner, errors } = runnerWith([
			{
				name: "deploy",
				handler: async () => {
					throw new Error("no credentials");
				},
			},
		]);
		expect(await tryExecuteExtensionCommand(runner, "/deploy")).toBe(true);
		expect(errors).toEqual([{ extensionPath: "command:deploy", event: "command", error: "no credentials" }]);
	});

	it("is not run, and is reported unhandled, for a name no extension registered or with no runner", async () => {
		const { runner } = runnerWith([{ name: "deploy", handler: async () => {} }]);
		expect(await tryExecuteExtensionCommand(runner, "/other")).toBe(false);
		expect(await tryExecuteExtensionCommand(undefined, "/deploy")).toBe(false);
	});

	it("cannot be queued, and the refusal names it; other text queues", () => {
		const { runner } = runnerWith([{ name: "deploy", handler: async () => {} }]);
		expect(() => throwIfExtensionCommand(runner, "/deploy prod")).toThrow(
			'Extension command "/deploy" cannot be queued. Use prompt() or execute the command when not streaming.',
		);
		expect(() => throwIfExtensionCommand(runner, "/other")).not.toThrow();
		expect(() => throwIfExtensionCommand(undefined, "/deploy")).not.toThrow();
	});
});
