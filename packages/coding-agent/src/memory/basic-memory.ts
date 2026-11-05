import { randomUUID } from "node:crypto";
import type { Settings } from "../config/settings";
import { callTool, connectToServer, disconnectServer, listTools } from "../mcp/client";
import type { MCPServerConnection } from "../mcp/types";
import { abortedPartway } from "../tools/core/aborted-partway";
import { throwIfAborted } from "../tools/core/tool-errors";
import type {
	MemoryBackend,
	MemoryBackendSaveInput,
	MemoryBackendSaveResult,
	MemoryBackendSearchItem,
	MemoryBackendSearchOptions,
	MemoryBackendSearchResult,
} from "./types";
import instructions from "./basic-memory-instructions.md" with { type: "text" };

const SOURCE_PREFIX = "hindsight_source_base64:";
const REQUIRED_TOOLS = ["search_notes", "read_note", "write_note"];

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Each operation owns its process; no session-global connection or credentials. */
async function withBasicMemory<T>(
	settings: Settings,
	cwd: string,
	signal: AbortSignal | undefined,
	operation: (connection: MCPServerConnection, project: string, signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const command = settings.get("memory.basicMemory.command").trim();
	const project = settings.get("memory.basicMemory.project").trim();
	const timeout = settings.get("memory.basicMemory.timeoutMs");
	if (!command || !project || !Number.isInteger(timeout) || timeout < 1_000 || timeout > 300_000) {
		throw new Error("Basic Memory requires a nonempty command and project, and timeoutMs between 1000 and 300000.");
	}
	throwIfAborted(signal);
	const deadline = AbortSignal.timeout(timeout);
	const operationSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
	const configDir = settings.get("memory.basicMemory.configDir").trim();
	let connection: MCPServerConnection;
	try {
		connection = await connectToServer(
			"basic-memory",
			{
				command,
				args: ["mcp", "--local", "--project", project],
				cwd,
				timeout,
				env: {
					...(configDir ? { BASIC_MEMORY_CONFIG_DIR: configDir } : {}),
					BASIC_MEMORY_FORCE_LOCAL: "true",
					BASIC_MEMORY_SEMANTIC_SEARCH_ENABLED: "false",
					BASIC_MEMORY_RERANKER_ENABLED: "false",
					BASIC_MEMORY_AUTO_UPDATE: "false",
					BASIC_MEMORY_INDEX_CHANGES: "false",
					BASIC_MEMORY_SKIP_INITIALIZATION_SYNC: "true",
					BASIC_MEMORY_ENSURE_FRONTMATTER_ON_SYNC: "false",
					HF_HUB_OFFLINE: "1",
					LITELLM_LOCAL_MODEL_COST_MAP: "true",
					PYTHONIOENCODING: "utf-8",
					PYTHONUTF8: "1",
					NO_PROMOS: "1",
				},
			},
			{ signal: operationSignal },
		);
	} catch (cause) {
		throwIfAborted(signal);
		throw new Error(
			"Basic Memory is unavailable. Check memory.basicMemory.command, project, configDir and timeoutMs; install basic-memory==0.23.2. No fallback was used.",
			{ cause },
		);
	}
	try {
		const tools = await listTools(connection, { signal: operationSignal });
		if (REQUIRED_TOOLS.some(name => !tools.some(tool => tool.name === name))) {
			throw new Error("Unsupported Basic Memory MCP tools. This backend requires basic-memory==0.23.2.");
		}
		return await operation(connection, project, operationSignal);
	} finally {
		await disconnectServer(connection);
	}
}

async function callJson(
	connection: MCPServerConnection,
	name: string,
	args: Record<string, unknown>,
	signal: AbortSignal,
): Promise<Record<string, unknown>> {
	const result = await callTool(connection, name, { ...args, output_format: "json" }, { signal });
	if (result.isError) throw new Error(`Basic Memory ${name} failed. Check the configured project and local MCP runtime.`);
	const text = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch (cause) {
		throw new Error(`Basic Memory ${name} did not return JSON. Check the project and supported version (0.23.2).`, { cause });
	}
	if (!record(payload) || payload.error) throw new Error(`Basic Memory ${name} returned an invalid response.`);
	return payload;
}

/** Imported rows are preserved on disk; return their original text, never the encoded payload. */
function noteContent(markdown: string): string {
	const encoded = markdown.match(/hindsight_source_base64:([A-Za-z0-9+/=]+)/)?.[1];
	if (!encoded) return markdown;
	let row: unknown;
	try {
		row = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
	} catch (cause) {
		throw new Error("Basic Memory note contains invalid source metadata.", { cause });
	}
	if (!record(row)) throw new Error("Basic Memory note contains invalid source metadata.");
	const content = typeof row.text === "string" ? row.text
		: typeof row.content === "string" ? row.content
		: record(row.content) && typeof row.content.previous_content === "string" ? row.content.previous_content
		: undefined;
	if (content === undefined) throw new Error("Basic Memory source metadata has no readable content.");
	return typeof row.context === "string" && row.context ? `${content}\n\nContext: ${row.context}` : content;
}

async function readNote(connection: MCPServerConnection, project: string, identifier: string, signal: AbortSignal): Promise<string> {
	const note = await callJson(connection, "read_note", { identifier, project, include_frontmatter: false }, signal);
	if (typeof note.content !== "string") throw new Error("Basic Memory read_note returned no note content.");
	return noteContent(note.content);
}

export async function readBasicMemory(settings: Settings, cwd: string, identifier: string, signal?: AbortSignal): Promise<string> {
	return withBasicMemory(settings, cwd, signal, (connection, project, operationSignal) =>
		readNote(connection, project, identifier, operationSignal));
}

export async function searchBasicMemory(
	settings: Settings,
	cwd: string,
	query: string,
	options?: MemoryBackendSearchOptions,
): Promise<MemoryBackendSearchResult> {
	const requested = options?.limit ?? 10;
	if (!Number.isFinite(requested)) throw new Error("Basic Memory search limit must be finite.");
	const limit = Math.max(1, Math.min(50, Math.floor(requested)));
	return withBasicMemory(settings, cwd, options?.signal, async (connection, project, signal) => {
		const response = await callJson(connection, "search_notes", {
			query, project, search_type: "text", entity_types: ["entity"], page: 1, page_size: limit,
		}, signal);
		if (!Array.isArray(response.results)) throw new Error("Basic Memory search_notes returned no result list.");
		const items: MemoryBackendSearchItem[] = [];
		for (const hit of response.results.slice(0, limit)) {
			if (!record(hit) || typeof hit.title !== "string") throw new Error("Basic Memory returned an invalid search hit.");
			// A title survives the imported Hindsight mapping and is also a usable memory:// identifier.
			const id = typeof hit.external_id === "string" ? hit.external_id : hit.title;
			items.push({
				id,
				content: await readNote(connection, project, id, signal),
				source: typeof hit.file_path === "string" ? hit.file_path : undefined,
				timestamp: typeof hit.updated_at === "string" ? hit.updated_at : undefined,
				score: typeof hit.score === "number" ? hit.score : undefined,
			});
		}
		return { backend: "basic-memory", query, count: items.length, items };
	});
}

export async function retainBasicMemory(
	settings: Settings,
	cwd: string,
	items: readonly MemoryBackendSaveInput[],
	signal?: AbortSignal,
): Promise<MemoryBackendSaveResult> {
	if (items.some(item => !item.content.trim())) throw new Error("Basic Memory cannot retain empty content.");
	return withBasicMemory(settings, cwd, signal, async (connection, project, operationSignal) => {
		const ids: string[] = [];
		for (const [index, item] of items.entries()) {
			const id = randomUUID();
			const title = `hindsight-${id}`;
			const row = {
				bank_id: project, context: item.context ?? null, created_at: new Date().toISOString(),
				id, source: item.source ?? "veyyon-retain", text: item.content,
			};
			const encoded = Buffer.from(JSON.stringify(row), "utf8").toString("base64");
			const content = `## Observations\n\n- ${item.content.replace(/\n/g, "\n  ")}\n- ${SOURCE_PREFIX}${encoded}\n`;
			try {
				throwIfAborted(operationSignal);
				const response = await callJson(connection, "write_note", {
					title, content, directory: "hindsight-memory", project, note_type: "hindsight-memory", overwrite: false,
				}, operationSignal);
				if (typeof response.permalink !== "string") throw new Error("Basic Memory write_note did not confirm a saved note.");
				ids.push(title);
			} catch (cause) {
				const advice = `Current note ${title} may have been written. Read it before retrying; do not resend completed notes.`;
				if (signal?.aborted) {
					throw abortedPartway({
						operation: "Retain", unit: { one: "memory", many: "memories" }, done: ids,
						pending: items.slice(index).map((_, offset) => `item ${index + offset + 1}`),
						doneLabel: "already stored", pendingLabel: "NOT confirmed", advice,
					}, cause);
				}
				throw new Error(`Basic Memory retain failed after ${ids.length} of ${items.length} memories. Stored: ${ids.join(", ") || "none"}. ${advice}`, { cause });
			}
		}
		return { backend: "basic-memory", stored: ids.length, ids };
	});
}

export const basicMemoryBackend: MemoryBackend = {
	id: "basic-memory",
	start() {}, // Explicit tools own connections; no background sync or automatic retention.
	async buildDeveloperInstructions() {
		return instructions;
	},
	async clear() {
		throw new Error("Basic Memory notes are not deleted by /memory clear. Manage the vault explicitly with Basic Memory.");
	},
	async enqueue() {
		throw new Error("Basic Memory has no automatic session retention. Use retain or /memory save for explicit facts.");
	},
	async status({ session }) {
		return { backend: "basic-memory", active: true, writable: true, searchable: true,
			scope: session?.settings.get("memory.basicMemory.project"), message: "Explicit local MCP operations; availability is checked when used." };
	},
	async search({ session, cwd }, query, options) {
		if (!session) throw new Error("Basic Memory search requires an active session.");
		return searchBasicMemory(session.settings, cwd, query, options);
	},
	async save({ session, cwd }, input) {
		if (!session) throw new Error("Basic Memory retain requires an active session.");
		return retainBasicMemory(session.settings, cwd, [input]);
	},
};
