/**
 * Handlers for the `workspace` builtin slash commands.
 *
 * Split out of `builtin-registry.ts`, which is now the composition root: it imports the eight
 * domain maps and assembles them. The domain a command belongs to is decided in one place,
 * `builtin-categories.ts`, and `test/slash-commands/a-builtin-lives-in-the-domain-it-is-categorised-under.test.ts`
 * fails when this file and that map disagree, so the two cannot drift.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Settings } from "../config/settings";
import { settings } from "../config/settings-instance";
import { formatDurationCoarse } from "../session/account-format";
import type { AgentSession } from "../session/agent-session";
import { normalizePathLikeInput, resolveToCwd } from "../tools/core/path-utils";
import type { BuiltinSlashCommandHandlers } from "./handler-types";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./helpers/parse";
import {
	describeRedeemOutcome,
	findResetUsageAccount,
	type ResetUsageAccount,
	toResetUsageAccounts,
} from "./helpers/reset-usage";
import { handleStatsAcp } from "./helpers/stats-dashboard";
import { buildUsageReportText } from "./helpers/usage-report";
import type { SlashCommandRuntime } from "./types";

export async function handleUsageResetCommand(
	arg: string,
	session: AgentSession,
	output: SlashCommandRuntime["output"],
): Promise<void> {
	let accounts: ResetUsageAccount[];
	try {
		accounts = toResetUsageAccounts(await session.listResetCredits());
	} catch (error) {
		await output(`Could not load saved resets: ${errorMessage(error)}`);
		return;
	}
	if (accounts.length === 0) {
		await output(
			"No OpenAI Codex or Anthropic accounts found. Sign in with /login in an interactive veyyon session to add one.",
		);
		return;
	}
	const targetArg = arg.trim();
	if (!targetArg) {
		const lines = ["Saved rate-limit resets:"];
		for (const account of accounts) {
			const detail = account.error ? `unavailable (${account.error})` : `${account.availableCount} available`;
			lines.push(`- ${account.providerName} ${account.label}: ${detail}${account.active ? " (active)" : ""}`);
		}
		lines.push(
			"",
			"Spend one with `/usage reset <account email>` or `/usage reset active`; prefix `openai-codex` or `anthropic` to pick the provider.",
		);
		await output(lines.join("\n"));
		return;
	}
	const target = findResetUsageAccount(accounts, targetArg);
	if (!target) {
		await output(`No account matches "${targetArg}".`);
		return;
	}
	if (target.availableCount <= 0) {
		await output(`${target.providerName} ${target.label}: no saved resets to spend.`);
		return;
	}
	const label = `${target.providerName} ${target.label}`;
	const outcome = await session.redeemResetCredit(target.target);
	await output(describeRedeemOutcome(outcome, label));
}

/**
 * Apply one `/browser` invocation, shared by the text and TUI surfaces so both accept exactly the
 * same words and report the same sentence. The mode is saved before the running browser restarts,
 * so a failed restart reports the saved mode with the failure.
 */
export async function applyBrowserCommand(
	rawArgs: string,
	from: Settings,
	session: AgentSession,
): Promise<{ ok: boolean; message: string }> {
	if (!from.get("browser.enabled")) return { ok: false, message: "Browser tool is disabled (enable in settings)." };
	const arg = rawArgs.trim().toLowerCase();
	let headless: boolean;
	if (!arg) headless = !from.get("browser.headless");
	else if (arg === "headless" || arg === "hidden") headless = true;
	else if (arg === "visible" || arg === "show" || arg === "headful") headless = false;
	else return { ok: false, message: "Usage: /browser [headless|visible]" };
	from.set("browser.headless", headless);
	const mode = headless ? "headless" : "visible";
	const tool = session.getToolByName("browser");
	if (tool && "restartForModeChange" in tool) {
		try {
			await (tool as { restartForModeChange: () => Promise<void> }).restartForModeChange();
		} catch (err) {
			return { ok: false, message: `Browser mode set to ${mode}, but restart failed: ${errorMessage(err)}` };
		}
	}
	return { ok: true, message: `Browser mode: ${mode}` };
}

/** What the workspace builtins DO, keyed by the name each is declared under. */
export const WORKSPACE_HANDLERS = {
	browser: {
		getTuiAutocompleteDescription: runtime => {
			if (!runtime.ctx.settings.get("browser.enabled"))
				return "Toggle browser headless/visible · disabled in settings";
			return runtime.ctx.settings.get("browser.headless")
				? "Toggle browser headless/visible · headless"
				: "Toggle browser headless/visible · visible";
		},
		handle: async (command, runtime) => {
			const result = await applyBrowserCommand(command.args, runtime.settings, runtime.session);
			if (!result.ok) return usage(result.message, runtime);
			await runtime.output(result.message);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const result = await applyBrowserCommand(command.args, settings, runtime.ctx.session);
			if (result.ok) runtime.ctx.showStatus(result.message);
			else runtime.ctx.showWarning(result.message);
		},
	},
	jobs: {
		getTuiAutocompleteDescription: runtime => {
			const snapshot = runtime.ctx.session.getAsyncJobSnapshot({ recentLimit: 5 });
			if (!snapshot || (snapshot.running.length === 0 && snapshot.recent.length === 0))
				return "Show background jobs · none running";
			return `Show background jobs · ${snapshot.running.length} running, ${snapshot.recent.length} recent`;
		},
		handle: async (_command, runtime) => {
			const snapshot = runtime.session.getAsyncJobSnapshot({ recentLimit: 5 });
			if (!snapshot || (snapshot.running.length === 0 && snapshot.recent.length === 0)) {
				await runtime.output(
					"No background jobs running. (Background jobs run async tools — e.g. long-running bash, debug, or task spawned agents that would otherwise tie up a turn. They appear here while alive and for ~5 minutes after.)",
				);
				return commandConsumed();
			}
			const now = Date.now();
			const lines: string[] = ["Background Jobs", `Running: ${snapshot.running.length}`];
			if (snapshot.running.length > 0) {
				lines.push("", "Running Jobs");
				for (const job of snapshot.running) {
					lines.push(`  [${job.id}] ${job.type} (${job.status}) — ${formatDurationCoarse(now - job.startTime)}`);
					lines.push(`    ${job.label}`);
				}
			}
			if (snapshot.recent.length > 0) {
				lines.push("", "Recent Jobs");
				for (const job of snapshot.recent) {
					lines.push(`  [${job.id}] ${job.type} (${job.status}) — ${formatDurationCoarse(now - job.startTime)}`);
					lines.push(`    ${job.label}`);
				}
			}
			await runtime.output(lines.join("\n"));
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleJobsCommand();
			runtime.ctx.editor.setText("");
		},
	},
	usage: {
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || (verb === "show" && !rest)) {
				await runtime.output(await buildUsageReportText(runtime));
				return commandConsumed();
			}
			if (verb === "reset") {
				await handleUsageResetCommand(rest, runtime.session, runtime.output);
				return commandConsumed();
			}
			return usage("Usage: /usage [show|reset [openai-codex|anthropic] [account|active]]", runtime);
		},
		handleTui: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || (verb === "show" && !rest)) {
				await runtime.ctx.handleUsageCommand();
				runtime.ctx.editor.setText("");
				return;
			}
			if (verb === "reset") {
				if (rest) {
					await handleUsageResetCommand(rest, runtime.ctx.session, text => runtime.ctx.showStatus(text));
				} else {
					await runtime.ctx.showResetUsageSelector();
				}
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("Usage: /usage [show|reset [openai-codex|anthropic] [account|active]]");
			runtime.ctx.editor.setText("");
		},
	},
	tools: {
		getTuiAutocompleteDescription: runtime => {
			const active = runtime.ctx.session.getActiveToolNames().length;
			const all = runtime.ctx.session.getAllToolNames().length;
			return all === 0
				? "List the agent's tools · none available"
				: `List the agent's tools · ${active} active / ${all} available`;
		},
		handle: async (_command, runtime) => {
			const active = runtime.session.getActiveToolNames();
			const all = runtime.session.getAllToolNames();
			if (all.length === 0) {
				await runtime.output("No tools are available.");
				return commandConsumed();
			}
			await runtime.output(all.map(name => `${active.includes(name) ? "*" : "-"} ${name}`).join("\n"));
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.handleToolsCommand();
			runtime.ctx.editor.setText("");
		},
	},
	// `/cockpit` and `/hub` reach this same handler as aliases of `/agents`: one
	// roster, one drill-in. They were separate overlays that showed the same
	// registry through two different renderings and could disagree about what was
	// running.
	agents: {
		handleTui: (_command, runtime) => {
			runtime.ctx.showAgentsDashboard();
			runtime.ctx.editor.setText("");
		},
	},
	stats: {
		handle: handleStatsAcp,
	},
	cwd: {
		handle: async (command, runtime) => {
			const current = runtime.sessionManager.getCwd();
			// The path is read the way `/move` reads it: trimmed, outer double quotes stripped.
			const target = normalizePathLikeInput(command.args);
			if (!target) {
				await runtime.output(
					`${current}\n(session-scoped and ephemeral. For a per-profile default working directory, set session.workdir in /settings › Interaction › Profile on this profile, or run: veyyon config set session.workdir <path>.)`,
				);
				return commandConsumed();
			}
			if (runtime.session.isStreaming) return usage("Cannot change cwd while streaming.", runtime);
			const resolvedPath = resolveToCwd(target, current);
			// A relative arg resolves against the SESSION cwd, not the OS cwd or the
			// project root, so name that base in the failure — otherwise `/cwd tmp`
			// from a session rooted elsewhere reads as "tmp doesn't exist" with no clue why.
			const relativeHint = path.isAbsolute(target)
				? ""
				: ` (relative paths resolve against the current session cwd ${current}; pass an absolute path to avoid this)`;
			try {
				const st = await fs.stat(resolvedPath);
				if (!st.isDirectory()) {
					return usage(`Not a directory: ${resolvedPath}${relativeHint}`, runtime);
				}
			} catch {
				return usage(`Directory does not exist: ${resolvedPath}${relativeHint}`, runtime);
			}
			try {
				const next = await runtime.session.setCwd(resolvedPath, { validate: true });
				await runtime.output(
					next === current
						? `cwd unchanged: ${next}`
						: `cwd set: ${current} → ${next}\nThis change is session-scoped and ephemeral (it does not persist). For a per-profile default, set session.workdir in /settings › Interaction › Profile on this profile, or run: veyyon config set session.workdir <path>.`,
				);
				await runtime.notifyTitleChanged?.();
				return commandConsumed();
			} catch (err) {
				return usage(`set cwd failed: ${errorMessage(err)}`, runtime);
			}
		},
	},
} satisfies Partial<BuiltinSlashCommandHandlers>;
