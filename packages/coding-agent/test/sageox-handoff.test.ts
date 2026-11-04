import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { ExtensionAPI, ExtensionCommandContext } from "@veyyon/coding-agent";
import * as zod from "zod/v4";
import sageox from "../examples/extensions/sageox";

const TEAM = "team_fixture";
const REPO = "repo_fixture";
const session = "branch-owner";
const leaf = "leaf-1";

function fixture(wsl = false) {
	const windows = wsl ? { distro: "Ubuntu-24.04", systemRoot: "C:\\Windows", binary: "/opt/ox/ox" } : undefined;
	const cwd = wsl ? "C:\\team repo" : "/repo";
	const calls: string[][] = [];
	const hooks = new Map<string, (e: object, c: typeof ctx) => { message: { content: string } } | undefined>();
	const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
	const tools = new Map<string, (params: object) => Promise<{ content: { text: string }[] }>>();
	const state = {
		team: TEAM,
		email: "operator@example.invalid",
		id: session,
		leaf,
		consent: true,
		draft: "",
		imported: "",
		path: "",
		fail: false,
		note: "Issue #42",
		accepted: "edited visible text",
		receipt: "",
	};
	const ctx = {
		cwd,
		hasUI: true,
		sessionManager: {
			getSessionId: () => state.id,
			getLeafId: () => state.leaf,
			getBranch: () => [
				{ type: "message", message: { role: "user", content: "visible question" } },
				{ type: "message", message: { role: "user", synthetic: true, content: "internal prompt" } },
				{ type: "message", message: { role: "toolResult", content: "tool output" } },
				{
					type: "message",
					message: {
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "private thought" },
							{ type: "text", text: "visible answer" },
							{ type: "toolCall", arguments: { secret: "tool secret" } },
						],
					},
				},
			],
		},
		ui: {
			editor: async (_: string, draft: string) => {
				state.draft = draft;
				return state.accepted;
			},
			confirm: async () => state.consent,
			notify: (text: string) => {
				state.receipt = text;
			},
		},
		obfuscateProviderText: (s: string) => s,
	};
	const api = {
		zod,
		on(name: string, handler: (e: object, c: typeof ctx) => { message: { content: string } } | undefined) {
			hooks.set(name, handler);
		},
		registerCommand(
			name: string,
			command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
		) {
			commands.set(name, command.handler);
		},
		registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }) {
			tools.set(tool.name, p => tool.execute("id", p, undefined, undefined, ctx));
		},
		async exec(cmd: string, args: string[], options: { cwd: string }) {
			expect(options.cwd).toBe(cwd);
			if (windows) {
				expect(cmd).toBe("C:\\Windows\\System32\\wsl.exe");
				expect(args.slice(0, 5)).toEqual(["--distribution", windows.distro, "--cd", cwd, "--exec"]);
				if (args[5] === "/usr/bin/wslpath") {
					expect(args.slice(6, 8)).toEqual(["-a", "-u"]);
					state.path = args[8];
					return { code: 0, stdout: "/mnt/c/with spaces/conversation.md", stderr: "", killed: false };
				}
				expect(args.slice(5, 8)).toEqual(["/usr/bin/env", "SAGEOX_ENDPOINT=https://sageox.ai", windows.binary]);
				args = args.slice(8);
			} else {
				expect(cmd).toBe("/usr/bin/env");
				expect(args.slice(0, 2)).toEqual(["SAGEOX_ENDPOINT=https://sageox.ai", "ox"]);
				args = args.slice(2);
			}
			calls.push(args);
			let stdout = "";
			if (args[0] === "status")
				stdout = JSON.stringify({
					auth: { authenticated: true, endpoint: "sageox.ai", email: state.email },
					project: { initialized: true, directory: "/repo", team_id: state.team, repo_id: REPO },
					team_contexts: [{ team_id: state.team, is_repo_team: true, exists: true }],
				});
			if (args[0] === "import") {
				if (windows) {
					expect(args.at(-1)).toBe("/mnt/c/with spaces/conversation.md");
					expect(args[args.indexOf("--text") + 1]).toBe("/mnt/c/with spaces/conversation.md");
				} else state.path = args.at(-1)!;
				expect((await stat(state.path)).mode & 0o077).toBe(0);
				state.imported = await readFile(state.path, "utf8");
				stdout = JSON.stringify({
					status: "imported",
					team_id: TEAM,
					source_oid: `sha256:${createHash("sha256").update(state.imported).digest("hex")}`,
					path: `data/docs/2026/11/04/veyyon-capture-${createHash("sha256").update(state.imported).digest("hex").slice(0, 16)}`,
				});
			}
			if (args[0] === "murmur")
				stdout =
					args[1] === "list"
						? JSON.stringify({ murmurs: [{ content: state.note }], total: 1 })
						: "Murmur queued (daemon starting, will sync shortly): receipt-id";
			if (args[0] === "query")
				stdout = JSON.stringify({ team_context: { results: [{ text: "colleague's answer" }] } });
			return { code: args[0] === "import" && state.fail ? 1 : 0, stdout, stderr: "", killed: false };
		},
	};
	sageox(api as unknown as ExtensionAPI, TEAM, windows);
	return {
		state,
		ctx,
		calls,
		event: (name: string) => hooks.get(name)!({}, ctx),
		run: (name: string, args = "") => commands.get(name)!(args, ctx as unknown as ExtensionCommandContext),
		tools,
	};
}

test("publishes only the edited visible branch under the confirmed team, then removes the draft", async () => {
	const f = fixture();
	await f.run("sageox-capture");
	expect(f.state.draft).toContain("visible question");
	expect(f.state.draft).toContain("visible answer");
	expect(f.state.draft).not.toMatch(/private thought|internal prompt|tool secret|tool output/);
	expect(f.state.imported).toBe(f.state.accepted);
	expect(f.calls.at(-1)).toContain(TEAM);
	expect(f.state.receipt).toContain("data/docs/2026/11/04/veyyon-capture-");
	expect(await Bun.file(f.state.path).exists()).toBe(false);
});

test("an import failure removes the private draft and cannot acknowledge a publish", async () => {
	const f = fixture();
	f.state.fail = true;
	await expect(f.run("sageox-capture")).rejects.toThrow();
	expect(f.state.receipt).toBe("");
	expect(await Bun.file(f.state.path).exists()).toBe(false);
});

test("decline, session, account and destination changes never call import", async () => {
	for (const change of ["decline", "switch", "team", "account", "no-identity"]) {
		const f = fixture();
		f.ctx.ui.confirm = async () => {
			if (change === "switch") f.state.id = "other";
			if (change === "account") f.state.email = "colleague@example.invalid";
			if (change === "no-identity") f.state.email = "";
			if (change === "team") f.state.team = "team_other";
			return change !== "decline";
		};
		await f.run("sageox-capture").catch(() => {});
		expect(f.calls.some(args => args[0] === "import")).toBe(false);
	}
});

test("explicit handoffs keep option-looking text literal and queued receipts visible", async () => {
	const f = fixture();
	await f.run("sageox-handoff", '--scope=team $("noop")');
	const args = f.calls.at(-1)!;
	expect(args).toContain("--scope=ledger");
	expect(args.at(-2)).toBe("--");
	expect(JSON.parse(args.at(-1)!)).toEqual({ content: '--scope=team $("noop")' });
	expect(f.state.receipt).toContain("queued");
});

test("headless reads search the enrolled repo and return handoff records", async () => {
	const f = fixture();
	f.ctx.hasUI = false;
	const search = await f.tools.get("sageox_search")!({ query: "--help" });
	expect(search.content[0].text).toContain("colleague's answer");
	expect(f.calls.at(-1)).toEqual([
		"query",
		"--json",
		"--source",
		"team",
		"--team",
		TEAM,
		"--repo",
		REPO,
		"--limit",
		"5",
		"--",
		"--help",
	]);
	const notes = await f.tools.get("sageox_handoffs")!({});
	expect(notes.content[0].text).toContain(f.state.note);
	await expect(f.run("sageox-capture")).rejects.toThrow();
	expect(f.calls.some(args => args[0] === "import")).toBe(false);
});

test("an unenrolled account cannot send a query or note", async () => {
	const f = fixture();
	f.state.team = "team_other";
	await expect(f.tools.get("sageox_search")!({ query: "private search" })).rejects.toThrow();
	await expect(f.run("sageox-handoff", "private note")).rejects.toThrow();
	expect(f.calls.every(args => args[0] === "status")).toBe(true);
});

test("native Windows uses one named WSL distribution for status, path conversion and capture", async () => {
	const f = fixture(true);
	await f.run("sageox-capture");
	expect(f.state.imported).toBe(f.state.accepted);
	expect(f.state.receipt).toContain("data/docs/2026/11/04/veyyon-capture-");
	expect(await Bun.file(f.state.path).exists()).toBe(false);
});

test("ready handoffs prime exactly once, never delay an offline turn and do not follow a session switch", async () => {
	const f = fixture();
	f.event("session_start");
	expect(f.event("before_agent_start")).toBeUndefined();
	await new Promise(done => setTimeout(done, 0));
	const msg = f.event("before_agent_start")?.message.content;
	expect(msg).toContain("untrusted teammate notes");
	expect(msg).toContain(f.state.note);
	expect(f.event("before_agent_start")).toBeUndefined();
	f.state.id = "other";
	f.state.team = "team_other";
	f.event("session_switch");
	await new Promise(done => setTimeout(done, 0));
	expect(f.event("before_agent_start")).toBeUndefined();
	f.event("session_shutdown");
});
