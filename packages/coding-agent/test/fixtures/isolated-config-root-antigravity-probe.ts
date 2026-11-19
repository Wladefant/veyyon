/**
 * Fresh-process probe for isolated child execution under VEYYON_CONFIG_DIR.
 *
 * Replaces only the HTTP transport (`globalThis.fetch`) so zero real network
 * traffic can leave the process, runs the real `Settings.init`, real
 * `discoverAuthStorage()`, real `ModelRegistry`, and real `runSubprocess`
 * against a `google-antigravity` model, and prints a JSON report of:
 *   - resolved config/agent/session/auth paths and `profileSharing` / `retry.maxDelayMs`
 *   - every outbound HTTP request intercepted at the transport boundary
 *   - the `SingleResult` returned by `runSubprocess`
 *   - session files written under the canary and normal session directories
 *
 * argv[2]: working directory (`cwd` for the child run)
 * argv[3]: normal sessions dir (checked for unintended writes)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	getAgentDbPath,
	getAgentDir,
	getGlobalConfigRootDir,
	getSessionsDir,
	getSharedAuthDir,
	postmortem,
	readGlobalProfileSharingSafe,
} from "@veyyon/utils";
import { Settings } from "../../src/config/settings";
import { runSubprocess } from "../../src/task/executor";
import type { AgentDefinition } from "../../src/task/types";

const CANARY_ACCOUNT = "access-verified-canary";
const SIBLING_ACCOUNT = "access-normal-sibling";
const PROVIDER = "google-antigravity";
const MODEL = `${PROVIDER}/gemini-3.8-flash:high`;
type Account = "canary" | "sibling" | "other";

export interface InterceptedRequest {
	model: string | undefined;
	account: Account;
}

export interface IsolatedChildProbeReport {
	resolved: {
		globalConfigRoot: string;
		agentDir: string;
		sessionsDir: string;
		profileSharing: boolean;
		authDbPath: string;
		retryMaxDelayMs: number;
		loadBalancing: boolean;
	};
	requests: InterceptedRequest[];
	result: {
		exitCode: number;
		terminalOutcome: string | undefined;
		error: string | undefined;
		stderr: string;
		resolvedModel: string | undefined;
	};
	sessionFiles: string[];
	normalSessionFiles: string[];
	sessionInitFirstLine: string | null;
}

function listFilesRecursive(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...listFilesRecursive(full));
		} else {
			out.push(full);
		}
	}
	return out.sort();
}

const workDir = process.argv[2];
const normalSessionsDir = process.argv[3];
if (!workDir || !normalSessionsDir) {
	throw new Error("usage: isolated-config-root-antigravity-probe.ts <workDir> <normalSessionsDir>");
}

fs.mkdirSync(workDir, { recursive: true });

const requests: InterceptedRequest[] = [];
const originalFetch = globalThis.fetch;

const simulatedTransport: typeof fetch = Object.assign(
	async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const request = new Request(input, init);
		const url = request.url;
		const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
		if (url.includes("streamGenerateContent")) {
			const { model } = await request.json() as { model?: string };
			requests.push({
				model,
				account: token === CANARY_ACCOUNT ? "canary" : token === SIBLING_ACCOUNT ? "sibling" : "other",
			});
			return new Response(
				JSON.stringify({
					error: {
						code: 429,
						message: "Individual quota reached",
						status: "RESOURCE_EXHAUSTED",
						details: [{ reason: "QUOTA_EXHAUSTED" }],
					},
				}),
				{
					status: 429,
					statusText: "Too Many Requests",
					headers: {
						"content-type": "application/json",
						"retry-after": "3600",
					},
				},
			);
		}

		throw new Error(`Unexpected HTTP request in the offline probe: ${request.method} ${url}`);
	},
	{ preconnect: originalFetch.preconnect },
);

globalThis.fetch = simulatedTransport;

let exitCode = 1;
try {
	const globalConfigRoot = getGlobalConfigRootDir();
	const agentDir = getAgentDir();
	const sessionsDir = getSessionsDir();
	const profileSharing = readGlobalProfileSharingSafe();
	const authDbPath = getAgentDbPath(profileSharing ? getSharedAuthDir() : agentDir);

	const settings = await Settings.init({ cwd: workDir, agentDir });
	const retryMaxDelayMs = settings.get("retry.maxDelayMs");
	const loadBalancing = settings.get("accounts.loadBalancing");

	const agent: AgentDefinition = {
		name: "task",
		description: "isolated probe child",
		systemPrompt: "Reply with ok.",
		source: "bundled",
		tools: [],
	};

	const result = await runSubprocess({
		cwd: workDir,
		agent,
		task: "Reply with ok.",
		index: 0,
		id: "isolated-child-probe",
		modelOverride: MODEL,
		settings,
		enableLsp: false,
		contextFiles: [],
		promptTemplates: [],
		skills: [],
		rules: [],
		keepAlive: false,
		maxRuntimeMs: 15_000,
	});

	const sessionFiles = listFilesRecursive(sessionsDir);
	const normalSessionFiles = listFilesRecursive(normalSessionsDir);
	const firstSessionFile = sessionFiles[0];
	const sessionInitFirstLine =
		firstSessionFile && fs.existsSync(firstSessionFile)
			? (fs.readFileSync(firstSessionFile, "utf8").split("\n")[0] ?? null)
			: null;

	const report: IsolatedChildProbeReport = {
		resolved: {
			globalConfigRoot,
			agentDir,
			sessionsDir,
			profileSharing,
			authDbPath,
			retryMaxDelayMs,
			loadBalancing,
		},
		requests,
		result: {
			exitCode: result.exitCode,
			terminalOutcome: result.terminalOutcome,
			error: result.error,
			stderr: result.stderr,
			resolvedModel: result.resolvedModel,
		},
		sessionFiles,
		normalSessionFiles,
		sessionInitFirstLine,
	};

	process.stdout.write(`${JSON.stringify(report)}\n`);
	exitCode = 0;
} finally {
	globalThis.fetch = originalFetch;
	await postmortem.quit(exitCode);
}
