/**
 * An `/ssh add` or `/ssh remove` line means the same thing typed at the terminal
 * as it does sent over ACP, print mode or RPC.
 *
 * THE DEFECT THIS CLOSES. The terminal controller and the text handler each had
 * their own reader of `/ssh add` and `/ssh remove`, and the two drifted: the
 * terminal accepted `desc` and `compat` while text mode answered `Unknown
 * argument: desc`; text mode refused a plain `host` or `port` naming the word
 * that replaced it while the terminal answered `Unknown argument`; `/ssh remove
 * box scope` got the reason on one surface and a bare refusal on the other; an
 * empty `/ssh add` got bare usage in text mode and `Host name required.` at the
 * terminal.
 *
 * THE CLASS: any line the two surfaces read differently. Every line below goes
 * through both readers, and the outcome — the hosts written or removed, or the
 * refusal shown — must be identical. The lines cover each optional value alone,
 * all of them together and out of order, every removed-option key in its plain
 * and dashed spelling read from the live maps, and the malformed shapes: no name,
 * no address, a port out of range or with trailing text, a value given twice, a
 * keyword with no value. The accepted lines are also pinned to the exact host
 * they write, so the grammar cannot regress on both surfaces at once and still
 * pass as "they agree".
 *
 * WHAT THIS DOES NOT CATCH. A refusal that both surfaces word the same way and
 * that names the wrong replacement passes here; the sentences are pinned by
 * `a-plain-word-that-was-an-option-is-refused-like-the-option.test.ts`. The
 * success messages are not compared: the terminal draws a themed block and text
 * mode prints one line, which is a difference in display, not in reading.
 */
import { beforeAll, describe, expect, test, vi } from "bun:test";
import { SSHCommandController } from "@veyyon/coding-agent/modes/terminal/controllers/ssh-command-controller";
import { parseSlashCommand } from "@veyyon/coding-agent/slash-commands/helpers/parse";
import { handleSshAcp } from "@veyyon/coding-agent/slash-commands/helpers/ssh";
import {
	SSH_ADD_REMOVED_OPTIONS,
	SSH_REMOVE_REMOVED_OPTIONS,
} from "@veyyon/coding-agent/slash-commands/helpers/ssh-args";
import type { SlashCommandRuntime } from "@veyyon/coding-agent/slash-commands/types";
import type { SSHHostConfig } from "@veyyon/coding-agent/ssh/config-writer";
import * as sshConfigWriter from "@veyyon/coding-agent/ssh/config-writer";
import { initTheme } from "@veyyon/coding-agent/theme/theme";

type Change = { added: string; config: SSHHostConfig } | { removed: string };

/** What a line did: the config changes it made, or the refusal it showed instead. */
interface Outcome {
	changes: Change[];
	refusal: string | null;
}

/**
 * Run `send` with the config writers recording instead of writing, and the
 * profile holding one host, `box`, so a remove line reaches the writer on both
 * surfaces: the terminal looks the host up before removing it.
 */
async function recordingChanges(send: () => Promise<void>): Promise<Change[]> {
	const changes: Change[] = [];
	const add = vi.spyOn(sshConfigWriter, "addSSHHost").mockImplementation(async (_path, name, config) => {
		changes.push({ added: name, config });
	});
	const remove = vi.spyOn(sshConfigWriter, "removeSSHHost").mockImplementation(async (_path, name) => {
		changes.push({ removed: name });
	});
	const read = vi
		.spyOn(sshConfigWriter, "readSSHConfigFile")
		.mockImplementation(async () => ({ hosts: { box: { host: "example.com" } } }));
	try {
		await send();
		return changes;
	} finally {
		add.mockRestore();
		remove.mockRestore();
		read.mockRestore();
	}
}

/** The text surface: the handler ACP, print mode and RPC dispatch to. */
async function throughText(line: string): Promise<Outcome> {
	const output: string[] = [];
	const runtime = {
		cwd: "/nonexistent-veyyon-test-cwd",
		output: (text: string) => {
			output.push(text);
		},
		session: { refreshSshTool: async () => {} },
	} as unknown as SlashCommandRuntime;
	const command = parseSlashCommand(line);
	if (!command) throw new Error(`${line} must parse as a slash command`);
	const changes = await recordingChanges(async () => {
		await handleSshAcp(command, runtime);
	});
	// Text mode prints a success and a refusal through the same channel; a line
	// that changed nothing printed a refusal.
	return { changes, refusal: changes.length === 0 ? output.join("\n") : null };
}

/** The terminal surface: the real controller, handed the tail the slash dispatcher hands it. */
async function throughTerminal(line: string): Promise<Outcome> {
	const errors: string[] = [];
	const controller = new SSHCommandController({
		present: () => {},
		showError: (message: string) => {
			errors.push(message);
		},
		session: { refreshSshTool: async () => {} },
	} as never);
	const changes = await recordingChanges(() => controller.handle(parseSlashCommand(line)?.args ?? ""));
	return { changes, refusal: errors.length > 0 ? errors.join("\n") : null };
}

/** Lines the grammar accepts, with the one change each must make. */
const ACCEPTED: readonly [line: string, change: Change][] = [
	["/ssh add box example.com", { added: "box", config: { host: "example.com" } }],
	["/ssh add box example.com user root", { added: "box", config: { host: "example.com", username: "root" } }],
	["/ssh add box example.com 2222", { added: "box", config: { host: "example.com", port: 2222 } }],
	[
		"/ssh add box example.com key ~/.ssh/id_ed25519",
		{ added: "box", config: { host: "example.com", keyPath: "~/.ssh/id_ed25519" } },
	],
	["/ssh add box example.com desc Laptop", { added: "box", config: { host: "example.com", description: "Laptop" } }],
	["/ssh add box example.com compat", { added: "box", config: { host: "example.com", compat: true } }],
	[
		'/ssh add box example.com user root 2222 key ~/.ssh/id_ed25519 desc "Work laptop" compat',
		{
			added: "box",
			config: {
				host: "example.com",
				username: "root",
				port: 2222,
				keyPath: "~/.ssh/id_ed25519",
				description: "Work laptop",
				compat: true,
			},
		},
	],
	[
		"/ssh add box example.com compat desc Laptop 2222 user root",
		{
			added: "box",
			config: { host: "example.com", username: "root", port: 2222, description: "Laptop", compat: true },
		},
	],
	// Position, not spelling: a host called `user` at host `user`, whose user is `2222`.
	["/ssh add user user user 2222", { added: "user", config: { host: "user", username: "2222" } }],
	["/ssh remove box", { removed: "box" }],
	["/ssh rm box", { removed: "box" }],
];

/** Lines the grammar refuses, by shape. */
const MALFORMED: readonly string[] = [
	"/ssh add",
	"/ssh add box",
	"/ssh add box example.com 0",
	"/ssh add box example.com 70000",
	"/ssh add box example.com 22oops",
	"/ssh add box example.com 22 23",
	"/ssh add box example.com user",
	"/ssh add box example.com user a user b",
	"/ssh add box example.com desc",
	"/ssh add box example.com compat compat",
	"/ssh add box example.com zzz-not-an-option",
	"/ssh add -box example.com",
	"/ssh remove",
	"/ssh remove box extra",
	"/ssh remove --box",
];

/** Every removed-option key, plain and dashed, in each slot it could be typed in. Read from the live maps. */
const REMOVED_SPELLINGS: readonly string[] = [
	...Object.keys(SSH_ADD_REMOVED_OPTIONS).flatMap(key => [
		`/ssh add box example.com ${key}`,
		`/ssh add box example.com ${key} value`,
		`/ssh add box example.com --${key} value`,
		`/ssh add box example.com --${key}=value`,
		`/ssh add box --${key} example.com`,
		`/ssh add --${key} box example.com`,
	]),
	...Object.keys(SSH_REMOVE_REMOVED_OPTIONS).flatMap(key => [
		`/ssh remove box ${key}`,
		`/ssh remove box ${key} user`,
		`/ssh remove box --${key} user`,
		`/ssh remove --${key} box`,
	]),
];

describe("an /ssh host line means the same at the terminal and over ACP", () => {
	beforeAll(() => {
		initTheme();
	});

	describe("an accepted line makes the same change on both surfaces", () => {
		test.each(ACCEPTED)("%s", async (line, change) => {
			expect(await throughText(line)).toEqual({ changes: [change], refusal: null });
			expect(await throughTerminal(line)).toEqual({ changes: [change], refusal: null });
		});
	});

	describe("every line has one outcome, whichever surface reads it", () => {
		test.each([...ACCEPTED.map(([line]) => line), ...MALFORMED, ...REMOVED_SPELLINGS])("%s", async line => {
			expect(await throughTerminal(line)).toEqual(await throughText(line));
		});
	});

	// The malformed lines are refusals on both surfaces, not two identical writes:
	// agreement alone would pass if a malformed line were accepted everywhere.
	test.each(MALFORMED)("%s changes nothing", async line => {
		const outcome = await throughText(line);
		expect(outcome.changes).toEqual([]);
		expect(outcome.refusal).toContain("Usage: /ssh");
	});
});
