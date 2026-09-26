import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	clearAwsCredentialCache,
	resolveAwsCredentials,
	tokenizeCredentialProcessCommand,
} from "@veyyon/ai/providers/aws-credentials";
import { removeWithRetries } from "../../utils/src/temp";
import type { FetchImpl } from "@veyyon/ai/types";

// `credential_process` integration coverage. Drives a real `Bun.spawn`
// against a fixture script so the JSON envelope contract, exit-code
// handling, abort propagation, cache behavior, and the POSIX-style
// tokenizer are all exercised end-to-end.

const ENV_KEYS = [
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_PROFILE",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_CONFIG_FILE",
	"AWS_SHARED_CREDENTIALS_FILE",
	"AWS_EC2_METADATA_DISABLED",
] as const;

function quoteForConfig(p: string): string {
	if (!/[\s"]/.test(p)) return p;
	// Wrap in double quotes; our tokenizer preserves backslashes so Windows
	// paths survive without further escaping.
	return `"${p.replace(/(["])/g, "\\$1")}"`;
}

describe("tokenizeCredentialProcessCommand", () => {
	test("splits on whitespace", () => {
		expect(tokenizeCredentialProcessCommand("/bin/auth --json")).toEqual(["/bin/auth", "--json"]);
	});

	test("collapses runs of whitespace", () => {
		expect(tokenizeCredentialProcessCommand("  a\tb \n c")).toEqual(["a", "b", "c"]);
	});

	test("double quotes preserve Windows backslashes", () => {
		expect(tokenizeCredentialProcessCommand(`"C:\\Program Files\\auth\\tool.exe" --json`)).toEqual([
			"C:\\Program Files\\auth\\tool.exe",
			"--json",
		]);
	});

	test('double quotes still escape $ ` " and \\', () => {
		expect(tokenizeCredentialProcessCommand(`"a\\"b" "\\$x" "\\\\n"`)).toEqual([`a"b`, "$x", "\\n"]);
	});

	test("single quotes are fully literal", () => {
		expect(tokenizeCredentialProcessCommand(`'C:\\path with spaces\\bin' --x`)).toEqual([
			"C:\\path with spaces\\bin",
			"--x",
		]);
	});

	test("backslash outside quotes escapes the next character", () => {
		expect(tokenizeCredentialProcessCommand(`a\\ b c`)).toEqual(["a b", "c"]);
	});

	test("rejects unterminated quotes", () => {
		expect(() => tokenizeCredentialProcessCommand(`"unterminated`)).toThrow(/unterminated/);
		expect(() => tokenizeCredentialProcessCommand(`'half`)).toThrow(/unterminated/);
	});

	test("empty input yields no tokens", () => {
		expect(tokenizeCredentialProcessCommand("")).toEqual([]);
		expect(tokenizeCredentialProcessCommand("   \t  ")).toEqual([]);
	});
});

describe("resolveAwsCredentials credential_process", () => {
	let tmp: string;
	const saved = new Map<string, string | undefined>();

	beforeEach(async () => {
		for (const k of ENV_KEYS) {
			saved.set(k, Bun.env[k]);
			delete Bun.env[k];
		}
		Bun.env.AWS_EC2_METADATA_DISABLED = "true";
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aws-credproc-"));
		clearAwsCredentialCache();
	});

	afterEach(async () => {
		for (const [k, v] of saved) {
			if (v === undefined) delete Bun.env[k];
			else Bun.env[k] = v;
		}
		saved.clear();
		await removeWithRetries(tmp);
		clearAwsCredentialCache();
	});

	async function writeFixture(name: string, body: string): Promise<string> {
		const p = path.join(tmp, name);
		await Bun.write(p, body);
		return p;
	}

	async function writeConfig(profile: string, line: string): Promise<void> {
		const cfg = path.join(tmp, "config");
		await Bun.write(cfg, `[profile ${profile}]\n${line}\n`);
		Bun.env.AWS_CONFIG_FILE = cfg;
		// Point shared credentials at a known-empty file so static-creds resolution
		// definitely misses.
		const sharedPath = path.join(tmp, "credentials");
		await Bun.write(sharedPath, "");
		Bun.env.AWS_SHARED_CREDENTIALS_FILE = sharedPath;
	}

	test("parses a Version 1 envelope and honors Expiration", async () => {
		const script = await writeFixture(
			"good.js",
			`console.log(JSON.stringify({Version:1,AccessKeyId:"AKIATEST",SecretAccessKey:"sek",SessionToken:"tok",Expiration:"2099-01-01T00:00:00Z"}));`,
		);
		await writeConfig("good", `credential_process = ${quoteForConfig(process.execPath)} ${quoteForConfig(script)}`);

		const creds = await resolveAwsCredentials({ profile: "good", region: "us-east-1" });
		expect(creds.accessKeyId).toBe("AKIATEST");
		expect(creds.secretAccessKey).toBe("sek");
		expect(creds.sessionToken).toBe("tok");
		expect(creds.expiresAt).toBe(Date.parse("2099-01-01T00:00:00Z"));
	});

	test("caches by profile so the helper is only invoked once", async () => {
		const counterPath = path.join(tmp, "calls.txt");
		const script = await writeFixture(
			"counted.js",
			`const fs=require("node:fs");
			 const prev=fs.existsSync(${JSON.stringify(counterPath)})?Number(fs.readFileSync(${JSON.stringify(counterPath)},"utf8")):0;
			 fs.writeFileSync(${JSON.stringify(counterPath)},String(prev+1));
			 console.log(JSON.stringify({Version:1,AccessKeyId:"AKIA",SecretAccessKey:"s",Expiration:"2099-01-01T00:00:00Z"}));`,
		);
		await writeConfig(
			"counted",
			`credential_process = ${quoteForConfig(process.execPath)} ${quoteForConfig(script)}`,
		);

		await resolveAwsCredentials({ profile: "counted" });
		await resolveAwsCredentials({ profile: "counted" });
		const calls = Number(await Bun.file(counterPath).text());
		expect(calls).toBe(1);
	});

	test("rejects unsupported envelope versions", async () => {
		const script = await writeFixture(
			"badversion.js",
			`console.log(JSON.stringify({Version:2,AccessKeyId:"a",SecretAccessKey:"b"}));`,
		);
		await writeConfig("badv", `credential_process = ${quoteForConfig(process.execPath)} ${quoteForConfig(script)}`);
		await expect(resolveAwsCredentials({ profile: "badv" })).rejects.toThrow(/unsupported Version 2/);
	});

	test("surfaces stderr on non-zero exit", async () => {
		const script = await writeFixture("fail.js", `process.stderr.write("auth helper broke");process.exit(7);`);
		await writeConfig(
			"failing",
			`credential_process = ${quoteForConfig(process.execPath)} ${quoteForConfig(script)}`,
		);
		await expect(resolveAwsCredentials({ profile: "failing" })).rejects.toThrow(/exited 7.*auth helper broke/);
	});

	test("aborts a long-running helper when the caller's signal fires", async () => {
		const script = await writeFixture("hang.js", `setTimeout(()=>{},60_000);`);
		await writeConfig("hangs", `credential_process = ${quoteForConfig(process.execPath)} ${quoteForConfig(script)}`);
		const ctrl = new AbortController();
		const reason = new Error("test abort");
		const promise = resolveAwsCredentials({ profile: "hangs", signal: ctrl.signal });
		// Abort straight away rather than on a timer: the helper hangs for a minute
		// either way, so what is under test is that the caller's signal ends the
		// wait rather than how long it waited first.
		ctrl.abort(reason);
		// The caller's own reason has to come back out. A generic rejection here
		// would also be produced by a config parse failure, which is a different
		// bug wearing the same shape.
		const error = await promise.then(
			() => undefined,
			(err: unknown) => err,
		);
		expect(error).toBe(reason);
	});
});

describe("resolveAwsCredentials SSO token refresh", () => {
	let tmp: string;
	let cacheDir: string;
	let homedirSpy: { mockRestore: () => void } | undefined;
	const saved = new Map<string, string | undefined>();
	const START_URL = "https://example.awsapps.com/start";
	const SESSION = "my-session";

	beforeEach(async () => {
		for (const k of ENV_KEYS) {
			saved.set(k, process.env[k]);
			delete process.env[k];
		}
		process.env.AWS_EC2_METADATA_DISABLED = "true";
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aws-sso-"));
		homedirSpy = spyOn(os, "homedir").mockReturnValue(tmp);
		cacheDir = path.join(tmp, ".aws", "sso", "cache");
		await fs.mkdir(cacheDir, { recursive: true });
		clearAwsCredentialCache();
	});

	afterEach(async () => {
		for (const [k, v] of saved) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		saved.clear();
		homedirSpy?.mockRestore();
		await removeWithRetries(tmp);
		clearAwsCredentialCache();
	});

	async function writeSsoConfig(): Promise<void> {
		const cfg = path.join(tmp, "config");
		await fs.writeFile(
			cfg,
			`[profile sso-test]\n` +
				`sso_session = ${SESSION}\n` +
				`sso_account_id = 111122223333\n` +
				`sso_role_name = TestRole\n` +
				`region = us-east-1\n\n` +
				`[sso-session ${SESSION}]\n` +
				`sso_start_url = ${START_URL}\n` +
				`sso_region = us-east-1\n`,
		);
		process.env.AWS_CONFIG_FILE = cfg;
		const sharedPath = path.join(tmp, "credentials");
		await fs.writeFile(sharedPath, "");
		process.env.AWS_SHARED_CREDENTIALS_FILE = sharedPath;
	}

	async function writeCachedToken(token: Record<string, unknown>): Promise<string> {
		const hash = crypto.createHash("sha1").update(SESSION).digest("hex");
		const file = path.join(cacheDir, `${hash}.json`);
		await fs.writeFile(file, JSON.stringify(token));
		return file;
	}

	function expiredToken(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			startUrl: START_URL,
			region: "us-east-1",
			accessToken: "stale-access-token",
			expiresAt: new Date(Date.now() - 60_000).toISOString(),
			refreshToken: "refresh-token-1",
			clientId: "client-id",
			clientSecret: "client-secret",
			registrationExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
			...overrides,
		};
	}

	function ssoMock(
		captured: { oidc: Array<Record<string, unknown>>; bearer: string[] },
		opts: { oidcStatus?: number; rotateRefreshToken?: boolean } = {},
	): FetchImpl {
		return Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url.includes("oidc.")) {
					captured.oidc.push(JSON.parse(String(init?.body)));
					if (opts.oidcStatus && opts.oidcStatus !== 200) {
						return new Response(JSON.stringify({ error: "invalid_grant" }), { status: opts.oidcStatus });
					}
					return Response.json({
						accessToken: "fresh-access-token",
						expiresIn: 3600,
						tokenType: "Bearer",
						...(opts.rotateRefreshToken ? { refreshToken: "refresh-token-2" } : {}),
					});
				}
				const headers = (init?.headers ?? {}) as Record<string, string>;
				captured.bearer.push(String(headers["x-amz-sso_bearer_token"]));
				return Response.json({
					roleCredentials: {
						accessKeyId: "ASIASSO",
						secretAccessKey: "sso-secret",
						sessionToken: "sso-token",
						expiration: Date.now() + 3_600_000,
					},
				});
			},
			{ preconnect: fetch.preconnect },
		);
	}

	test("refreshes an expired token and uses the fresh one for GetRoleCredentials", async () => {
		await writeSsoConfig();
		await writeCachedToken(expiredToken());
		const captured = { oidc: [] as Array<Record<string, unknown>>, bearer: [] as string[] };

		const creds = await resolveAwsCredentials({ profile: "sso-test", fetch: ssoMock(captured) });

		expect(creds.accessKeyId).toBe("ASIASSO");
		expect(captured.oidc).toHaveLength(1);
		expect(captured.oidc[0]).toMatchObject({
			grantType: "refresh_token",
			refreshToken: "refresh-token-1",
			clientId: "client-id",
			clientSecret: "client-secret",
		});
		expect(captured.bearer).toEqual(["fresh-access-token"]);
	});

	test("persists the refreshed token, including a rotated refresh token", async () => {
		await writeSsoConfig();
		const file = await writeCachedToken(expiredToken());
		const captured = { oidc: [] as Array<Record<string, unknown>>, bearer: [] as string[] };

		await resolveAwsCredentials({
			profile: "sso-test",
			fetch: ssoMock(captured, { rotateRefreshToken: true }),
		});

		const persisted = JSON.parse(await fs.readFile(file, "utf8"));
		expect(persisted.accessToken).toBe("fresh-access-token");
		expect(persisted.refreshToken).toBe("refresh-token-2");
		expect(Date.parse(persisted.expiresAt)).toBeGreaterThan(Date.now());
		expect(persisted.startUrl).toBe(START_URL);
		expect(persisted.clientSecret).toBe("client-secret");
		expect((await fs.readdir(cacheDir)).filter(f => f.endsWith(".tmp"))).toEqual([]);
	});

	test("leaves a still-valid token alone", async () => {
		await writeSsoConfig();
		await writeCachedToken(
			expiredToken({ accessToken: "live-token", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
		);
		const captured = { oidc: [] as Array<Record<string, unknown>>, bearer: [] as string[] };

		await resolveAwsCredentials({ profile: "sso-test", fetch: ssoMock(captured) });

		expect(captured.oidc).toHaveLength(0);
		expect(captured.bearer).toEqual(["live-token"]);
	});

	test("still reports expiry when the token carries no refresh grant", async () => {
		await writeSsoConfig();
		await writeCachedToken(expiredToken({ refreshToken: undefined, clientId: undefined, clientSecret: undefined }));
		const captured = { oidc: [] as Array<Record<string, unknown>>, bearer: [] as string[] };

		await expect(resolveAwsCredentials({ profile: "sso-test", fetch: ssoMock(captured) })).rejects.toThrow(
			/has expired. Run 'aws sso login'/,
		);
		expect(captured.oidc).toHaveLength(0);
	});

	test("reports expiry when the refresh exchange is rejected", async () => {
		await writeSsoConfig();
		await writeCachedToken(expiredToken());
		const captured = { oidc: [] as Array<Record<string, unknown>>, bearer: [] as string[] };

		await expect(
			resolveAwsCredentials({ profile: "sso-test", fetch: ssoMock(captured, { oidcStatus: 400 }) }),
		).rejects.toThrow(/has expired. Run 'aws sso login'/);
		expect(captured.oidc).toHaveLength(1);
	});

	test("does not attempt refresh once the client registration has expired", async () => {
		await writeSsoConfig();
		await writeCachedToken(expiredToken({ registrationExpiresAt: new Date(Date.now() - 86_400_000).toISOString() }));
		const captured = { oidc: [] as Array<Record<string, unknown>>, bearer: [] as string[] };

		await expect(resolveAwsCredentials({ profile: "sso-test", fetch: ssoMock(captured) })).rejects.toThrow(
			/has expired. Run 'aws sso login'/,
		);
		expect(captured.oidc).toHaveLength(0);
	});
});
