/**
 * The `/session` panel: the session file and id, the provider serving it and how it is authenticated,
 * message, token and cost totals, and the language and MCP servers it started.
 */
import type { AuthStorage } from "@veyyon/ai/auth-storage";
import { getEnvApiKey } from "@veyyon/ai/env-api-key";
import { getProviderDetails, type ProviderDetails } from "@veyyon/ai/provider-details";
import { shouldEnableAppendOnlyContext } from "../../../config/append-only-context-mode";
import { openaiWebsocketPreference } from "../../../config/openai-websockets-mode";
import type { LspStartupServerInfo } from "../../../lsp";
import type { SessionStats } from "../../../session/agent-session-types";
import { theme } from "../../../theme/theme";
import type { CommandControllerContext } from "./command-controller";

/** The context members the `/session` panel reads. */
type SessionInfoContext = Pick<CommandControllerContext, "session" | "settings" | "lspServers" | "mcpManager">;

/** The `/session` panel text: file and id, provider, message and token counts, cost, language servers and MCP servers. */
export function renderSessionInfo(ctx: SessionInfoContext): string {
	const stats = ctx.session.getSessionStats();
	return [
		`${theme.bold("Session Info")}\n\n`,
		`${theme.fg("dim", "File:")} ${stats.sessionFile ?? "In-memory"}\n`,
		`${theme.fg("dim", "ID:")} ${stats.sessionId}\n\n`,
		`\n${theme.bold("Provider")}\n`,
		sessionProviderSection(ctx, stats.sessionId),
		"\n",
		formatSessionMessages(stats),
		appendOnlyContextLine(ctx),
		formatSessionTokens(stats.tokens),
		formatSessionCost(stats.cost, sessionPremiumRequests(ctx, stats)),
		formatLspServers(ctx.lspServers),
		mcpServersSection(ctx),
	].join("");
}

/** Premium requests rounded to cents, from the stats or, when they carry none, the session's usage log. */
function sessionPremiumRequests(ctx: SessionInfoContext, stats: SessionStats): number {
	const premiumRequests =
		"premiumRequests" in stats && typeof stats.premiumRequests === "number"
			? stats.premiumRequests
			: ctx.session.sessionManager.getUsageStatistics().premiumRequests;
	return Math.round((premiumRequests + Number.EPSILON) * 100) / 100;
}

function sessionProviderSection(ctx: SessionInfoContext, sessionId: string): string {
	const model = ctx.session.model;
	if (!model) return `${theme.fg("dim", "No model selected")}\n`;
	const authStorage = ctx.session.modelRegistry.authStorage;
	const details = getProviderDetails({
		model,
		sessionId,
		authMode: resolveProviderAuthMode(authStorage, model.provider),
		credentialSource: authStorage.describeCredentialSource(model.provider, sessionId),
		preferWebsockets: openaiWebsocketPreference(ctx.settings.get("providers.openaiWebsockets")),
		providerSessionState: ctx.session.providerSessionState,
	});
	return renderProviderSection(details, theme);
}

function appendOnlyContextLine(ctx: SessionInfoContext): string {
	const setting = ctx.settings.get("provider.appendOnlyContext");
	const model = ctx.session.model;
	const activeLabel = shouldEnableAppendOnlyContext(setting, model)
		? theme.fg("success", "active")
		: theme.fg("dim", "inactive");
	const settingLabel = setting === "auto" ? `${setting} (${model?.provider ?? "?"})` : setting;
	return `${theme.fg("dim", "Append-Only:")} ${activeLabel} (setting: ${settingLabel})\n`;
}

function mcpServersSection(ctx: SessionInfoContext): string {
	const mcpManager = ctx.mcpManager;
	if (!mcpManager) return "";
	const servers = mcpManager.getConnectedServers();
	const heading = `\n${theme.bold("MCP Servers")}\n`;
	if (servers.length === 0) return `${heading}${theme.fg("dim", "None connected")}\n`;
	let section = heading;
	for (const name of servers) {
		const toolCount = mcpManager.getConnection(name)?.tools?.length ?? 0;
		section += `${theme.fg("dim", `${name}:`)} ${theme.fg("success", "connected")} ${theme.fg("dim", `(${toolCount} tools)`)}\n`;
	}
	return section;
}

function formatSessionMessages(stats: SessionStats): string {
	return (
		`${theme.bold("Messages")}\n` +
		`${theme.fg("dim", "User:")} ${stats.userMessages}\n` +
		`${theme.fg("dim", "Assistant:")} ${stats.assistantMessages}\n` +
		`${theme.fg("dim", "Tool Calls:")} ${stats.toolCalls}\n` +
		`${theme.fg("dim", "Tool Results:")} ${stats.toolResults}\n` +
		`${theme.fg("dim", "Total:")} ${stats.totalMessages}\n\n`
	);
}

/** Input, output and total tokens, with cache reads and writes only when the session has any. */
function formatSessionTokens(tokens: SessionStats["tokens"]): string {
	let section = `${theme.bold("Tokens")}\n`;
	section += `${theme.fg("dim", "Input:")} ${tokens.input.toLocaleString()}\n`;
	section += `${theme.fg("dim", "Output:")} ${tokens.output.toLocaleString()}\n`;
	if (tokens.cacheRead > 0) section += `${theme.fg("dim", "Cache Read:")} ${tokens.cacheRead.toLocaleString()}\n`;
	if (tokens.cacheWrite > 0) section += `${theme.fg("dim", "Cache Write:")} ${tokens.cacheWrite.toLocaleString()}\n`;
	return `${section}${theme.fg("dim", "Total:")} ${tokens.total.toLocaleString()}\n`;
}

/** The cost section, listing only the spend that is above zero; empty when neither is. */
function formatSessionCost(cost: number, premiumRequests: number): string {
	if (!(cost > 0 || premiumRequests > 0)) return "";
	let section = `\n${theme.bold("Cost")}\n`;
	if (cost > 0) section += `${theme.fg("dim", "Total:")} ${cost.toFixed(4)}\n`;
	if (premiumRequests > 0) section += `${theme.fg("dim", "Premium Requests:")} ${premiumRequests.toLocaleString()}\n`;
	return section;
}

const LSP_STATUS_COLORS: Record<LspStartupServerInfo["status"], "success" | "dim" | "warning" | "error"> = {
	ready: "success",
	available: "dim",
	connecting: "warning",
	error: "error",
};

/** One line per language server with its status and file types; empty when the session started none. */
function formatLspServers(servers: LspStartupServerInfo[] | undefined): string {
	if (!servers || servers.length === 0) return "";
	let section = `\n${theme.bold("LSP Servers")}\n`;
	for (const server of servers) {
		const statusText =
			server.status === "error" && server.error ? `${server.status}: ${server.error}` : server.status;
		section += `${theme.fg("dim", `${server.name}:`)} ${theme.fg(LSP_STATUS_COLORS[server.status], statusText)} ${theme.fg("dim", `(${server.fileTypes.join(", ")})`)}\n`;
	}
	return section;
}

function resolveProviderAuthMode(authStorage: AuthStorage, provider: string): string {
	if (authStorage.hasOAuth(provider)) {
		return "oauth";
	}
	if (authStorage.has(provider)) {
		return "api key";
	}
	if (getEnvApiKey(provider)) {
		return "env api key";
	}
	if (authStorage.hasAuth(provider)) {
		return "runtime/fallback";
	}
	return "unknown";
}

export function renderProviderSection(details: ProviderDetails, uiTheme: Pick<typeof theme, "fg">): string {
	const lines: string[] = [];
	lines.push(`${uiTheme.fg("dim", "Name:")} ${details.provider}`);
	for (const field of details.fields) {
		lines.push(`${uiTheme.fg("dim", `${field.label}:`)} ${field.value}`);
	}
	return `${lines.join("\n")}\n`;
}
