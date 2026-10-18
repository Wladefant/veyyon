import type { FetchImpl } from "../types";

/**
 * Build a User-Agent string that identifies as Gemini CLI to unlock higher rate limits.
 * Uses the same format as the official Gemini CLI (v0.35+):
 * GeminiCLI/VERSION/MODEL (PLATFORM; ARCH; SURFACE)
 */
export function getGeminiCliUserAgent(modelId = "gemini-3.1-pro-preview"): string {
	const version = process.env.VEYYON_AI_GEMINI_CLI_VERSION || "0.46.0";
	// The Gemini CLI reports Node's own platform/arch tokens verbatim (unlike
	// Antigravity, which remaps them) — no translation needed here.
	return `GeminiCLI/${version}/${modelId} (${process.platform}; ${process.arch}; terminal)`;
}

export const getGeminiCliHeaders = (modelId?: string) => ({
	"User-Agent": getGeminiCliUserAgent(modelId),
	"Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
});

export const ANTIGRAVITY_SYSTEM_INSTRUCTION =
	"You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding." +
	"You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question." +
	"**Absolute paths only**" +
	"**Proactiveness**";
/**
 * Antigravity / Cloud Code Assist user agent. Lives in its own file so discovery
 * and usage code can read it without pulling the heavy google-gemini-cli provider
 * (and its @google/genai → google-auth-library dependency chain) into the startup
 * parse graph.
 *
 * The backend gates newer models on the client version. The version is, in order: the
 * VEYYON_AI_ANTIGRAVITY_VERSION override, the latest release from the official update manifest
 * (see {@link ensureAntigravityVersion}), then the pinned fallback. The endpoint lists Gemini 4 Argon
 * and the per-tier Gemini 3.8 Flash deployments only to a client reporting 3.0.0 or later; 2.9.x and
 * earlier receive neither, so the fallback stays at 3.0.0 even though the manifest may report older.
 */
const DEFAULT_ANTIGRAVITY_VERSION = "3.0.0";

const ANTIGRAVITY_VERSION_MANIFEST_URL =
	"https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml";
const ANTIGRAVITY_VERSION_FETCH_TIMEOUT_MS = 5_000;
/** Failed manifest lookups are not retried before this delay, so request paths never stall per call. */
const ANTIGRAVITY_VERSION_RETRY_MS = 10 * 60_000;

let discoveredAntigravityVersion: string | null = null;
let antigravityVersionFetch: Promise<void> | null = null;
let antigravityVersionFailedAt: number | undefined;

/**
 * Extracts the client version from an electron-builder update manifest.
 * Returns null when no well-formed `version:` line is present.
 */
function parseAntigravityManifestVersion(yamlText: string): string | null {
	for (const line of yamlText.split(/\r?\n/)) {
		const match = /^\s*version\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(?:#.*)?$/.exec(line);
		if (!match) continue;
		const version = (match[1] ?? match[2] ?? match[3] ?? "").trim();
		return /^\d+\.\d+\.\d+$/.test(version) ? version : null;
	}
	return null;
}

/**
 * Resolves the latest Antigravity release from the official update manifest.
 * Success is cached for the process lifetime; failures are silent (the pinned
 * fallback stays valid) and suppress further lookups for
 * `ANTIGRAVITY_VERSION_RETRY_MS`. Skipped entirely when VEYYON_AI_ANTIGRAVITY_VERSION is set.
 *
 * The lookup is shared by concurrent callers, so it is bounded only by its own
 * timeout; `signal` ends this caller's wait without cancelling the lookup.
 */
export function ensureAntigravityVersion(fetcher: FetchImpl = fetch, signal?: AbortSignal): Promise<void> {
	if (process.env.VEYYON_AI_ANTIGRAVITY_VERSION || discoveredAntigravityVersion) return Promise.resolve();
	if (!antigravityVersionFetch) {
		if (
			antigravityVersionFailedAt !== undefined &&
			Date.now() - antigravityVersionFailedAt < ANTIGRAVITY_VERSION_RETRY_MS
		) {
			return Promise.resolve();
		}
		antigravityVersionFetch = (async () => {
			try {
				const response = await fetcher(ANTIGRAVITY_VERSION_MANIFEST_URL, {
					headers: { "Cache-Control": "no-cache", "User-Agent": "electron-builder" },
					signal: AbortSignal.timeout(ANTIGRAVITY_VERSION_FETCH_TIMEOUT_MS),
				});
				if (response.ok) {
					discoveredAntigravityVersion = parseAntigravityManifestVersion(await response.text());
				}
			} catch {
				// Silent: the pinned fallback remains valid when version discovery fails.
			} finally {
				antigravityVersionFetch = null;
				if (!discoveredAntigravityVersion) antigravityVersionFailedAt = Date.now();
			}
		})();
	}
	const lookup = antigravityVersionFetch;
	if (!signal) return lookup;
	if (signal.aborted) return Promise.resolve();
	const { promise: aborted, resolve } = Promise.withResolvers<void>();
	const onAbort = () => resolve();
	signal.addEventListener("abort", onAbort, { once: true });
	return Promise.race([lookup, aborted]).finally(() => signal.removeEventListener("abort", onAbort));
}

/** Antigravity `User-Agent` header value. Reads the version at call time so a discovered version takes effect. */
export function getAntigravityUserAgent(): string {
	const version =
		process.env.VEYYON_AI_ANTIGRAVITY_VERSION || discoveredAntigravityVersion || DEFAULT_ANTIGRAVITY_VERSION;
	// Map Node.js platform/arch to Antigravity's expected format.
	// Verified against Antigravity source: _qn() and wqn() in main.js.
	// process.platform: win32→windows, others pass through (darwin, linux)
	// process.arch:     x64→amd64, ia32→386, others pass through (arm64)
	const os = process.platform === "win32" ? "windows" : process.platform;
	const arch = process.arch === "x64" ? "amd64" : process.arch === "ia32" ? "386" : process.arch;
	return `antigravity/hub/${version} ${os}/${arch}`;
}

/**
 * Per-wire-id Antigravity Cloud Code Assist request constants, captured from the
 * real `antigravity/hub` client against `daily-cloudcode-pa`. `modelEnum` is the
 * opaque `labels.model_enum` token the client tags each request with — optional
 * because Anthropic-backed wire ids (e.g. `claude-sonnet-4-6`,
 * `claude-opus-4-6-thinking`) are accepted without one; the label is purely
 * telemetry. `maxOutputTokens` is the fixed `generationConfig.maxOutputTokens`
 * the backend enforces regardless of the thinking budget (Claude caps at
 * 64000, Gemini accepts the discovered cap). Keyed by the routed upstream wire
 * id (post effort-routing), not the collapsed logical id. Checkpoint-only ids
 * (e.g. `gemini-3.1-flash-lite`) are intentionally absent — this provider only
 * emits agent requests.
 */
export interface AntigravityModelWireProfile {
	modelEnum?: string;
	maxOutputTokens: number;
}
export const ANTIGRAVITY_MODEL_WIRE_PROFILES: Readonly<Record<string, AntigravityModelWireProfile>> = {
	"gemini-4-argon-low": { modelEnum: "MODEL_PLACEHOLDER_M419", maxOutputTokens: 65536 },
	"gemini-4-argon-medium": { modelEnum: "MODEL_PLACEHOLDER_M418", maxOutputTokens: 65536 },
	"gemini-4-argon-high": { modelEnum: "MODEL_PLACEHOLDER_M417", maxOutputTokens: 65536 },
	"gemini-3.5-flash-extra-low": { modelEnum: "MODEL_PLACEHOLDER_M187", maxOutputTokens: 65536 },
	"gemini-3.5-flash-low": { modelEnum: "MODEL_PLACEHOLDER_M20", maxOutputTokens: 65536 },
	"gemini-3-flash-agent": { modelEnum: "MODEL_PLACEHOLDER_M132", maxOutputTokens: 65536 },
	"gemini-3.1-pro-low": { modelEnum: "MODEL_PLACEHOLDER_M36", maxOutputTokens: 65535 },
	"gemini-pro-agent": { modelEnum: "MODEL_PLACEHOLDER_M16", maxOutputTokens: 65535 },
	// The `-tiered` flash deployments report the same 65536 cap as the other
	// Gemini flash wire ids. `model_enum` is untracked for these ids; the label
	// is telemetry-only and the backend does not require it.
	"gemini-3.6-flash-tiered": { maxOutputTokens: 65536 },
	"gemini-3.7-flash-tiered": { maxOutputTokens: 65536 },
	"gemini-3.8-flash-tiered": { maxOutputTokens: 65536 },
	// Claude on `daily-cloudcode-pa` rejects `maxOutputTokens > 64000` with a
	// 400 (`Request contains an invalid argument`). The model_enum label is
	// untracked for these ids; the backend does not require it.
	"claude-sonnet-4-6": { maxOutputTokens: 64000 },
	"claude-opus-4-6-thinking": { maxOutputTokens: 64000 },
};
export function getAntigravityModelWireProfile(wireModelId: string): AntigravityModelWireProfile | undefined {
	return ANTIGRAVITY_MODEL_WIRE_PROFILES[wireModelId];
}
