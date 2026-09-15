/**
 * Handlers for the `modes` builtin slash commands.
 *
 * Split out of `builtin-registry.ts`, which is now the composition root: it imports the eight
 * domain maps and assembles them. The domain a command belongs to is decided in one place,
 * `categories.ts`, and `test/slash-commands/a-builtin-lives-in-the-domain-it-is-categorised-under.test.ts`
 * fails when this file and that map disagree, so the two cannot drift.
 */
import * as path from "node:path";
import { truncate } from "@veyyon/utils";
import { sanitizeStatusText } from "@veyyon/utils/sanitize-status-text";
import { missingCredentialsMessage } from "../config/missing-credentials";
import { modelResolutionFailureMessage } from "../config/model-resolution-failure";
import { getModelMatchPreferences, normalizeModelPatternList, resolveCliModel } from "../config/model-resolver";
import { PRIORITY_TIER_COMMAND_LABEL, PRIORITY_TIER_LABEL } from "../config/service-tier";
import type { Settings } from "../config/settings";
import { settings } from "../config/settings-instance";
import { describeLoopLimitRuntime } from "../modes/loop-limit";
import { runPauseScreen } from "../modes/terminal/components/dialogs/pause-screen";
import type { AgentSession } from "../session/agent-session";
import { normalizeApprovalMode } from "../tools/core/approval";
import { AUTONOMY_LABEL, isKnownApprovalMode } from "../tools/core/approval-modes";
import { refreshStatusLine } from "./builtin-shared";
import type { BuiltinSlashCommandHandlers } from "./handler-types";
import { applyCpuLimitCommand } from "./helpers/cpu-limit";
import { commandConsumed, usage } from "./helpers/parse";

/** `/fast status` label for the active model: "on" when its family is the priority tier, else "off". */
export function formatFastModeStatus(session: AgentSession): string {
	return session.isFastModeEnabled() ? "on" : "off";
}

/** `/yolo status` label: "on" when the full permission bypass is active, else "off". */
export function formatYoloStatus(session: AgentSession): string {
	return session.isApprovalBypassed() ? "on" : "off";
}

/**
 * The rung in force plus where it came from, e.g. `Ask cmds (session)`.
 *
 * The SOURCE is half the answer. "Ask cmds" alone leaves an operator unable to
 * tell a saved preference from a `/permissions` override they set an hour ago,
 * and those two need different actions to change: one is `/settings`, the other
 * is `/permissions reset`.
 *
 * When something OUTRANKS the stored value, the enforced rung is reported and
 * the stored one is named after it. `--yolo` forces `yolo` for the whole run
 * and an active plan session caps to `plan`, and neither is visible in
 * `tools.approvalMode`: reading only the setting, `veyyon --yolo` followed by
 * `/permissions ask` answered "Ask all" about a session running every tool
 * unasked. Saying `Yolo (--yolo, overriding ask)` is the difference between a
 * command that reports state and one that misreports it.
 */
export function describeApprovalMode(from: Settings, session?: AgentSession): string {
	const configured = normalizeApprovalMode(from.get("tools.approvalMode"));
	const source = from.getSource("tools.approvalMode");
	const origin = source === "runtime" ? "session" : source === "default" ? "default" : "saved";
	const stored = `${AUTONOMY_LABEL[configured]} (${origin})`;
	const enforced = session ? normalizeApprovalMode(session.effectiveApprovalMode()) : configured;
	if (enforced === configured) return stored;
	const because = enforced === "plan" ? "plan mode" : "--yolo";
	return `${AUTONOMY_LABEL[enforced]} (${because}, overriding ${AUTONOMY_LABEL[configured]} ${origin})`;
}

/**
 * Apply one `/permissions` invocation, shared by the text and TUI surfaces so
 * both accept exactly the same words and report the same sentence.
 *
 * A rung set here is a RUNTIME override: it holds for this session and is never
 * written to config. That is the intended split — the persisted default is
 * chosen once (onboarding, then `/settings`), and a session that needs more or
 * less rope says so without editing anything. `reset` drops the override rather
 * than writing the default back, so the saved value keeps winning afterwards
 * even if it changes.
 */
export function applyPermissionsCommand(
	rawArgs: string,
	from: Settings,
	session?: AgentSession,
): { ok: boolean; message: string } {
	const arg = rawArgs.trim().toLowerCase();
	if (!arg || arg === "status") {
		return {
			ok: true,
			message: `Tool approval: ${describeApprovalMode(from, session)}. Change it with /permissions <mode>.`,
		};
	}
	if (arg === "reset" || arg === "default") {
		from.clearOverride("tools.approvalMode");
		return { ok: true, message: `Session override dropped. Tool approval: ${describeApprovalMode(from, session)}.` };
	}
	if (!isKnownApprovalMode(arg)) {
		return {
			ok: false,
			message: "Usage: /permissions [ask|ask-command|auto|yolo|plan|reset]",
		};
	}
	from.override("tools.approvalMode", arg);
	return {
		ok: true,
		message: `Tool approval for this session: ${describeApprovalMode(from, session)}. /permissions reset restores the saved default.`,
	};
}

export const AUTOCOMPLETE_DETAIL_LIMIT = 48;

/**
 * A command's detail column: one line, plain, capped. The value is not this file's -- a goal
 * objective is typed or written by a model -- so an escape sequence in it would style the rest of
 * the autocomplete row, and `sanitizeStatusText` strips it before the cap counts characters.
 */
export function shortDetail(value: string, limit = AUTOCOMPLETE_DETAIL_LIMIT): string {
	return truncate(sanitizeStatusText(value), limit);
}

/** What the modes builtins DO, keyed by the name each is declared under. */
export const MODES_HANDLERS = {
	plan: {
		// Palette rows lead with what the command DOES; live state is secondary
		// context after the dot. "Plan: off" told a new user nothing.
		getTuiAutocompleteDescription: runtime => {
			if (!runtime.ctx.settings.get("plan.enabled")) return "Toggle plan mode · disabled in settings";
			if (runtime.ctx.planModeEnabled) {
				const planFile = runtime.ctx.planModePlanFilePath;
				return `Toggle plan mode · on${planFile ? ` (${path.basename(planFile)})` : ""}`;
			}
			if (runtime.ctx.goalModeEnabled) return "Toggle plan mode · blocked by goal mode";
			return "Toggle plan mode · off";
		},
		handleTui: async (command, runtime) => {
			await runtime.ctx.handlePlanModeCommand(command.args || undefined);
			runtime.ctx.editor.setText("");
		},
	},
	"plan-review": {
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.planModeEnabled
				? "Re-open the latest plan review"
				: "Re-open the latest plan review · needs plan mode",
		handleTui: async (_command, runtime) => {
			await runtime.ctx.openPlanReview();
			runtime.ctx.editor.setText("");
		},
	},
	vibe: {
		getTuiAutocompleteDescription: runtime => {
			if (runtime.ctx.vibeModeEnabled) return "Toggle vibe mode · on";
			if (runtime.ctx.planModeEnabled) return "Toggle vibe mode · blocked by plan mode";
			if (runtime.ctx.goalModeEnabled) return "Toggle vibe mode · blocked by goal mode";
			return "Toggle vibe mode · off";
		},
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleVibeModeCommand(command.args || undefined);
			runtime.ctx.editor.setText("");
		},
	},
	goal: {
		getTuiAutocompleteDescription: runtime => {
			if (!runtime.ctx.settings.get("goal.enabled")) return "Toggle goal mode · disabled in settings";
			if (runtime.ctx.planModeEnabled) return "Toggle goal mode · blocked by plan mode";
			const state = runtime.ctx.session.getGoalModeState();
			return state
				? `Toggle goal mode · ${state.goal.status} (${shortDetail(state.goal.objective)})`
				: "Toggle goal mode · off";
		},
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleGoalModeCommand(command.args || undefined);
			runtime.ctx.editor.setText("");
		},
	},
	"guided-goal": {
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleGuidedGoalCommand(command.args || undefined);
			runtime.ctx.editor.setText("");
		},
	},
	loop: {
		getTuiAutocompleteDescription: runtime => {
			if (!runtime.ctx.loopModeEnabled) return "Toggle loop mode · off";
			if (runtime.ctx.loopLimit) return `Toggle loop mode · on (${describeLoopLimitRuntime(runtime.ctx.loopLimit)})`;
			if (runtime.ctx.loopPrompt) return "Toggle loop mode · on (repeating prompt)";
			return "Toggle loop mode · on (waiting for next prompt)";
		},
		handleTui: async (command, runtime) => {
			const prompt = await runtime.ctx.handleLoopCommand(command.args);
			runtime.ctx.editor.setText("");
			// Surface any inline prompt so the dispatcher returns it and the normal
			// submit flow runs the first loop iteration (recording it as the loop prompt).
			if (prompt) return { prompt };
		},
	},
	queue: {
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleQueueCommand(command.args);
		},
	},
	fast: {
		getTuiAutocompleteDescription: runtime =>
			`Toggle the ${PRIORITY_TIER_LABEL} tier · ${formatFastModeStatus(runtime.ctx.session)}`,
		handle: async (command, runtime) => {
			const arg = command.args.toLowerCase();
			if (!arg || arg === "toggle") {
				const enabled = runtime.session.toggleFastMode();
				await runtime.output(`${PRIORITY_TIER_COMMAND_LABEL} ${enabled ? "enabled" : "disabled"}.`);
				return commandConsumed();
			}
			if (arg === "on") {
				const supported = runtime.session.setFastMode(true);
				await runtime.output(
					supported
						? `${PRIORITY_TIER_COMMAND_LABEL} enabled.`
						: `${PRIORITY_TIER_COMMAND_LABEL} is unavailable for the current model.`,
				);
				return commandConsumed();
			}
			if (arg === "off") {
				runtime.session.setFastMode(false);
				await runtime.output(`${PRIORITY_TIER_COMMAND_LABEL} disabled.`);
				return commandConsumed();
			}
			if (arg === "status") {
				await runtime.output(`${PRIORITY_TIER_COMMAND_LABEL} is ${formatFastModeStatus(runtime.session)}.`);
				return commandConsumed();
			}
			return usage("Usage: /fast [on|off|status]", runtime);
		},
		handleTui: (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (!arg || arg === "toggle") {
				const enabled = runtime.ctx.session.toggleFastMode();
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus(`${PRIORITY_TIER_COMMAND_LABEL} ${enabled ? "enabled" : "disabled"}.`);
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "on") {
				const supported = runtime.ctx.session.setFastMode(true);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus(
					supported
						? `${PRIORITY_TIER_COMMAND_LABEL} enabled.`
						: `${PRIORITY_TIER_COMMAND_LABEL} is unavailable for the current model.`,
				);
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "off") {
				runtime.ctx.session.setFastMode(false);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus(`${PRIORITY_TIER_COMMAND_LABEL} disabled.`);
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "status") {
				runtime.ctx.showStatus(`${PRIORITY_TIER_COMMAND_LABEL} is ${formatFastModeStatus(runtime.ctx.session)}.`);
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("Usage: /fast [on|off|status]");
			runtime.ctx.editor.setText("");
		},
	},
	permissions: {
		getTuiAutocompleteDescription: runtime =>
			`Tool approval · ${describeApprovalMode(settings, runtime.ctx.session)}`,
		handle: async (command, runtime) => {
			// `runtime.settings` on the text path and the module proxy on the TUI
			// path are the same instance in every shipped host; the session comes
			// along so both report the ENFORCED rung rather than the stored one.
			const result = applyPermissionsCommand(command.args, runtime.settings, runtime.session);
			if (!result.ok) return usage(result.message, runtime);
			await runtime.output(result.message);
			await runtime.notifyConfigChanged?.();
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const result = applyPermissionsCommand(command.args, settings, runtime.ctx.session);
			refreshStatusLine(runtime.ctx);
			runtime.ctx.showStatus(result.message);
		},
	},
	"cpu-limit": {
		getTuiAutocompleteDescription: () => {
			const cores = settings.get("session.cpuLimitCores");
			const scope = settings.getSource("session.cpuLimitCores") === "runtime" ? "session" : "profile";
			return `Session CPU budget · ${cores > 0 ? `${cores} core(s), ${scope}` : "off"}`;
		},
		handle: async (command, runtime) => {
			const result = await applyCpuLimitCommand(
				command.args,
				runtime.settings,
				runtime.session.sessionManager.getSessionId(),
			);
			if (!result.ok) return usage(result.message, runtime);
			await runtime.output(result.message);
			await runtime.notifyConfigChanged?.();
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const result = await applyCpuLimitCommand(
				command.args,
				settings,
				runtime.ctx.session.sessionManager.getSessionId(),
			);
			runtime.ctx.showStatus(result.message);
		},
	},
	yolo: {
		getTuiAutocompleteDescription: runtime => `Full permission bypass · ${formatYoloStatus(runtime.ctx.session)}`,
		handle: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				await runtime.output(`Full permission bypass is ${formatYoloStatus(runtime.session)}.`);
				return commandConsumed();
			}
			if (arg === "off") {
				runtime.session.setApprovalBypass(false);
				await runtime.output("Full permission bypass off. Approval prompts are back on.");
				await runtime.notifyConfigChanged?.();
				return commandConsumed();
			}
			if (!arg || arg === "on" || arg === "toggle") {
				const next = arg === "toggle" || !arg ? !runtime.session.isApprovalBypassed() : true;
				runtime.session.setApprovalBypass(next);
				await runtime.output(
					next
						? "Full permission bypass ON. Every approval prompt is off for this session (explicit deny and plan mode still block)."
						: "Full permission bypass off. Approval prompts are back on.",
				);
				await runtime.notifyConfigChanged?.();
				return commandConsumed();
			}
			return usage("Usage: /yolo [on|off|status]", runtime);
		},
		handleTui: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			runtime.ctx.editor.setText("");
			if (arg === "status") {
				runtime.ctx.showStatus(`Full permission bypass is ${formatYoloStatus(runtime.ctx.session)}.`);
				return;
			}
			if (arg === "off") {
				runtime.ctx.session.setApprovalBypass(false);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.updateEditorBorderColor();
				runtime.ctx.showStatus("Full permission bypass off. Approval prompts are back on.");
				return;
			}
			// Any enabling path (bare, `on`, or `toggle` landing on) requires an
			// explicit danger confirmation: this turns off EVERY prompt.
			const enabling = arg === "toggle" ? !runtime.ctx.session.isApprovalBypassed() : true;
			if (!enabling) {
				runtime.ctx.session.setApprovalBypass(false);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.updateEditorBorderColor();
				runtime.ctx.showStatus("Full permission bypass off. Approval prompts are back on.");
				return;
			}
			if (runtime.ctx.session.isApprovalBypassed()) {
				runtime.ctx.showStatus("Full permission bypass is already on.");
				return;
			}
			const confirmed = await runtime.ctx.showHookConfirm(
				"Turn OFF all permission prompts?",
				"YOLO removes every approval prompt for this session: file writes, shell commands, and network calls run without asking. Explicit per-tool deny rules and plan mode still block. This resets to off when the session ends. Continue?",
			);
			if (!confirmed) {
				runtime.ctx.showStatus("Full permission bypass not enabled.");
				return;
			}
			runtime.ctx.session.setApprovalBypass(true);
			refreshStatusLine(runtime.ctx);
			runtime.ctx.updateEditorBorderColor();
			runtime.ctx.showStatus("YOLO on: all permission prompts are OFF for this session.");
		},
	},
	prewalk: {
		handle: async (command, runtime) => {
			// The target no longer defaults to a role alias: an unset role stopped
			// resolving to a model (#980 fail-closed). `/prewalk <model>` names the
			// target for this session; without an argument, `prewalk.cheapModel`
			// is required, and the refusal names the setting that fixes it.
			const arg = command.args.trim();
			// Same chain normalization the setting gets: a comma list contributes
			// its first entry, an empty argument falls through to the setting.
			const cheapPattern =
				normalizeModelPatternList(arg)[0] ||
				normalizeModelPatternList(runtime.settings.get("prewalk.cheapModel"))[0];
			if (!cheapPattern) {
				return usage(
					'Prewalk needs a cheap target model: run /prewalk <model> or set "prewalk.cheapModel" in settings.',
					runtime,
				);
			}
			const resolved = resolveCliModel({
				cliModel: cheapPattern,
				modelRegistry: runtime.session.modelRegistry,
				preferences: getModelMatchPreferences(runtime.settings),
				settings: runtime.settings,
			});
			if (resolved.error || !resolved.model) {
				return usage(
					resolved.error ?? modelResolutionFailureMessage([cheapPattern], runtime.session.modelRegistry),
					runtime,
				);
			}
			if (!runtime.session.modelRegistry.hasConfiguredAuth(resolved.model)) {
				// `/prewalk` is text-mode, so the remedy has to hold outside a terminal.
				// `missingCredentialsMessage` names the env var, the auth-broker command and the models.yml
				// path, and marks `/login` as the interactive-only shortcut rather than the answer.
				return usage(missingCredentialsMessage(resolved.model.provider, resolved.model.id), runtime);
			}
			runtime.session.armPrewalk(resolved.model, resolved.thinkingLevel);
			await runtime.output(
				`Prewalk on: switching to ${resolved.model.provider}/${resolved.model.id} at the next edit/write (todo-gated).`,
			);
			return commandConsumed();
		},
	},
	pause: {
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runPauseScreen(runtime.ctx);
		},
	},
} satisfies Partial<BuiltinSlashCommandHandlers>;
