/**
 * WHY THIS SUITE EXISTS. BashTool must derive caller identity from the live ToolSession +
 * global AgentRegistry and expose an attested loopback receipt over VEYYON_CALLER_URL/TOKEN,
 * while refusing user overrides and clearing inherited receipt vars for non-live/advisor/
 * mismatched callers so downstream guards never misattribute authority. What it does not catch:
 * end-to-end execution of external Python merge-gate scripts against this endpoint (tested in
 * the downstream consumer repo).
 */

import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@veyyon/coding-agent/async/job-manager";
import { AgentRegistry, type AgentKind, type AgentStatus } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { deriveToolSession } from "@veyyon/coding-agent/session/tool-session";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { BashTool } from "@veyyon/coding-agent/tools/shell/bash";
import {
	activeCallerReceiptCountForTests,
	mintCallerReceiptForTests,
	stopCallerAttestationServer,
} from "@veyyon/coding-agent/tools/shell/bash-caller-attestation";
import * as bashInteractive from "@veyyon/coding-agent/tools/shell/bash-interactive";
import type { ClientBridge, ClientBridgeTerminalHandle } from "@veyyon/kernel/session/client-bridge";
import { logger, removeWithRetries } from "@veyyon/utils";
import { useIsolatedGlobalSettings } from "../helpers/isolated-global-settings";
import { toolResultText } from "../helpers/tool-result-text";
import { makeToolSession } from "../helpers/tool-session";

useIsolatedGlobalSettings();

const RESERVED_ENV_KEYS = [
	"VEYYON_CALLER_URL",
	"VEYYON_CALLER_TOKEN",
	"VEYYON_AGENT_ID",
	"VEYYON_SESSION_FILE",
] as const;

interface LiveAgentFixture {
	agentId: string;
	sessionId: string;
	sessionFile: string | null;
	ownerSession: AgentSession;
	toolSession: ToolSession;
}

function makeBashSettings(asyncEnabled = false) {
	return {
		get(key: string) {
			if (key === "async.enabled") return asyncEnabled;
			if (key === "bash.autoBackground.enabled") return false;
			if (key === "bash.autoBackground.thresholdMs") return 60_000;
			if (key === "bashInterceptor.enabled") return false;
			if (key === "astEdit.enabled") return false;
			return undefined;
		},
		getBashInterceptorRules() {
			return [];
		},
		getShellConfig() {
			return { shell: "/bin/bash", args: ["-l", "-c"], env: {}, prefix: undefined };
		},
	};
}

function registerLiveAgent(options: {
	cwd: string;
	id: string;
	kind: AgentKind;
	sessionId: string;
	sessionFile: string | null;
	scope?: string;
	parentId?: string;
	status?: AgentStatus;
	isDisposed?: () => boolean;
	asyncEnabled?: boolean;
	asyncJobManager?: AsyncJobManager;
	clientBridge?: ClientBridge;
}): LiveAgentFixture {
	const sessionManager = {
		getSessionId: () => options.sessionId,
		getSessionFile: () => options.sessionFile ?? undefined,
		getArtifactsDir: () => null,
	};
	const ownerSession = {
		sessionManager,
		messages: [],
		get isDisposed() {
			return options.isDisposed?.() ?? false;
		},
	} as unknown as AgentSession;
	AgentRegistry.global().register({
		id: options.id,
		displayName: options.id,
		kind: options.kind,
		parentId: options.parentId,
		session: ownerSession,
		sessionFile: options.sessionFile,
		scope: options.scope,
		status: options.status ?? "running",
	});
	const toolSession = makeToolSession({
		cwd: options.cwd,
		hasUI: false,
		skills: [],
		settings: makeBashSettings(options.asyncEnabled),
		getSessionFile: () => options.sessionFile,
		getSessionId: () => options.sessionId,
		getAgentId: () => options.id,
		getOwningAgentSession: () => ownerSession,
		agentRegistry: AgentRegistry.global(),
		asyncJobManager: options.asyncJobManager,
		getClientBridge: () => options.clientBridge,
		allocateOutputArtifact: async kind => ({
			id: `${kind}-1`,
			path: path.join(options.cwd, `${kind}-1.txt`),
		}),
	});
	return {
		agentId: options.id,
		sessionId: options.sessionId,
		sessionFile: options.sessionFile,
		ownerSession,
		toolSession,
	};
}

function parseFourEnvLines(output: string): {
	url: string;
	token: string;
	agentId: string;
	sessionFile: string;
} {
	const matches = Array.from(output.matchAll(/^<(.*)>$/gm), match => match[1] ?? "");
	expect(matches).toHaveLength(4);
	return {
		url: matches[0]!,
		token: matches[1]!,
		agentId: matches[2]!,
		sessionFile: matches[3]!,
	};
}

const PRINT_CALLER_ENV_COMMAND =
	'printf "<%s>\\n<%s>\\n<%s>\\n<%s>\\n" "$VEYYON_CALLER_URL" "$VEYYON_CALLER_TOKEN" "$VEYYON_AGENT_ID" "$VEYYON_SESSION_FILE"';

describe("BashTool caller attestation", () => {
	let tmpDir: string;
	let savedEnv: Record<string, string | undefined>;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-caller-attest-"));
		savedEnv = {};
		for (const key of RESERVED_ENV_KEYS) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		AgentRegistry.resetGlobalForTests();
	});

	afterEach(async () => {
		for (const key of RESERVED_ENV_KEYS) {
			const previous = savedEnv[key];
			if (previous === undefined) delete process.env[key];
			else process.env[key] = previous;
		}
		await stopCallerAttestationServer();
		AgentRegistry.resetGlobalForTests();
		vi.restoreAllMocks();
		await removeWithRetries(tmpDir);
	});

	it("attests a live main caller with a valid bearer receipt over loopback HTTP", async () => {
		const mainFile = path.join(tmpDir, "main.jsonl");
		const main = registerLiveAgent({
			cwd: tmpDir,
			id: "main:sess-main-1",
			kind: "main",
			sessionId: "sess-main-1",
			sessionFile: mainFile,
			scope: "sess-main-1",
		});

		const logCalls: string[] = [];
		const debugSpy = spyOn(logger, "debug").mockImplementation((msg, meta) => {
			logCalls.push(`${msg} ${JSON.stringify(meta ?? {})}`);
		});
		const infoSpy = spyOn(logger, "info").mockImplementation((msg, meta) => {
			logCalls.push(`${msg} ${JSON.stringify(meta ?? {})}`);
		});
		const warnSpy = spyOn(logger, "warn").mockImplementation((msg, meta) => {
			logCalls.push(`${msg} ${JSON.stringify(meta ?? {})}`);
		});
		const errorSpy = spyOn(logger, "error").mockImplementation((msg, meta) => {
			logCalls.push(`${msg} ${JSON.stringify(meta ?? {})}`);
		});

		try {
			const tool = new BashTool(main.toolSession);
			const result = await tool.execute("c1", { command: PRINT_CALLER_ENV_COMMAND, timeout: 15 });
			const env = parseFourEnvLines(toolResultText(result, ""));

			expect(env.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/caller$/);
			expect(env.token.length).toBeGreaterThanOrEqual(32);
			expect(env.agentId).toBe("main:sess-main-1");
			expect(env.sessionFile).toBe(mainFile);

			const res = await fetch(env.url, {
				headers: { Authorization: `Bearer ${env.token}` },
			});
			expect(res.status).toBe(200);
			const receipt = (await res.json()) as Record<string, unknown>;
			expect(receipt.version).toBe(1);
			expect(receipt.caller_id).toBe("main:sess-main-1");
			expect(receipt.caller_kind).toBe("main");
			expect(receipt.session_file).toBe(mainFile);
			expect(receipt.session_id).toBe("sess-main-1");
			expect(receipt.root_id).toBe("main:sess-main-1");
			expect(receipt.root_session_file).toBe(mainFile);
			expect(typeof receipt.issued_at).toBe("number");
			expect(typeof receipt.expires_at).toBe("number");
			expect(Number.isInteger(receipt.issued_at)).toBe(true);
			expect(Number.isInteger(receipt.expires_at)).toBe(true);
			const ttl = (receipt.expires_at as number) - (receipt.issued_at as number);
			expect(ttl).toBeGreaterThan(0);
			expect(ttl).toBeLessThanOrEqual(86_400);

			// Unauthorized / wrong method / wrong path responses
			expect((await fetch(env.url)).status).toBe(401);
			expect((await fetch(env.url, { headers: { Authorization: "Bearer wrong-token" } })).status).toBe(401);
			expect((await fetch(env.url, { headers: { Authorization: `Basic ${env.token}` } })).status).toBe(401);
			expect(
				(await fetch(env.url, { method: "POST", headers: { Authorization: `Bearer ${env.token}` } })).status,
			).toBe(405);
			const badUrl = env.url.replace("/v1/caller", "/v1/other");
			expect((await fetch(badUrl, { headers: { Authorization: `Bearer ${env.token}` } })).status).toBe(404);

			// Token must never be logged
			for (const entry of logCalls) {
				expect(entry).not.toContain(env.token);
			}
		} finally {
			debugSpy.mockRestore();
			infoSpy.mockRestore();
			warnSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("resolves a subagent caller and derives root via registry.mainInScope", async () => {
		const mainFile = path.join(tmpDir, "root-a.jsonl");
		const subFile = path.join(tmpDir, "sub-a.jsonl");
		const otherMainFile = path.join(tmpDir, "root-b.jsonl");

		registerLiveAgent({
			cwd: tmpDir,
			id: "main:conv-b",
			kind: "main",
			sessionId: "conv-b",
			sessionFile: otherMainFile,
			scope: "conv-b",
		});
		const mainA = registerLiveAgent({
			cwd: tmpDir,
			id: "main:conv-a",
			kind: "main",
			sessionId: "conv-a",
			sessionFile: mainFile,
			scope: "conv-a",
		});
		const subA = registerLiveAgent({
			cwd: tmpDir,
			id: "SubWorker",
			kind: "sub",
			parentId: mainA.agentId,
			sessionId: "sub-sess-a",
			sessionFile: subFile,
		});

		const tool = new BashTool(subA.toolSession);
		const result = await tool.execute("c-sub", { command: PRINT_CALLER_ENV_COMMAND, timeout: 15 });
		const env = parseFourEnvLines(toolResultText(result, ""));

		expect(env.agentId).toBe("SubWorker");
		expect(env.sessionFile).toBe(subFile);

		const res = await fetch(env.url, {
			headers: { Authorization: `Bearer ${env.token}` },
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			version: 1,
			caller_id: "SubWorker",
			caller_kind: "sub",
			session_file: subFile,
			session_id: "sub-sess-a",
			root_id: "main:conv-a",
			root_session_file: mainFile,
		});
	});

	it("clears inherited caller receipt vars for synthetic, advisor, mismatched, and orphaned callers while running ordinary bash", async () => {
		process.env.VEYYON_CALLER_URL = "http://127.0.0.1:9999/v1/caller";
		process.env.VEYYON_CALLER_TOKEN = "leaked-main-token";
		process.env.VEYYON_AGENT_ID = "main:leaked";
		process.env.VEYYON_SESSION_FILE = "/tmp/leaked-main.jsonl";

		// 1. Synthetic / test ToolSession
		const syntheticTool = new BashTool(
			makeToolSession({
				cwd: tmpDir,
				hasUI: false,
				skills: [],
				settings: makeBashSettings(false),
				getSessionFile: () => null,
				getSessionId: () => "synthetic",
				allocateOutputArtifact: async kind => ({ id: `${kind}-1`, path: path.join(tmpDir, `${kind}-1.txt`) }),
			}),
		);
		const synRes = await syntheticTool.execute("syn", { command: PRINT_CALLER_ENV_COMMAND, timeout: 15 });
		expect(parseFourEnvLines(toolResultText(synRes, ""))).toEqual({
			url: "",
			token: "",
			agentId: "",
			sessionFile: "",
		});
		expect(activeCallerReceiptCountForTests()).toBe(0);

		// 2. Advisor derived from live main session (must NOT inherit Main's token)
		const main = registerLiveAgent({
			cwd: tmpDir,
			id: "main:live",
			kind: "main",
			sessionId: "live-sess",
			sessionFile: path.join(tmpDir, "live.jsonl"),
			scope: "live-sess",
		});
		const advisorSession = deriveToolSession(main.toolSession, {
			getOwningAgentSession: () => undefined,
			getAgentId: () => "advisor",
			getSessionId: () => "live-sess-advisor",
		});
		const advRes = await new BashTool(advisorSession).execute("adv", {
			command: PRINT_CALLER_ENV_COMMAND,
			timeout: 15,
		});
		expect(parseFourEnvLines(toolResultText(advRes, ""))).toEqual({
			url: "",
			token: "",
			agentId: "",
			sessionFile: "",
		});

		// 3. Registered advisor actor kind
		const registeredAdvisor = registerLiveAgent({
			cwd: tmpDir,
			id: "advisor-actor",
			kind: "advisor",
			sessionId: "adv-sess",
			sessionFile: null,
			scope: "live-sess",
		});
		const regAdvRes = await new BashTool(registeredAdvisor.toolSession).execute("radv", {
			command: PRINT_CALLER_ENV_COMMAND,
			timeout: 15,
		});
		expect(parseFourEnvLines(toolResultText(regAdvRes, ""))).toEqual({
			url: "",
			token: "",
			agentId: "",
			sessionFile: "",
		});

		// 4. Session ID mismatch
		const mismatchedSession = deriveToolSession(main.toolSession, {
			getSessionId: () => "wrong-session-id",
		});
		const misRes = await new BashTool(mismatchedSession).execute("mis", {
			command: PRINT_CALLER_ENV_COMMAND,
			timeout: 15,
		});
		expect(parseFourEnvLines(toolResultText(misRes, ""))).toEqual({
			url: "",
			token: "",
			agentId: "",
			sessionFile: "",
		});

		// 5. Non-global registry
		const nonGlobalRegistrySession = deriveToolSession(main.toolSession, {
			agentRegistry: new AgentRegistry(),
		});
		const nonGlobRes = await new BashTool(nonGlobalRegistrySession).execute("ng", {
			command: PRINT_CALLER_ENV_COMMAND,
			timeout: 15,
		});
		expect(parseFourEnvLines(toolResultText(nonGlobRes, ""))).toEqual({
			url: "",
			token: "",
			agentId: "",
			sessionFile: "",
		});

		// 6. Subagent with no main in scope (even though main:live exists in another scope)
		const orphanSub = registerLiveAgent({
			cwd: tmpDir,
			id: "OrphanSub",
			kind: "sub",
			sessionId: "orphan-sess",
			sessionFile: path.join(tmpDir, "orphan.jsonl"),
			scope: "missing-root-scope",
		});
		const orphRes = await new BashTool(orphanSub.toolSession).execute("orph", {
			command: PRINT_CALLER_ENV_COMMAND,
			timeout: 15,
		});
		expect(parseFourEnvLines(toolResultText(orphRes, ""))).toEqual({
			url: "",
			token: "",
			agentId: "",
			sessionFile: "",
		});

		let disposed = false;
		const disposable = registerLiveAgent({
			cwd: tmpDir,
			id: "main:disposable",
			kind: "main",
			sessionId: "disp-sess",
			sessionFile: null,
			scope: "disp-sess",
			isDisposed: () => disposed,
		});
		disposed = true;
		const dispRes = await new BashTool(disposable.toolSession).execute("disp", {
			command: PRINT_CALLER_ENV_COMMAND,
			timeout: 15,
		});
		expect(parseFourEnvLines(toolResultText(dispRes, ""))).toEqual({
			url: "",
			token: "",
			agentId: "",
			sessionFile: "",
		});

		// Ordinary bash still succeeds without a valid actor
		const okRes = await new BashTool(advisorSession).execute("ok", {
			command: "printf 'ordinary-ok\\n'",
			timeout: 15,
		});
		expect(toolResultText(okRes, "")).toContain("ordinary-ok");
	});

	it("rejects user env overrides of all four reserved caller fields before spawning", async () => {
		const main = registerLiveAgent({
			cwd: tmpDir,
			id: "main:override",
			kind: "main",
			sessionId: "override-sess",
			sessionFile: path.join(tmpDir, "override.jsonl"),
			scope: "override-sess",
		});
		const tool = new BashTool(main.toolSession);
		const marker = path.join(tmpDir, "should-not-exist");

		for (const key of [...RESERVED_ENV_KEYS, "veyyon_caller_token"]) {
			await expect(
				tool.execute(`ovr-${key}`, {
					command: `printf x > '${marker}'`,
					env: { [key]: "spoofed" },
					timeout: 15,
				}),
			).rejects.toThrow(/reserved/i);
		}
		expect(await Bun.file(marker).exists()).toBe(false);
	});

	it("injects attested caller env across managed foreground jobs, async jobs, ACP terminal, and PTY", async () => {
		const completions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				completions.push({ jobId, text });
			},
		});
		const mainFile = path.join(tmpDir, "routes.jsonl");
		const main = registerLiveAgent({
			cwd: tmpDir,
			id: "main:routes",
			kind: "main",
			sessionId: "routes-sess",
			sessionFile: mainFile,
			scope: "routes-sess",
			asyncEnabled: true,
			asyncJobManager: manager,
		});

		// 1. Managed foreground job route
		const managedTool = new BashTool(main.toolSession);
		const fgResult = await managedTool.execute("fg", { command: PRINT_CALLER_ENV_COMMAND, timeout: 15 });
		const fgEnv = parseFourEnvLines(toolResultText(fgResult, ""));
		expect(fgEnv.agentId).toBe("main:routes");
		expect((await fetch(fgEnv.url, { headers: { Authorization: `Bearer ${fgEnv.token}` } })).status).toBe(200);

		// 2. Explicit async: true background job route
		const asyncStart = await managedTool.execute("bg", {
			command: PRINT_CALLER_ENV_COMMAND,
			async: true,
			timeout: 15,
		});
		const jobId = (asyncStart.details as { async?: { jobId?: string } } | undefined)?.async?.jobId;
		expect(jobId).toBeDefined();
		await manager.waitForAll();
		const completed = completions.find(item => item.jobId === jobId);
		expect(completed).toBeDefined();
		const bgEnv = parseFourEnvLines(completed!.text);
		expect(bgEnv.agentId).toBe("main:routes");
		expect(bgEnv.sessionFile).toBe(mainFile);
		expect((await fetch(bgEnv.url, { headers: { Authorization: `Bearer ${bgEnv.token}` } })).status).toBe(200);

		// 3. ACP clientBridge terminal route
		const bridgeCapturedEnvs: Array<Array<{ name: string; value: string }>> = [];
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-attest",
			waitForExit: async () => ({ exitCode: 0, signal: null }),
			currentOutput: async () => ({ output: "bridge-ok\n", truncated: false }),
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async params => {
				bridgeCapturedEnvs.push(params.env ?? []);
				return handle;
			},
		};
		const bridgeSession = deriveToolSession(main.toolSession, {
			getClientBridge: () => bridge,
		});
		await new BashTool(bridgeSession).execute("acp", { command: "echo bridge", timeout: 15 });
		expect(bridgeCapturedEnvs).toHaveLength(1);
		const acpMap = Object.fromEntries(bridgeCapturedEnvs[0]!.map(entry => [entry.name, entry.value]));
		expect(acpMap.VEYYON_AGENT_ID).toBe("main:routes");
		expect(acpMap.VEYYON_SESSION_FILE).toBe(mainFile);
		expect(acpMap.VEYYON_CALLER_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/caller$/);
		expect((await fetch(acpMap.VEYYON_CALLER_URL!, { headers: { Authorization: `Bearer ${acpMap.VEYYON_CALLER_TOKEN}` } })).status).toBe(200);

		// 4. Interactive PTY route
		const ptyCapturedEnvs: Array<Record<string, string> | undefined> = [];
		const ptySpy = spyOn(bashInteractive, "runInteractiveBashPty").mockImplementation(async (_terminal, opts) => {
			ptyCapturedEnvs.push(opts.env);
			return {
				exitCode: 0,
				cancelled: false,
				timedOut: false,
				output: "pty-ok\n",
				truncated: false,
				totalLines: 1,
				totalBytes: 7,
				outputLines: 1,
				outputBytes: 7,
			};
		});
		try {
			await new BashTool(main.toolSession).execute(
				"pty",
				{ command: "echo pty", pty: true, timeout: 15 },
				undefined,
				undefined,
				{
					hasUI: true,
					ui: { terminal: {} as never } as never,
				} as never,
			);
			expect(ptyCapturedEnvs).toHaveLength(1);
			const ptyEnv = ptyCapturedEnvs[0]!;
			expect(ptyEnv.VEYYON_AGENT_ID).toBe("main:routes");
			expect(ptyEnv.VEYYON_SESSION_FILE).toBe(mainFile);
			expect((await fetch(ptyEnv.VEYYON_CALLER_URL!, { headers: { Authorization: `Bearer ${ptyEnv.VEYYON_CALLER_TOKEN}` } })).status).toBe(200);
		} finally {
			ptySpy.mockRestore();
		}
	});

	it("expires and prunes tokens past their bounded lifetime", async () => {
		const baseNowMs = 1_700_000_000_000;
		const minted = mintCallerReceiptForTests(
			{
				callerId: "main:ttl",
				callerKind: "main",
				sessionId: "ttl-sess",
				sessionFile: null,
				rootId: "main:ttl",
				rootSessionFile: null,
			},
			{ nowMs: baseNowMs, ttlSeconds: 5 },
		);
		expect(minted.receipt.issued_at).toBe(1_700_000_000);
		expect(minted.receipt.expires_at).toBe(1_700_000_005);

		// Valid before expiry
		const dateNowSpy = spyOn(Date, "now").mockReturnValue(baseNowMs + 4_000);
		try {
			const okRes = await fetch(minted.url, {
				headers: { Authorization: `Bearer ${minted.token}` },
			});
			expect(okRes.status).toBe(200);
			const body = (await okRes.json()) as { session_file: string | null };
			expect(body.session_file).toBeNull();

			// Expired at >= expiresAtMs -> returns 401 and prunes entry
			dateNowSpy.mockReturnValue(baseNowMs + 5_000);
			const expRes = await fetch(minted.url, {
				headers: { Authorization: `Bearer ${minted.token}` },
			});
			expect(expRes.status).toBe(401);
			expect(activeCallerReceiptCountForTests()).toBe(0);
		} finally {
			dateNowSpy.mockRestore();
		}
	});
});
