/**
 * Ollama's native API: `/api/tags` lists the models a server has, `/api/show` states what one of them
 * can do. Every Ollama reader goes through this module: the local daemon, Ollama Cloud, and an endpoint
 * configured with `discovery.type: ollama`.
 *
 * Both bodies are untyped JSON from a server that may sit behind a proxy, so each reader returns
 * `undefined` for a body it cannot use and reports why. A reader that threw on an unexpected shape would
 * take every model of the provider with it, where a stripped model loses only its metadata.
 */
import { errorMessage, isNonEmptyString, isRecord } from "@veyyon/utils/type-guards";
import {
	type DiscoveryFailureStage,
	type DiscoveryHooks,
	type DiscoveryReport,
	readDiscoveryJson,
} from "../discovery/failure";
import { OLLAMA_WIRE_EFFORTS } from "../model-thinking";
import type { FetchImpl, ThinkingConfig } from "../types";
import { discoveryFetch, toPositiveNumberOrNull } from "../utils";

/** One `/api/tags` entry: the id requests address, and the display name when the server sent one. */
export interface OllamaTag {
	id: string;
	name?: string;
}

/**
 * The model list in an `/api/tags` body, or `undefined` when the body holds no list.
 *
 * A body without `models` is a server with no models and reads as `[]`. An entry with neither a
 * `model` nor a `name` cannot be addressed and is skipped.
 */
export function parseOllamaTags(payload: unknown): OllamaTag[] | undefined {
	if (!isRecord(payload)) return undefined;
	const models = payload.models;
	if (models === undefined || models === null) return [];
	if (!Array.isArray(models)) return undefined;
	const tags: OllamaTag[] = [];
	for (const entry of models) {
		if (!isRecord(entry)) continue;
		const name = isNonEmptyString(entry.name) ? entry.name : undefined;
		const id = isNonEmptyString(entry.model) ? entry.model : name;
		if (id === undefined) continue;
		tags.push(name === undefined ? { id } : { id, name });
	}
	return tags;
}

/**
 * Reads an `/api/tags` response, reporting a non-ok status, a body that is not JSON, and a body that is
 * not a model list. Returns `undefined` after a report.
 */
export async function readOllamaTags(response: Response, report: DiscoveryReport): Promise<OllamaTag[] | undefined> {
	const payload = await readDiscoveryJson(response, report);
	if (payload === undefined) return undefined;
	const tags = parseOllamaTags(payload);
	if (tags === undefined) report("payload", "body holds no `models` list");
	return tags;
}

/** What `/api/show` states about one model. */
export interface OllamaShow {
	/**
	 * The context window the server runs the model with: `num_ctx` from the model's parameters, else the
	 * trained length in `model_info`. A Modelfile that sets `num_ctx` below the trained length is the
	 * window requests get; a prompt packed to the trained length loses its front.
	 */
	contextWindow?: number;
	/** Lowercased capability names, or `undefined` when the response states none. */
	capabilities?: ReadonlySet<string>;
}

/** Transport for one `/api/show` request. */
export interface OllamaShowRequest {
	fetch?: FetchImpl;
	headers?: Record<string, string>;
	signal?: AbortSignal;
	onFailure?: DiscoveryHooks["onFailure"];
}

const RUNTIME_NUM_CTX = /(?:^|\n)\s*num_ctx\s+(\d+)\s*(?:$|\n)/m;
const MODEL_INFO_CONTEXT_SUFFIXES = [".context_length", ".num_ctx", ".context_window"] as const;

function parseContextWindow(payload: Record<string, unknown>): number | undefined {
	const parameters = payload.parameters;
	if (typeof parameters === "string") {
		const runtime = toPositiveNumberOrNull(RUNTIME_NUM_CTX.exec(parameters)?.[1]);
		if (runtime !== null) return runtime;
	}
	const modelInfo = payload.model_info;
	if (!isRecord(modelInfo)) return undefined;
	for (const [key, value] of Object.entries(modelInfo)) {
		if (key !== "context_length" && !MODEL_INFO_CONTEXT_SUFFIXES.some(suffix => key.endsWith(suffix))) continue;
		const window = toPositiveNumberOrNull(value);
		if (window !== null) return window;
	}
	return undefined;
}

/** Ollama lists capabilities as names; some proxies send a map of name to boolean instead. */
function parseCapabilities(value: unknown): ReadonlySet<string> | undefined {
	if (Array.isArray(value)) {
		return new Set(value.flatMap(name => (typeof name === "string" ? [name.toLowerCase()] : [])));
	}
	if (isRecord(value)) {
		return new Set(
			Object.entries(value).flatMap(([name, enabled]) => (enabled === true ? [name.toLowerCase()] : [])),
		);
	}
	return undefined;
}

/**
 * Requests `/api/show` for one model.
 *
 * Returns `undefined` when the request fails or the body is not an object; every such branch reports,
 * with the model id in the detail, because this runs once per model and a caller falls back to defaults
 * that look exactly like a model with no thinking, no image input and a guessed window.
 */
export async function fetchOllamaShow(
	nativeBaseUrl: string,
	modelId: string,
	request: OllamaShowRequest = {},
): Promise<OllamaShow | undefined> {
	const url = `${nativeBaseUrl}/api/show`;
	const report = (stage: DiscoveryFailureStage, detail: string): void =>
		request.onFailure?.({ stage, url, detail: `${modelId}: ${detail}` });
	let response: Response;
	try {
		response = await discoveryFetch(request.fetch)(url, {
			method: "POST",
			headers: { Accept: "application/json", ...request.headers, "Content-Type": "application/json" },
			body: JSON.stringify({ model: modelId }),
			signal: request.signal,
		});
	} catch (error) {
		report("request", errorMessage(error));
		return undefined;
	}
	const payload = await readDiscoveryJson(response, report);
	if (payload === undefined) return undefined;
	if (!isRecord(payload)) {
		report("payload", "body is not an object");
		return undefined;
	}
	const capabilities = parseCapabilities(payload.capabilities);
	if (capabilities === undefined && payload.capabilities !== undefined && payload.capabilities !== null) {
		report("payload", "`capabilities` is neither a list nor a map");
	}
	return { contextWindow: parseContextWindow(payload), capabilities };
}

/** The input a model accepts by its capabilities: images when it lists `vision` or `image`. */
export function ollamaInput(capabilities: ReadonlySet<string>): ("text" | "image")[] {
	return capabilities.has("vision") || capabilities.has("image") ? ["text", "image"] : ["text"];
}

/** The effort control a model gets by its capabilities, or `undefined` when it does not think. */
export function ollamaThinking(capabilities: ReadonlySet<string>): ThinkingConfig | undefined {
	return capabilities.has("thinking") ? { mode: "effort", efforts: OLLAMA_WIRE_EFFORTS.slice() } : undefined;
}
