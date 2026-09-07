/**
 * Render status footlines across agent operating mode configurations.
 *
 * Builds mock sessions with combinations of approval bypass, plan mode, goal mode
 * with token budgets, vibe mode, loop mode, and active subagent counts. Renders the
 * status line component for each state combination and prints the resulting lines as
 * ANSI text.
 *
 * Usage:
 *   bun scripts/demos/render-mode-states.ts [--width 100] [--theme titanium]
 */

import { StatusLineComponent } from "../../packages/coding-agent/src/modes/terminal/components/status-line/component";
import type { AgentSession } from "../../packages/coding-agent/src/session/agent-session";
import { theme } from "../../packages/coding-agent/src/theme/theme";
import { renderDemo } from "./render-args";

interface StateLoad {
	readonly label: string;
	readonly bypassed?: boolean;
	readonly approvalMode?: string;
	readonly plan?: { enabled: boolean; paused: boolean };
	readonly goal?: { enabled: boolean; paused: boolean };
	readonly goalState?: { tokensUsed: number; tokenBudget?: number; status?: string };
	readonly vibe?: boolean;
	readonly loop?: boolean;
	readonly subagents?: number;
}

function stubSession(load: StateLoad): AgentSession {
	const usage = {
		input: 12_000,
		output: 3_400,
		cacheRead: 48_000,
		cacheWrite: 1_200,
		totalTokens: 64_600,
		orchestrationInput: 0,
		orchestrationOutput: 0,
		orchestrationCacheRead: 0,
		premiumRequests: 2,
		cost: 0.42,
		tokensPerSecond: 58.4,
	};
	const goal = load.goalState
		? {
				goal: {
					tokensUsed: load.goalState.tokensUsed,
					tokenBudget: load.goalState.tokenBudget,
					status: load.goalState.status ?? "active",
				},
			}
		: undefined;
	return {
		messages: [],
		model: { contextWindow: 200_000, id: "gpt-5", name: "gpt-5", provider: "openai" },
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		getContextUsage: () => ({ tokens: 84_000, contextWindow: 200_000 }),
		state: { messages: [], model: { contextWindow: 200_000, id: "gpt-5", name: "gpt-5" } },
		sessionManager: {
			getUsageStatistics: () => usage,
			getSessionName: () => "parser-rewrite",
			getCwd: () => "/home/you/code/veyyon",
		},
		getPrewalkState: () => undefined,
		getAsyncJobSnapshot: () => undefined,
		getGoalModeState: () => goal,
		settings: {
			getGroup: () => ({ enabled: false }),
			get: (path: string) => (path === "goal.modelBudgetsEnabled" ? true : undefined),
		},
		isAdvisorActive: () => false,
		isApprovalBypassed: () => load.bypassed === true,
		effectiveApprovalMode: () => load.approvalMode ?? "auto",
		isFastModeActive: () => false,
		isStreaming: false,
		configuredThinkingLevel: () => "medium",
		modelRegistry: { isUsingOAuth: () => false },
	} as unknown as AgentSession;
}

const LOADS: StateLoad[] = [
	{ label: "1 state  (rung only)", approvalMode: "auto" },
	{ label: "1 state  (yolo only)", bypassed: true },
	{ label: "2 states (rung + goal)", approvalMode: "auto", goal: { enabled: true, paused: false } },
	{ label: "2 states (yolo + goal)", bypassed: true, goal: { enabled: true, paused: false } },
	{
		label: "3 states (yolo + goal + budget)",
		bypassed: true,
		goal: { enabled: true, paused: false },
		goalState: { tokensUsed: 12_345, tokenBudget: 50_000 },
	},
	{
		label: "3 states (yolo + plan + subagents)",
		bypassed: true,
		plan: { enabled: false, paused: true },
		subagents: 3,
	},
	{
		label: "4 states (yolo + goal + budget + subagents)",
		bypassed: true,
		goal: { enabled: true, paused: false },
		goalState: { tokensUsed: 12_345, tokenBudget: 50_000 },
		subagents: 3,
	},
];

await renderDemo(
	({ width }) => {
		const lines: string[] = [];
		for (const load of LOADS) {
			const statusLine = new StatusLineComponent(stubSession(load));
			statusLine.updateSettings({ preset: "default" });
			if (load.plan) statusLine.setPlanModeStatus(load.plan);
			if (load.goal) statusLine.setGoalModeStatus(load.goal);
			if (load.vibe) statusLine.setVibeModeStatus({ enabled: true });
			if (load.loop) statusLine.setLoopModeStatus({ enabled: true });
			statusLine.setSubagentCount(load.subagents ?? 0);
			lines.push(theme.fg("dim", `${load.label}:`));
			lines.push(statusLine.renderQuietLine(width) ?? theme.fg("error", "(no footline rendered)"));
			lines.push("");
		}
		return lines;
	},
	{ settings: true },
);
