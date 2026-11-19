/**
 * Proves that a fresh Veyyon child process launched with `VEYYON_CONFIG_DIR`
 * and `profileSharing: false` resolves its own isolated config root, private
 * local SQLite auth store, and session directory, and never touches a seeded
 * sibling credential in the normal `$HOME/.veyyon` profile when Antigravity
 * returns a simulated quota 429.
 *
 * Negative control: pointing the fresh child at the normal `$HOME/.veyyon`
 * root fails the exact same strict isolation assertion measurably (it resolves
 * the normal root, sends requests with the normal sibling credential, and
 * writes session files under the normal profile).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage-sqlite";
import type { OAuthCredentials } from "@veyyon/ai/registry/oauth/types";
import { getAgentDbPath, TempDir } from "@veyyon/utils";
import type { IsolatedChildProbeReport } from "../fixtures/isolated-config-root-antigravity-probe";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

const execFileAsync = promisify(execFile);
const FIXTURE_PATH = path.join(import.meta.dirname, "..", "fixtures", "isolated-config-root-antigravity-probe.ts");

const VERIFIED_CANARY_TOKEN = "access-verified-canary";
const NORMAL_SIBLING_TOKEN = "access-normal-sibling";

function createFakeAntigravityOAuth(
	accountId: string,
	projectId: string,
	email: string,
	accessToken: string,
): OAuthCredentials {
	return {
		access: accessToken,
		refresh: `refresh-${accountId}`,
		expires: Date.now() + 60 * 60 * 1000,
		accountId,
		projectId,
		email,
	};
}

async function seedAuthDb(dbPath: string, credential: OAuthCredentials): Promise<void> {
	await fs.mkdir(path.dirname(dbPath), { recursive: true });
	const store = await SqliteAuthCredentialStore.open(dbPath);
	try {
		const storage = new AuthStorage(store, { loadBalancing: true });
		await storage.set("google-antigravity", [{ type: "oauth", ...credential }]);
	} finally {
		store.close();
	}
}

async function seedConfigRoot(
	rootDir: string,
	options: {
		profileSharing: boolean;
		retryMaxDelayMs: number;
	},
): Promise<void> {
	const agentDir = path.join(rootDir, "profiles", "default", "agent");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.writeFile(
		path.join(rootDir, "config.yml"),
		`profileSharing: ${options.profileSharing ? "true" : "false"}\n`,
		"utf8",
	);
	await fs.writeFile(
		path.join(agentDir, "config.yml"),
		`accounts:\n  loadBalancing: true\nretry:\n  maxDelayMs: ${options.retryMaxDelayMs}\n`,
		"utf8",
	);
}

async function runProbeInFreshProcess(options: {
	fakeHome: string;
	workDir: string;
	normalSessionsDir: string;
	configDirOverride?: string;
}): Promise<IsolatedChildProbeReport> {
	const extraEnv: Record<string, string> = {
		HOME: options.fakeHome,
		USERPROFILE: options.fakeHome,
	};
	if (options.configDirOverride !== undefined) {
		extraEnv.VEYYON_CONFIG_DIR = options.configDirOverride;
	}
	const { env, cleanup } = hermeticSpawnEnv(extraEnv);
	for (const key of Object.keys(env)) {
		if (key.startsWith("VEYYON_AUTH_BROKER_")) delete env[key];
	}
	try {
		const { stdout, stderr } = await execFileAsync(
			process.execPath,
			[FIXTURE_PATH, options.workDir, options.normalSessionsDir],
			{
				env,
				timeout: 30_000,
				killSignal: "SIGKILL",
			},
		);
		const lines = stdout
			.trim()
			.split(/\r?\n/)
			.filter(line => line.length > 0);
		const lastLine = lines[lines.length - 1];
		if (!lastLine) {
			throw new Error(`Probe produced empty stdout. stderr:\n${stderr}`);
		}
		return JSON.parse(lastLine) as IsolatedChildProbeReport;
	} finally {
		cleanup();
	}
}

function assertIsolatedCanaryOutcome(
	report: IsolatedChildProbeReport,
	expected: {
		canaryRoot: string;
		normalRoot: string;
	},
): void {
	const expectedAgentDir = path.join(expected.canaryRoot, "profiles", "default", "agent");
	const expectedSessionsDir = path.join(expectedAgentDir, "sessions");
	const expectedAuthDbPath = getAgentDbPath(expectedAgentDir);

	// 1. Non-success termination on simulated Antigravity quota 429.
	expect(report.result.exitCode).not.toBe(0);
	expect(report.result.terminalOutcome).toBe("failed");
	expect(report.result.resolvedModel).toBe("google-antigravity/gemini-3.8-flash-high");

	// 2. Outbound request sequence restricted strictly to the verified canary credential.
	expect(report.requests.length).toBeGreaterThan(0);
	expect(report.requests.every(request => request.account === "canary")).toBe(true);
	expect(report.requests.every(request => request.model === "gemini-3.8-flash-high")).toBe(true);

	// 3. Config/path readback matches the isolated canary root, never the normal root.
	expect(path.resolve(report.resolved.globalConfigRoot)).toBe(path.resolve(expected.canaryRoot));
	expect(path.resolve(report.resolved.globalConfigRoot)).not.toBe(path.resolve(expected.normalRoot));
	expect(path.resolve(report.resolved.agentDir)).toBe(path.resolve(expectedAgentDir));
	expect(path.resolve(report.resolved.sessionsDir)).toBe(path.resolve(expectedSessionsDir));
	expect(report.resolved.profileSharing).toBe(false);
	expect(path.resolve(report.resolved.authDbPath)).toBe(path.resolve(expectedAuthDbPath));
	expect(report.resolved.retryMaxDelayMs).toBe(55);

	// 4. Child session transcript landed only under the isolated canary root.
	expect(report.sessionFiles.length).toBeGreaterThan(0);
	expect(
		report.sessionFiles.every(file =>
			path.resolve(file).startsWith(path.resolve(expectedSessionsDir) + path.sep),
		),
	).toBe(true);
	expect(report.normalSessionFiles).toEqual([]);
	expect(report.sessionInitFirstLine).toContain('"type":"session"');
}

describe("isolated VEYYON_CONFIG_DIR child execution under simulated Antigravity 429", () => {
	let scratch: TempDir;
	let fakeHome: string;
	let normalRoot: string;
	let canaryRoot: string;
	let workDir: string;
	let normalSessionsDir: string;

	beforeEach(async () => {
		scratch = TempDir.createSync("@veyyon-isolated-child-proof-");
		fakeHome = scratch.join("fake-home");
		normalRoot = path.join(fakeHome, ".veyyon");
		canaryRoot = scratch.join("canary-root");
		workDir = scratch.join("project");
		normalSessionsDir = path.join(normalRoot, "profiles", "default", "agent", "sessions");

		await fs.mkdir(fakeHome, { recursive: true });
		await fs.mkdir(workDir, { recursive: true });

		await seedConfigRoot(normalRoot, { profileSharing: false, retryMaxDelayMs: 65 });
		await seedConfigRoot(canaryRoot, { profileSharing: false, retryMaxDelayMs: 55 });

		const siblingCred = createFakeAntigravityOAuth(
			"acct-normal-sibling",
			"proj-normal-sibling",
			"normal-sibling@example.com",
			NORMAL_SIBLING_TOKEN,
		);
		const verifiedCred = createFakeAntigravityOAuth(
			"acct-verified-canary",
			"proj-verified-canary",
			"verified-canary@example.com",
			VERIFIED_CANARY_TOKEN,
		);

		// Seed both normal per-profile and normal shared stores with the sibling credential.
		await seedAuthDb(getAgentDbPath(path.join(normalRoot, "profiles", "default", "agent")), siblingCred);
		await seedAuthDb(getAgentDbPath(path.join(normalRoot, "shared-auth")), siblingCred);

		// Seed only the canary private local auth store with the verified credential.
		await seedAuthDb(getAgentDbPath(path.join(canaryRoot, "profiles", "default", "agent")), verifiedCred);
	});

	afterEach(async () => {
		await scratch.remove();
	});

	it("terminates on 429 using only the verified canary credential and isolated root", async () => {
		const report = await runProbeInFreshProcess({
			fakeHome,
			workDir,
			normalSessionsDir,
			configDirOverride: canaryRoot,
		});

		assertIsolatedCanaryOutcome(report, { canaryRoot, normalRoot });
	}, 40_000);

	it("fails the strict isolation assertion when the child is routed to the normal root (negative control)", async () => {
		const report = await runProbeInFreshProcess({
			fakeHome,
			workDir,
			normalSessionsDir,
		});

		expect(() => assertIsolatedCanaryOutcome(report, { canaryRoot, normalRoot })).toThrow();
		expect(path.resolve(report.resolved.globalConfigRoot)).toBe(path.resolve(normalRoot));
		expect(report.resolved.retryMaxDelayMs).toBe(65);
		expect(report.requests.length).toBeGreaterThan(0);
		expect(report.requests.every(request => request.account === "sibling")).toBe(true);
		expect(report.normalSessionFiles.length).toBeGreaterThan(0);
	}, 40_000);
});
