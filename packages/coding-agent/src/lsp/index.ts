import * as fs from "node:fs";
import path from "node:path";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@veyyon/agent-core";
import { errorMessage, logger, prompt, truncate, untilAborted } from "@veyyon/utils";
import { isTimeoutError } from "@veyyon/utils/abortable";
import { isEnoent } from "@veyyon/utils/fs-error";
import { scopedTimeoutSignal } from "@veyyon/utils/scoped-timeout";
import { toolsPrompts } from "../prompts/tools/rows";
import { theme } from "../theme/theme-binding";
import type { ToolSession } from "../tools";
import { truncateForPrompt } from "../tools/core/approval";
import { formatGroupedDiagnosticMessages } from "../tools/core/grouped-file-output";
import { formatPathRelativeToCwd, resolveToCwd } from "../tools/core/path-utils";
// The leaf, not `tools/core/tool-result`: that module builds results and reaches 151 modules through
// `tools/core/output-meta`, and this only prepends a string to one already built.
import { prependResultNotice } from "../tools/core/result-notice";
import { ToolAbortError, ToolError, throwIfAborted } from "../tools/core/tool-errors";
import { clampTimeout, formatTimeoutClampNotice } from "../tools/core/tool-timeouts";
import {
	ensureFileOpen,
	getActiveClients,
	getOrCreateClient,
	type LspServerStatus,
	refreshFile,
	sendNotification,
	sendRequest,
	setIdleTimeout,
	WARMUP_TIMEOUT_MS,
	waitForProjectLoaded,
} from "./client";
import { getLinterClient } from "./clients";
import { getServersForFile, type LspConfig, loadConfig } from "./config";
import {
	BATCH_DIAGNOSTICS_WAIT_TIMEOUT_MS,
	SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS,
	waitForDiagnostics,
} from "./diagnostics";
import { applyWorkspaceEdit } from "./edits";
import { detectLspmux } from "./lspmux";
import {
	applyRenameEdits,
	coalesceRenameEdits,
	notifyRenamed,
	renamePreview,
	renameServers,
	requestRenameEdits,
	resolveRenameTarget,
} from "./rename-file";
import {
	forgetConfig,
	getConfig,
	getLspServerForFile,
	getLspServers,
	getLspServersForFile,
	isProjectAwareLspServer,
} from "./servers";
import {
	type CallHierarchyIncomingCall,
	type CallHierarchyItem,
	type CallHierarchyOutgoingCall,
	type CodeAction,
	type CodeActionContext,
	type Command,
	type Diagnostic,
	type DocumentSymbol,
	type Hover,
	type Location,
	type LocationLink,
	type LspClient,
	type LspParams,
	type LspToolDetails,
	lspSchema,
	type Position,
	type Range,
	type ServerConfig,
	SYMBOL_KIND_NAMES,
	type SymbolInformation,
	type WorkspaceEdit,
} from "./types";
import {
	applyCodeAction,
	dedupeWorkspaceSymbols,
	extractHoverText,
	fileToUri,
	filterWorkspaceSymbols,
	formatCodeAction,
	formatDiagnostic,
	formatDiagnosticsSummary,
	formatDocumentSymbol,
	formatLocation,
	formatSymbolInformation,
	formatWorkspaceEdit,
	rangeContainsPosition,
	readLocationContext,
	resolveDiagnosticTargets,
	resolveSymbolColumn,
	symbolKindToIcon,
	uniqueSortedDiagnostics,
	uriToFile,
} from "./utils";
import { lspToolView } from "./view";
import { runWorkspaceDiagnostics } from "./workspace-diagnostics";

export type { LspServerStatus } from "./client";
export { type FileDiagnosticsResult, FileFormatResult } from "./diagnostics";
export type { LspToolDetails } from "./types";
export * from "./writethrough";

/**
 * LSP actions that do not mutate the workspace or language-server state.
 * Anything not in this set (rename, code_actions with apply, rename_file,
 * reload, raw request, etc.) is classified as write-tier.
 */
export const LSP_READONLY_ACTIONS: ReadonlySet<string> = new Set([
	"diagnostics",
	"definition",
	"type_definition",
	"implementation",
	"incoming_calls",
	"outgoing_calls",
	"references",
	"hover",
	"symbols",
	"status",
	"capabilities",
]);

export interface LspStartupServerInfo {
	name: string;
	status: "connecting" | "ready" | "error" | "available";
	fileTypes: string[];
	error?: string;
}

/** Result from warming up LSP servers */
export interface LspWarmupResult {
	servers: Array<LspStartupServerInfo & { status: "ready" | "error" }>;
}

/** Options for warming up LSP servers */
export interface LspWarmupOptions {
	/** Called when starting to connect to servers */
	onConnecting?: (serverNames: string[]) => void;
}

export function discoverStartupLspServers(
	cwd: string,
	status: LspStartupServerInfo["status"] = "connecting",
): LspStartupServerInfo[] {
	const config = loadConfig(cwd);
	return getLspServers(config).map(([name, serverConfig]) => ({
		name,
		status,
		fileTypes: serverConfig.fileTypes,
	}));
}

/**
 * Warm up LSP servers for a directory by connecting to all detected servers.
 * This should be called at startup to avoid cold-start delays.
 *
 * @param cwd - Working directory to detect and start servers for
 * @param options - Optional callbacks for progress reporting
 * @returns Status of each server that was started
 */
export async function warmupLspServers(cwd: string, options?: LspWarmupOptions): Promise<LspWarmupResult> {
	const config = loadConfig(cwd);
	setIdleTimeout(config.idleTimeoutMs);
	const servers: LspWarmupResult["servers"] = [];
	const lspServers = getLspServers(config);

	// Notify caller which servers we're connecting to
	if (lspServers.length > 0 && options?.onConnecting) {
		options.onConnecting(lspServers.map(([name]) => name));
	}

	// Start all detected servers in parallel with a short timeout
	// Servers that don't respond quickly will be initialized lazily on first use
	const results = await Promise.allSettled(
		lspServers.map(async ([name, serverConfig]) => {
			const client = await getOrCreateClient(serverConfig, cwd, serverConfig.warmupTimeoutMs ?? WARMUP_TIMEOUT_MS);
			return { name, client, fileTypes: serverConfig.fileTypes };
		}),
	);

	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		const [name, serverConfig] = lspServers[i];
		if (result.status === "fulfilled") {
			servers.push({
				name: result.value.name,
				status: "ready",
				fileTypes: result.value.fileTypes,
			});
		} else {
			const errorMsg = result.reason?.message ?? String(result.reason);
			logger.warn("LSP server failed to start", { server: name, error: errorMsg });
			servers.push({
				name,
				status: "error",
				fileTypes: serverConfig.fileTypes,
				error: errorMsg,
			});
		}
	}

	return { servers };
}

/**
 * Get status of currently active LSP servers.
 */
export function getLspStatus(): LspServerStatus[] {
	return getActiveClients();
}

const MAX_GLOB_DIAGNOSTIC_TARGETS = 20;
const WORKSPACE_SYMBOL_LIMIT = 200;
const PROJECT_INDEXED_ACTIONS: ReadonlySet<string> = new Set([
	"definition",
	"type_definition",
	"implementation",
	"incoming_calls",
	"outgoing_calls",
	"references",
	"rename",
	"hover",
]);

/**
 * Actions a project-aware server answers for whatever identifier sits at the cursor. Without a `symbol`
 * the column falls back to the line's first non-blank character, which is often a decorator, keyword or
 * parameter, and the server answers plausibly for the wrong identifier.
 */
const SYMBOL_REQUIRED_ACTIONS: ReadonlySet<string> = new Set([
	"definition",
	"references",
	"rename",
	"incoming_calls",
	"outgoing_calls",
]);

const RUST_WORKSPACE_MARKERS = ["Cargo.toml", "rust-analyzer.toml"] as const;

/** True when the server is rust-analyzer by name or by the command it runs. */
function isRustAnalyzerServer(serverName: string, serverConfig: ServerConfig): boolean {
	return (
		serverName === "rust-analyzer" ||
		path.basename(serverConfig.command) === "rust-analyzer" ||
		(!!serverConfig.resolvedCommand && path.basename(serverConfig.resolvedCommand) === "rust-analyzer")
	);
}

function hasRustWorkspaceAncestor(filePath: string): boolean {
	let dir = path.dirname(filePath);
	while (true) {
		for (const marker of RUST_WORKSPACE_MARKERS) {
			if (fs.existsSync(path.join(dir, marker))) {
				return true;
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			return false;
		}
		dir = parent;
	}
}

const LOCATION_CONTEXT_LINES = 1;
const REFERENCE_CONTEXT_LIMIT = 50;

const REFERENCES_RETRY_COUNT = 2;
const REFERENCES_RETRY_DELAY_MS = 250;

function isOnlyQueriedDeclaration(locations: Location[], uri: string, position: Position): boolean {
	return locations.length === 1 && locations[0]?.uri === uri && rangeContainsPosition(locations[0].range, position);
}

function normalizeLocationResult(result: Location | Location[] | LocationLink | LocationLink[] | null): Location[] {
	if (!result) return [];
	const raw = Array.isArray(result) ? result : [result];
	return raw.flatMap(loc => {
		if ("uri" in loc) {
			return [loc as Location];
		}
		if ("targetUri" in loc) {
			const link = loc as LocationLink;
			return [{ uri: link.targetUri, range: link.targetSelectionRange ?? link.targetRange }];
		}
		return [];
	});
}

async function formatLocationWithContext(location: Location, cwd: string): Promise<string> {
	const header = `  ${formatLocation(location, cwd)}`;
	const context = await readLocationContext(
		uriToFile(location.uri),
		location.range.start.line + 1,
		LOCATION_CONTEXT_LINES,
	);
	if (context.length === 0) {
		return header;
	}
	return `${header}\n${context.map(lineText => `    ${lineText}`).join("\n")}`;
}

/** A file-bound action's request context: the file's started server, the opened file and the resolved cursor. */
interface FileQuery {
	readonly client: LspClient;
	readonly serverConfig: ServerConfig;
	readonly file: string;
	readonly uri: string;
	readonly position: Position;
	readonly cwd: string;
	readonly signal: AbortSignal;
}

/** A file-bound action's text, and whether it is a bare empty lookup that compaction may elide. */
interface ActionReport {
	readonly output: string;
	readonly useless?: true;
}

const LOCATION_LOOKUPS = {
	definition: { method: "textDocument/definition", noun: "definition" },
	type_definition: { method: "textDocument/typeDefinition", noun: "type definition" },
	implementation: { method: "textDocument/implementation", noun: "implementation" },
} as const;

/** `definition`, `type_definition` and `implementation`: one position request answered by a location list. */
async function locateAt(
	{ client, uri, position, cwd, signal }: FileQuery,
	{ method, noun }: (typeof LOCATION_LOOKUPS)[keyof typeof LOCATION_LOOKUPS],
): Promise<ActionReport> {
	const result = (await sendRequest(client, method, { textDocument: { uri }, position }, signal)) as
		| Location
		| Location[]
		| LocationLink
		| LocationLink[]
		| null;
	const locations = normalizeLocationResult(result);
	if (locations.length === 0) return { output: `No ${noun} found`, useless: true };
	const lines = await Promise.all(locations.map(location => formatLocationWithContext(location, cwd)));
	return { output: `Found ${locations.length} ${noun}(s):\n${lines.join("\n")}` };
}

/**
 * The references to the symbol at the cursor. A project-aware server answers nothing, or only the queried
 * declaration, until its index is loaded, so it is asked again up to `REFERENCES_RETRY_COUNT` times.
 */
async function queryReferences({ client, serverConfig, uri, position, signal }: FileQuery): Promise<Location[] | null> {
	const projectAware = isProjectAwareLspServer(serverConfig);
	for (let attempt = 0; ; attempt++) {
		const result = (await sendRequest(
			client,
			"textDocument/references",
			{ textDocument: { uri }, position, context: { includeDeclaration: true } },
			signal,
		)) as Location[] | null;
		if (!projectAware || attempt === REFERENCES_RETRY_COUNT) return result;
		if (result?.length && !isOnlyQueriedDeclaration(result, uri, position)) return result;
		await waitForProjectLoaded(client, signal);
		throwIfAborted(signal);
		await untilAborted(signal, () => Bun.sleep(REFERENCES_RETRY_DELAY_MS));
	}
}

/** `references`: every reference, the first `REFERENCE_CONTEXT_LIMIT` with the line either side. */
async function findReferences(query: FileQuery): Promise<ActionReport> {
	const references = await queryReferences(query);
	if (!references || references.length === 0) return { output: "No references found", useless: true };
	const lines = await Promise.all(
		references.slice(0, REFERENCE_CONTEXT_LIMIT).map(location => formatLocationWithContext(location, query.cwd)),
	);
	if (references.length > REFERENCE_CONTEXT_LIMIT) {
		lines.push(`  ... ${references.length - REFERENCE_CONTEXT_LIMIT} additional reference(s) shown without context`);
		for (let i = REFERENCE_CONTEXT_LIMIT; i < references.length; i++) {
			lines.push(`  ${formatLocation(references[i]!, query.cwd)}`);
		}
	}
	return { output: `Found ${references.length} reference(s):\n${lines.join("\n")}` };
}

/** `hover`: the server's markup for the symbol at the cursor. An empty hover is an answer, not a useless lookup. */
async function hoverAt({ client, uri, position, signal }: FileQuery): Promise<ActionReport> {
	const result = (await sendRequest(
		client,
		"textDocument/hover",
		{ textDocument: { uri }, position },
		signal,
	)) as Hover | null;
	return { output: result?.contents ? extractHoverText(result.contents) : "No hover information" };
}

const CALL_DIRECTIONS = {
	incoming_calls: { method: "callHierarchy/incomingCalls", noun: "caller", relation: "of" },
	outgoing_calls: { method: "callHierarchy/outgoingCalls", noun: "callee", relation: "from" },
} as const;

type CallDirection = (typeof CALL_DIRECTIONS)[keyof typeof CALL_DIRECTIONS];

/** A call hierarchy item as its row: its name, its kind, and where it is declared. */
function formatCallItem(item: CallHierarchyItem, cwd: string): string {
	const kind = SYMBOL_KIND_NAMES[item.kind] ?? "Symbol";
	return `${item.name} (${kind}) at ${formatLocation({ uri: item.uri, range: item.selectionRange }, cwd)}`;
}

/**
 * The lines of the files a call hierarchy answer cites, each file read once however many call sites
 * it holds. A file that no longer exists reads as no lines, and its call sites as bare positions.
 */
function callSiteReader(): (uri: string) => Promise<readonly string[]> {
	const files = new Map<string, Promise<readonly string[]>>();
	return uri => {
		let lines = files.get(uri);
		if (!lines) {
			lines = fs.promises.readFile(uriToFile(uri), "utf8").then(
				text => text.split("\n"),
				(error: unknown) => {
					if (isEnoent(error)) return [];
					throw error;
				},
			);
			files.set(uri, lines);
		}
		return lines;
	};
}

/** One call site as `line:col: source`, the source line as the file holds it. */
function formatCallSite(range: Range, lines: readonly string[]): string {
	const at = `${range.start.line + 1}:${range.start.character + 1}`;
	const source = lines[range.start.line];
	return source === undefined ? at : `${at}: ${source.trim()}`;
}

/**
 * `incoming_calls` and `outgoing_calls`: the functions that call the symbol at the cursor, or the
 * functions it calls, each with its call sites. The server resolves each call to its declaration,
 * so a call through a re-export or an alias is attributed to the function it reaches, a comment or
 * string naming the function is not a call, and each implementation of an interface method is its
 * own item.
 */
async function callsAt(
	{ client, uri, position, cwd, signal }: FileQuery,
	{ method, noun, relation }: CallDirection,
): Promise<ActionReport> {
	const items = (await sendRequest(
		client,
		"textDocument/prepareCallHierarchy",
		{ textDocument: { uri }, position },
		signal,
	)) as CallHierarchyItem[] | null;
	if (!items || items.length === 0) return { output: "No callable symbol at this position", useless: true };

	const readLines = callSiteReader();
	const sections: string[] = [];
	let total = 0;
	for (const item of items) {
		const calls = (await sendRequest(client, method, { item }, signal)) as
			| (CallHierarchyIncomingCall | CallHierarchyOutgoingCall)[]
			| null;
		const subject = formatCallItem(item, cwd);
		if (!calls || calls.length === 0) {
			sections.push(`No ${noun}s ${relation} ${subject}`);
			continue;
		}
		total += calls.length;
		const rows = [`Found ${calls.length} ${noun}(s) ${relation} ${subject}:`];
		for (const call of calls) {
			// An incoming call's sites are in the caller; an outgoing call's are in the prepared item.
			const [other, siteUri] = "from" in call ? [call.from, call.from.uri] : [call.to, item.uri];
			rows.push(`  ${formatCallItem(other, cwd)}`);
			const lines = await readLines(siteUri);
			// A server may list one call site more than once (tsserver does for a method call); the
			// repeat is the same position and is listed once.
			const sites = new Set(call.fromRanges.map(range => formatCallSite(range, lines)));
			for (const site of sites) rows.push(`    ${site}`);
		}
		sections.push(rows.join("\n"));
	}
	return total === 0 ? { output: sections.join("\n"), useless: true } : { output: sections.join("\n\n") };
}

/** One row per code action, numbered by the index `apply` selects it with. */
function listCodeActions(actions: readonly (CodeAction | Command)[]): string {
	return actions.map((action, index) => `  ${formatCodeAction(action, index)}`).join("\n");
}

/** `code_actions`: the actions offered at the cursor or, with `apply`, the one `selector` names applied. */
async function codeActionsAt(
	query: FileQuery,
	selector: string | undefined,
	apply: boolean | undefined,
): Promise<ActionReport> {
	const { client, uri, position, signal } = query;
	const context: CodeActionContext = {
		diagnostics: client.diagnostics.get(uri)?.diagnostics ?? [],
		only: !apply && selector ? [selector] : undefined,
		triggerKind: 1,
	};
	const actions = (await sendRequest(
		client,
		"textDocument/codeAction",
		{ textDocument: { uri }, range: { start: position, end: position }, context },
		signal,
	)) as (CodeAction | Command)[] | null;
	if (!actions || actions.length === 0) return { output: "No code actions available" };
	if (apply === true && selector) return { output: await applySelectedCodeAction(query, actions, selector) };
	return { output: `${actions.length} code action(s):\n${listCodeActions(actions)}` };
}

/**
 * Applies the code action `selector` names, by index or by a case-insensitive title substring, resolving
 * it first when it arrived without its edit, and reports the edits it wrote and the commands it ran.
 */
async function applySelectedCodeAction(
	{ client, cwd, signal }: FileQuery,
	actions: readonly (CodeAction | Command)[],
	selector: string,
): Promise<string> {
	const needle = selector.trim();
	if (needle.length === 0) return "Error: query parameter required when apply=true for code_actions";
	const lowered = needle.toLowerCase();
	const selected = /^\d+$/.test(needle)
		? actions[Number.parseInt(needle, 10)]
		: actions.find(action => action.title.toLowerCase().includes(lowered));
	if (!selected) return `No code action matches "${needle}". Available actions:\n${listCodeActions(actions)}`;

	const applied = await applyCodeAction(selected, {
		resolveCodeAction: async action =>
			(await sendRequest(client, "codeAction/resolve", action, signal)) as CodeAction,
		applyWorkspaceEdit: async edit => applyWorkspaceEdit(edit, cwd),
		executeCommand: async command => {
			await sendRequest(
				client,
				"workspace/executeCommand",
				{ command: command.command, arguments: command.arguments ?? [] },
				signal,
			);
		},
	});
	if (!applied) return `Action "${selected.title}" has no workspace edit or command to apply`;

	const lines = [`Applied "${applied.title}":`];
	if (applied.edits.length > 0) {
		lines.push("  Workspace edit:");
		for (const edit of applied.edits) lines.push(`    ${edit}`);
	}
	if (applied.executedCommands.length > 0) {
		lines.push("  Executed command(s):");
		for (const command of applied.executedCommands) lines.push(`    ${command}`);
	}
	return lines.join("\n");
}

/** `symbols` for one file: its symbol tree, or its flat symbol list by line. */
async function documentSymbols({ client, file, uri, cwd, signal }: FileQuery): Promise<ActionReport> {
	const result = (await sendRequest(client, "textDocument/documentSymbol", { textDocument: { uri } }, signal)) as
		| (DocumentSymbol | SymbolInformation)[]
		| null;
	if (!result || result.length === 0) return { output: "No symbols found", useless: true };
	const lines =
		"selectionRange" in result[0]
			? (result as DocumentSymbol[]).flatMap(symbol => formatDocumentSymbol(symbol))
			: (result as SymbolInformation[]).map(
					symbol =>
						`${symbolKindToIcon(symbol.kind)} ${symbol.name} @ line ${symbol.location.range.start.line + 1}`,
				);
	return { output: `Symbols in ${formatPathRelativeToCwd(file, cwd)}:\n${lines.join("\n")}` };
}

/** `rename`: the workspace edit renaming the symbol at the cursor, written unless `apply` is false. */
async function renameAt(
	{ client, uri, position, cwd, signal }: FileQuery,
	newName: string,
	apply: boolean | undefined,
): Promise<ActionReport> {
	const edit = (await sendRequest(
		client,
		"textDocument/rename",
		{ textDocument: { uri }, position, newName },
		signal,
	)) as WorkspaceEdit | null;
	if (!edit) return { output: "Rename returned no edits" };
	if (apply === false) {
		const preview = formatWorkspaceEdit(edit, cwd);
		return { output: `Rename preview:\n${preview.map(line => `  ${line}`).join("\n")}` };
	}
	const applied = await applyWorkspaceEdit(edit, cwd);
	return { output: `Applied rename:\n${applied.map(line => `  ${line}`).join("\n")}` };
}

async function reloadServer(client: LspClient, serverName: string, signal?: AbortSignal): Promise<string> {
	// rust-analyzer exposes a real reload request.
	try {
		await sendRequest(client, "rust-analyzer/reloadWorkspace", null, signal);
		return `Reloaded ${serverName}`;
	} catch {
		// Method not supported — fall through.
	}
	// workspace/didChangeConfiguration is a notification per spec; sending it
	// as a request hangs until the tool deadline on servers that route it to
	// the notification handler and never respond.
	try {
		await sendNotification(client, "workspace/didChangeConfiguration", { settings: {} }, signal);
		return `Reloaded ${serverName}`;
	} catch {
		client.proc.kill();
		return `Restarted ${serverName}`;
	}
}

/**
 * LSP tool for language server protocol operations.
 */
export class LspTool implements AgentTool<typeof lspSchema.value, LspToolDetails> {
	readonly name = "lsp";
	readonly view = lspToolView;
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const rawAction = (args as Partial<LspParams>).action;
		const action = typeof rawAction === "string" ? rawAction.toLowerCase() : "";
		return LSP_READONLY_ACTIONS.has(action) ? "read" : "write";
	};
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<LspParams>;
		const lines = [`Action: ${typeof params.action === "string" ? params.action : "(missing)"}`];
		if (typeof params.file === "string" && params.file.length > 0) {
			lines.push(`File: ${truncateForPrompt(params.file)}`);
		}
		return lines;
	};
	readonly label = "LSP";
	readonly loadMode = "discoverable";
	readonly summary = "Query LSP (language server) for diagnostics, hover info, and references";
	readonly description: string;
	get parameters(): typeof lspSchema.value {
		return lspSchema.value;
	}
	readonly strict = true;

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(toolsPrompts["tools/lsp"].text);
	}

	static createIf(session: ToolSession): LspTool | null {
		if (session.enableLsp === false) return null;
		if (!session.settings.get("lsp.enabled")) return null;
		if (!session.settings.get("lsp.tool")) return null;
		return new LspTool(session);
	}

	async execute(
		_toolCallId: string,
		params: LspParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<LspToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<LspToolDetails>> {
		const timeoutSec = clampTimeout("lsp", params.timeout, this.session.settings.get("tools.maxTimeout"));
		// A clamp changes the budget the agent asked for; surface it on the result
		// rather than applying it silently (Law 10). LSP actions each build their
		// own result, so we prepend the notice here in the one shared wrapper.
		const clampNotice = formatTimeoutClampNotice("lsp", params.timeout, timeoutSec);
		const operationTimeout = scopedTimeoutSignal(timeoutSec * 1000, signal);
		try {
			const result = await this.#executeWithSignal(params, operationTimeout.signal, signal, timeoutSec);
			return clampNotice ? prependResultNotice(result, clampNotice) : result;
		} finally {
			operationTimeout.cancel();
		}
	}

	async #executeWithSignal(
		params: LspParams,
		signal: AbortSignal,
		callerSignal: AbortSignal | undefined,
		timeoutSec: number,
	): Promise<AgentToolResult<LspToolDetails>> {
		const { action, file } = params;
		throwIfAborted(signal);

		const config = getConfig(this.session.cwd);

		// These actions take no file, or resolve their own targets.
		switch (action) {
			case "status":
				return this.#status(params, config);
			case "diagnostics":
				return this.#diagnostics(params, config, signal, timeoutSec);
			case "rename_file":
				return this.#renameFile(params, config, signal);
			case "capabilities":
				return this.#capabilities(params, config, signal);
			case "request":
				return this.#request(params, config, signal);
		}

		// `*` means workspace scope for symbols/reload; other actions need a concrete file.
		if (!file && action !== "reload") {
			return {
				content: [
					{
						type: "text",
						text: "Error: file parameter required. Use `*` for workspace scope where supported.",
					},
				],
				details: { action, success: false },
			};
		}

		const resolvedFile = file && file !== "*" ? resolveToCwd(file, this.session.cwd) : null;
		if (action === "symbols" && !resolvedFile) {
			return this.#workspaceSymbols(params, config, signal);
		}
		if (action === "reload" && !resolvedFile) {
			return this.#workspaceReload(params, signal);
		}

		const serverInfo = resolvedFile ? getLspServerForFile(config, resolvedFile) : null;
		if (!resolvedFile || !serverInfo) {
			return {
				content: [{ type: "text", text: "No language server found for this action" }],
				details: { action, success: false },
			};
		}

		const [serverName, serverConfig] = serverInfo;
		try {
			const query = await this.#openFileQuery(params, serverName, serverConfig, resolvedFile, signal);
			return await runFileAction(params, query, serverName);
		} catch (err) {
			if (err instanceof ToolError) throw err;
			if (err instanceof ToolAbortError || signal.aborted) {
				// Distinguish a wall-clock timeout from a caller cancel:
				// callerSignal aborting → real cancel (re-throw ToolAbortError);
				// timeoutSignal aborting without callerSignal → emit a ToolError naming the
				// elapsed budget and server, instead of opaque "Operation aborted".
				if (isTimeoutError(signal.reason) && !callerSignal?.aborted) {
					throw new ToolError(
						`LSP ${action} timed out after ${timeoutSec}s on ${serverName}. The server may still be indexing; try again or pass timeout=<larger>.`,
					);
				}
				throw new ToolAbortError();
			}
			return {
				content: [{ type: "text", text: `LSP error: ${errorMessage(err)}` }],
				details: { serverName, action, success: false, request: params },
			};
		}
	}

	/**
	 * Starts the server for `file`, opens the file, waits for the project where the action reads the
	 * server's index, and resolves the cursor from `line` and `symbol`.
	 */
	async #openFileQuery(
		params: LspParams,
		serverName: string,
		serverConfig: ServerConfig,
		file: string,
		signal: AbortSignal,
	): Promise<FileQuery> {
		const { action, line, symbol } = params;
		const client = await getOrCreateClient(serverConfig, this.session.cwd, undefined, signal);
		const projectAware = isProjectAwareLspServer(serverConfig);
		const needsProjectIndex = projectAware && PROJECT_INDEXED_ACTIONS.has(action);
		const rustAnalyzer = isRustAnalyzerServer(serverName, serverConfig);

		// rust-analyzer loads a Cargo workspace only once one of its files is open, so it waits after the open.
		await ensureFileOpen(client, file, signal);
		if (needsProjectIndex && rustAnalyzer && hasRustWorkspaceAncestor(file)) {
			await waitForProjectLoaded(client, signal);
		}

		if (line !== undefined && !symbol && projectAware && SYMBOL_REQUIRED_ACTIONS.has(action)) {
			throw new ToolError(
				`symbol is required for project-aware ${action}; pass symbol=<name>, optionally symbol#N for repeated occurrences`,
			);
		}
		const resolvedLine = line ?? 1;
		const position = { line: resolvedLine - 1, character: await resolveSymbolColumn(file, resolvedLine, symbol) };

		if (needsProjectIndex && !rustAnalyzer) {
			await waitForProjectLoaded(client, signal);
		}
		return { client, serverConfig, file, uri: fileToUri(file), position, cwd: this.session.cwd, signal };
	}

	/** `status`: the servers configured for this project and which of them have started. */
	async #status(params: LspParams, config: LspConfig): Promise<AgentToolResult<LspToolDetails>> {
		const { action } = params;
		const configuredNames = Object.keys(config.servers);
		const lspmuxState = await detectLspmux();
		const lspmuxStatus = lspmuxState.available
			? lspmuxState.running
				? "lspmux: active (multiplexing enabled)"
				: "lspmux: installed but server not running"
			: "";

		// `Object.keys(config.servers)` reflects what is *configured & resolvable
		// on PATH* — it does NOT prove the server actually starts. A wrapper
		// binary that exits immediately (e.g. rustup without the rust-analyzer
		// component) still appears here. Distinguish "configured" from
		// "started" (have a live in-process client) so callers cannot mistake
		// presence-on-PATH for a working server.
		const startedClients = getActiveClients();
		const startedByConfigName = new Map<string, LspServerStatus>();
		// getActiveClients() reports `name = client.config.command` (the
		// unresolved binary name from defaults.json), so match against
		// `serverConfig.command`, not the resolved path.
		for (const [name, serverConfig] of Object.entries(config.servers)) {
			const matched = startedClients.find(c => c.name === serverConfig.command);
			if (matched) startedByConfigName.set(name, matched);
		}

		const lines: string[] = [];
		if (configuredNames.length === 0) {
			lines.push("No language servers configured for this project");
		} else {
			const labelled = configuredNames.map(name => {
				const started = startedByConfigName.get(name);
				if (!started) return `${name} (configured, not started)`;
				return `${name} (${started.status})`;
			});
			lines.push(`Language servers: ${labelled.join(", ")}`);
			lines.push(
				"  note: 'configured, not started' means the binary resolves on PATH but no request has spawned it yet; 'ready' means a client process is live for this cwd.",
			);
		}
		if (lspmuxStatus) lines.push(lspmuxStatus);

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { action, success: true, request: params },
		};
	}

	/** `diagnostics`: one file, a batch, or `*` for the whole workspace, across every applicable server. */
	async #diagnostics(
		params: LspParams,
		config: LspConfig,
		signal: AbortSignal,
		timeoutSec: number,
	): Promise<AgentToolResult<LspToolDetails>> {
		const { action, file } = params;
		if (file === "*") {
			// `*` => run workspace diagnostics across all configured servers
			const result = await runWorkspaceDiagnostics(this.session.cwd, signal);
			return {
				content: [
					{
						type: "text",
						text: `Workspace diagnostics (${result.projectType.description}):\n${result.output}`,
					},
				],
				details: { action, success: true, request: params },
			};
		}

		if (!file) {
			return {
				content: [
					{
						type: "text",
						text: "Error: file parameter required. Use `*` for workspace-wide diagnostics or a path/glob for specific files.",
					},
				],
				details: { action, success: false, request: params },
			};
		}

		let targets: string[];
		let truncatedGlobTargets = false;
		const resolvedTargets = await resolveDiagnosticTargets(file, this.session.cwd, MAX_GLOB_DIAGNOSTIC_TARGETS);
		targets = resolvedTargets.matches;
		truncatedGlobTargets = resolvedTargets.truncated;

		if (targets.length === 0) {
			return {
				content: [{ type: "text", text: `No files matched pattern: ${file}` }],
				details: { action, success: true, request: params },
			};
		}

		const detailed = targets.length > 1 || truncatedGlobTargets;
		const diagnosticsWaitTimeoutMs = detailed
			? Math.min(BATCH_DIAGNOSTICS_WAIT_TIMEOUT_MS, timeoutSec * 1000)
			: Math.min(SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS, timeoutSec * 1000);
		const results: string[] = [];
		const allServerNames = new Set<string>();
		if (truncatedGlobTargets) {
			results.push(
				`${theme.status.warning} Pattern matched more than ${MAX_GLOB_DIAGNOSTIC_TARGETS} files; showing first ${MAX_GLOB_DIAGNOSTIC_TARGETS}. Narrow the glob or use workspace diagnostics.`,
			);
		}

		for (const target of targets) {
			throwIfAborted(signal);
			const resolved = resolveToCwd(target, this.session.cwd);
			const servers = getServersForFile(config, resolved);
			if (servers.length === 0) {
				results.push(`${theme.status.error} ${target}: No language server found`);
				continue;
			}

			const uri = fileToUri(resolved);
			const relPath = formatPathRelativeToCwd(resolved, this.session.cwd);
			const allDiagnostics: Diagnostic[] = [];
			// A server that failed is named with its error, so a file no checker could read is not reported clean.
			const answered: string[] = [];
			const serverNotes: string[] = [];

			// Query all applicable servers for this file
			for (const [serverName, serverConfig] of servers) {
				allServerNames.add(serverName);
				try {
					throwIfAborted(signal);
					if (serverConfig.createClient) {
						const linterClient = getLinterClient(serverName, serverConfig, this.session.cwd);
						const diagnostics = await linterClient.lint(resolved);
						for (let di = 0; di < diagnostics.length; di++) allDiagnostics.push(diagnostics[di]!);
						answered.push(serverName);
						continue;
					}
					const client = await getOrCreateClient(serverConfig, this.session.cwd, undefined, signal);
					const minVersion = client.diagnosticsVersion;
					// Opened before the project-load wait: tsserver loads no project, and reports no
					// progress, until one of its files is open.
					await refreshFile(client, resolved, signal);
					if (isProjectAwareLspServer(serverConfig)) {
						await waitForProjectLoaded(client, signal);
						throwIfAborted(signal);
					}
					const expectedDocumentVersion = client.openFiles.get(uri)?.version;
					const diagnostics = await waitForDiagnostics(client, uri, {
						timeoutMs: diagnosticsWaitTimeoutMs,
						signal,
						minVersion,
						expectedDocumentVersion,
					});
					for (let di = 0; di < diagnostics.length; di++) allDiagnostics.push(diagnostics[di]!);
					answered.push(serverName);
				} catch (err) {
					if (err instanceof ToolAbortError || signal?.aborted) {
						throw err;
					}
					serverNotes.push(`  ${serverName}: ${errorMessage(err)}`);
				}
			}

			const uniqueDiagnostics = uniqueSortedDiagnostics(allDiagnostics);
			const notes = serverNotes.length > 0 ? ["  Server notes:", ...serverNotes] : [];
			const from = notes.length > 0 ? ` from ${answered.join(", ")}` : "";

			if (!detailed && targets.length === 1) {
				let text: string;
				if (uniqueDiagnostics.length > 0) {
					const formatted = uniqueDiagnostics.map(d => formatDiagnostic(d, relPath));
					text = `${formatDiagnosticsSummary(uniqueDiagnostics)}:\n${formatGroupedDiagnosticMessages(formatted)}`;
				} else if (answered.length === 0) {
					text = "No server checked the file";
				} else {
					text = notes.length === 0 ? "OK" : `No issues${from}`;
				}
				return {
					content: [{ type: "text", text: [text, ...notes].join("\n") }],
					details: {
						action,
						serverName: Array.from(allServerNames).join(", "),
						success: answered.length > 0,
					},
				};
			}

			if (uniqueDiagnostics.length > 0) {
				const summary = formatDiagnosticsSummary(uniqueDiagnostics);
				results.push(`${theme.status.error} ${relPath}: ${summary}`);
				const formatted = uniqueDiagnostics.map(d => formatDiagnostic(d, relPath));
				results.push(formatGroupedDiagnosticMessages(formatted));
			} else if (answered.length === 0) {
				results.push(`${theme.status.error} ${relPath}: no server checked the file`);
			} else {
				results.push(`${theme.status.success} ${relPath}: no issues${from}`);
			}
			results.push(...notes);
		}

		return {
			content: [{ type: "text", text: results.join("\n") }],
			details: { action, serverName: Array.from(allServerNames).join(", "), success: true },
		};
	}

	/** `rename_file`: move a file and apply the import edits its servers propose. */
	async #renameFile(
		params: LspParams,
		config: LspConfig,
		signal: AbortSignal,
	): Promise<AgentToolResult<LspToolDetails>> {
		const { action, apply } = params;
		const cwd = this.session.cwd;
		const target = await resolveRenameTarget(params.file, params.new_name, cwd);
		if (typeof target === "string") {
			return {
				content: [{ type: "text", text: target }],
				details: { action, success: false, request: params },
			};
		}

		const lspParams = { files: target.pairs };
		const servers = renameServers(config, target);
		const proposals = await requestRenameEdits(servers, lspParams, cwd, signal);
		const sourceLabel = formatPathRelativeToCwd(target.source, cwd);
		const destLabel = formatPathRelativeToCwd(target.dest, cwd);
		const pairCount = target.pairs.length;
		const fileCountLabel = target.directory
			? `${pairCount} file${pairCount !== 1 ? "s" : ""} under ${sourceLabel}`
			: sourceLabel;
		const details: LspToolDetails = {
			action,
			serverName: Array.from(proposals.respondingServers).join(", "),
			success: true,
			request: params,
		};
		if (apply === false) {
			return {
				content: [{ type: "text", text: renamePreview(`${fileCountLabel} → ${destLabel}`, proposals, cwd) }],
				details,
			};
		}

		const summary = await applyRenameEdits(coalesceRenameEdits(proposals.perServerEdits, servers), cwd);
		await fs.promises.mkdir(path.dirname(target.dest), { recursive: true });
		await fs.promises.rename(target.source, target.dest);
		summary.push(`  Renamed ${sourceLabel} → ${destLabel}`);
		const notes = proposals.serverNotes.concat(await notifyRenamed(servers, lspParams, cwd, signal));
		if (notes.length > 0) {
			summary.push("  Server notes:", ...notes);
		}
		return {
			content: [{ type: "text", text: `Renamed ${fileCountLabel} → ${destLabel}\n${summary.join("\n")}` }],
			details,
		};
	}

	/** `capabilities`: what the servers for a file, or every configured server, advertise. */
	async #capabilities(
		params: LspParams,
		config: LspConfig,
		signal: AbortSignal,
	): Promise<AgentToolResult<LspToolDetails>> {
		const { action, file } = params;
		let serverList: Array<[string, ServerConfig]>;
		if (file && file !== "*") {
			const resolved = resolveToCwd(file, this.session.cwd);
			serverList = getLspServersForFile(config, resolved);
			if (serverList.length === 0) {
				return {
					content: [{ type: "text", text: "No language server found for this file" }],
					details: { action, success: false, request: params },
				};
			}
		} else {
			serverList = getLspServers(config);
		}

		if (serverList.length === 0) {
			return {
				content: [{ type: "text", text: "No language servers configured" }],
				details: { action, success: false, request: params },
			};
		}

		const sections: string[] = [];
		const respondingServers = new Set<string>();
		for (const [serverName, serverConfig] of serverList) {
			throwIfAborted(signal);
			try {
				const client = await getOrCreateClient(serverConfig, this.session.cwd, undefined, signal);
				respondingServers.add(serverName);
				const caps = client.serverCapabilities ?? {};
				sections.push(`${serverName}:`);
				sections.push(`  capabilities: ${JSON.stringify(caps, null, 2).split("\n").join("\n  ")}`);
			} catch (err) {
				if (err instanceof ToolAbortError || signal?.aborted) {
					throw err;
				}
				const msg = errorMessage(err);
				sections.push(`${serverName}: failed to start (${msg})`);
			}
		}

		return {
			content: [{ type: "text", text: sections.join("\n") }],
			details: {
				action,
				serverName: Array.from(respondingServers).join(", "),
				success: true,
				request: params,
			},
		};
	}

	/** `request`: a raw LSP method sent to the server for a file. */
	async #request(params: LspParams, config: LspConfig, signal: AbortSignal): Promise<AgentToolResult<LspToolDetails>> {
		const { action, file, line, symbol, query } = params;
		const method = query?.trim();
		if (!method) {
			return {
				content: [
					{
						type: "text",
						text: "Error: action=request requires `query` to specify the LSP method name (e.g., 'rust-analyzer/expandMacro')",
					},
				],
				details: { action, success: false, request: params },
			};
		}

		let chosenServer: [string, ServerConfig] | null = null;
		let resolvedTarget: string | null = null;
		if (file && file !== "*") {
			resolvedTarget = resolveToCwd(file, this.session.cwd);
			chosenServer = getLspServerForFile(config, resolvedTarget);
			if (!chosenServer) {
				return {
					content: [{ type: "text", text: "No language server found for this file" }],
					details: { action, success: false, request: params },
				};
			}
		} else {
			const all = getLspServers(config);
			if (all.length === 0) {
				return {
					content: [{ type: "text", text: "No language servers configured" }],
					details: { action, success: false, request: params },
				};
			}
			chosenServer = all[0];
		}

		const [chosenName, chosenConfig] = chosenServer;
		let requestParams: unknown;
		if (params.payload !== undefined) {
			try {
				requestParams = JSON.parse(params.payload);
			} catch (err) {
				const msg = errorMessage(err);
				return {
					content: [{ type: "text", text: `Error: invalid JSON in payload: ${msg}` }],
					details: { action, serverName: chosenName, success: false, request: params },
				};
			}
		} else if (resolvedTarget) {
			const uri = fileToUri(resolvedTarget);
			if (line !== undefined) {
				const character = await resolveSymbolColumn(resolvedTarget, line, symbol);
				requestParams = { textDocument: { uri }, position: { line: line - 1, character } };
			} else {
				requestParams = { textDocument: { uri } };
			}
		} else {
			requestParams = {};
		}

		try {
			const client = await getOrCreateClient(chosenConfig, this.session.cwd, undefined, signal);
			if (resolvedTarget) {
				await ensureFileOpen(client, resolvedTarget, signal);
			}
			const result = await sendRequest(client, method, requestParams, signal);
			const formatted =
				result === null || result === undefined
					? "null"
					: typeof result === "string"
						? result
						: JSON.stringify(result, null, 2);
			return {
				content: [{ type: "text", text: `${chosenName} ← ${method}:\n${formatted}` }],
				details: { action, serverName: chosenName, success: true, request: params },
			};
		} catch (err) {
			if (err instanceof ToolAbortError || signal?.aborted) {
				throw new ToolAbortError();
			}
			const msg = errorMessage(err);
			// Echo a (truncated) preview of the params we sent so the caller can
			// tell parse / shape errors (e.g. nested args dropped, missing field)
			// apart from genuine server errors without spinning up another debug call.
			const previewRaw = JSON.stringify(requestParams ?? null);
			const preview = truncate(previewRaw, 400, "...");
			return {
				content: [
					{ type: "text", text: `LSP error from ${chosenName} on ${method}: ${msg}\n  params: ${preview}` },
				],
				details: { action, serverName: chosenName, success: false, request: params },
			};
		}
	}

	/** `symbols` at workspace scope: a workspace-symbol query across every server. */
	async #workspaceSymbols(
		params: LspParams,
		config: LspConfig,
		signal: AbortSignal,
	): Promise<AgentToolResult<LspToolDetails>> {
		const { action, query } = params;
		const normalizedQuery = query?.trim();
		if (!normalizedQuery) {
			return {
				content: [{ type: "text", text: "Error: query parameter required for workspace symbol search" }],
				details: { action, success: false, request: params },
			};
		}
		const servers = getLspServers(config);
		if (servers.length === 0) {
			return {
				content: [{ type: "text", text: "No language server found for this action" }],
				details: { action, success: false, request: params },
			};
		}
		const aggregatedSymbols: SymbolInformation[] = [];
		const respondingServers = new Set<string>();
		for (const [workspaceServerName, workspaceServerConfig] of servers) {
			throwIfAborted(signal);
			try {
				const workspaceClient = await getOrCreateClient(workspaceServerConfig, this.session.cwd, undefined, signal);
				const workspaceResult = (await sendRequest(
					workspaceClient,
					"workspace/symbol",
					{ query: normalizedQuery },
					signal,
				)) as SymbolInformation[] | null;
				if (!workspaceResult || workspaceResult.length === 0) {
					continue;
				}
				respondingServers.add(workspaceServerName);
				const filtered = filterWorkspaceSymbols(workspaceResult, normalizedQuery);
				for (let si = 0; si < filtered.length; si++) aggregatedSymbols.push(filtered[si]!);
			} catch (err) {
				if (err instanceof ToolAbortError || signal?.aborted) {
					throw err;
				}
			}
		}
		const dedupedSymbols = dedupeWorkspaceSymbols(aggregatedSymbols);
		if (dedupedSymbols.length === 0) {
			return {
				content: [{ type: "text", text: `No symbols matching "${normalizedQuery}"` }],
				details: {
					action,
					serverName: Array.from(respondingServers).join(", "),
					success: true,
					request: params,
				},
			};
		}
		const limitedSymbols = dedupedSymbols.slice(0, WORKSPACE_SYMBOL_LIMIT);
		const lines = limitedSymbols.map(s => formatSymbolInformation(s, this.session.cwd));
		const truncationLine =
			dedupedSymbols.length > WORKSPACE_SYMBOL_LIMIT
				? `\n[…${dedupedSymbols.length - WORKSPACE_SYMBOL_LIMIT} symbols elided…]`
				: "";
		return {
			content: [
				{
					type: "text",
					text: `Found ${dedupedSymbols.length} symbol(s) matching "${normalizedQuery}":\n${lines.map(l => `  ${l}`).join("\n")}${truncationLine}`,
				},
			],
			details: {
				action,
				serverName: Array.from(respondingServers).join(", "),
				success: true,
				request: params,
			},
		};
	}

	/** `reload` at workspace scope: restart every live client and drop the cached config. */
	async #workspaceReload(params: LspParams, signal: AbortSignal): Promise<AgentToolResult<LspToolDetails>> {
		const { action } = params;
		// `reload *` is the user's explicit request to re-read config from
		// disk. Drop the per-cwd cache entry so `.veyyon/lsp.json`, root markers,
		// and plugin configs added after the first LSP call become visible —
		// otherwise `getConfig` returns the first observation for the rest of
		// the process lifetime (#3546).
		forgetConfig(this.session.cwd);
		const refreshedConfig = getConfig(this.session.cwd);
		const servers = getLspServers(refreshedConfig);
		if (servers.length === 0) {
			return {
				content: [{ type: "text", text: "No language server found for this action" }],
				details: { action, success: false, request: params },
			};
		}
		const outputs: string[] = [];
		for (const [workspaceServerName, workspaceServerConfig] of servers) {
			throwIfAborted(signal);
			try {
				const workspaceClient = await getOrCreateClient(workspaceServerConfig, this.session.cwd, undefined, signal);
				outputs.push(await reloadServer(workspaceClient, workspaceServerName, signal));
			} catch (err) {
				if (err instanceof ToolAbortError || signal?.aborted) {
					throw err;
				}
				const errorText = errorMessage(err);
				outputs.push(`Failed to reload ${workspaceServerName}: ${errorText}`);
			}
		}
		return {
			content: [{ type: "text", text: outputs.join("\n") }],
			details: { action, serverName: servers.map(([name]) => name).join(", "), success: true, request: params },
		};
	}
}

/** Runs a file-bound action against its opened file and reports what the server answered. */
async function runFileAction(
	params: LspParams,
	query: FileQuery,
	serverName: string,
): Promise<AgentToolResult<LspToolDetails>> {
	const { action } = params;
	let report: ActionReport;
	switch (action) {
		case "definition":
		case "type_definition":
		case "implementation":
			report = await locateAt(query, LOCATION_LOOKUPS[action]);
			break;
		case "incoming_calls":
		case "outgoing_calls":
			report = await callsAt(query, CALL_DIRECTIONS[action]);
			break;
		case "references":
			report = await findReferences(query);
			break;
		case "hover":
			report = await hoverAt(query);
			break;
		case "code_actions":
			report = await codeActionsAt(query, params.query, params.apply);
			break;
		case "symbols":
			report = await documentSymbols(query);
			break;
		case "rename":
			if (!params.new_name) {
				return {
					content: [{ type: "text", text: "Error: new_name parameter required for rename" }],
					details: { action, serverName, success: false },
				};
			}
			report = await renameAt(query, params.new_name, params.apply);
			break;
		case "reload":
			report = { output: await reloadServer(query.client, serverName, query.signal) };
			break;
		default:
			report = { output: `Unknown action: ${action}` };
	}
	return {
		content: [{ type: "text", text: report.output }],
		details: { serverName, action, success: true, request: params },
		...(report.useless ? { useless: true } : {}),
	};
}
