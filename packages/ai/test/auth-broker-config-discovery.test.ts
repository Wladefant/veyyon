import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { REMOTE_REFRESH_SENTINEL } from "@veyyon/ai";
import { discoverAuthStorage, resolveAuthBrokerConfig, type SnapshotResponse } from "@veyyon/ai/auth-broker";
import type { AuthStorage } from "@veyyon/ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../utils/test/helpers/isolated-config-root";
import { withEnv } from "../../utils/test/helpers/restore-global";

type LoopbackHandler = (request: IncomingMessage, response: ServerResponse) => void;

async function closeLoopbackServer(server: Server): Promise<void> {
	const closed = Promise.withResolvers<void>();
	server.close(error => (error ? closed.reject(error) : closed.resolve()));
	return closed.promise;
}

async function startLoopbackServer(
	handler: LoopbackHandler,
): Promise<{ url: string; close: () => Promise<void> }> {
	const server = createServer(handler);
	const listening = Promise.withResolvers<void>();
	const onError = (error: Error) => listening.reject(error);
	server.once("error", onError);
	server.listen(0, "127.0.0.1", () => {
		server.off("error", onError);
		listening.resolve();
	});
	await listening.promise;

	const address = server.address();
	if (!address || typeof address === "string") {
		await closeLoopbackServer(server);
		throw new Error("expected loopback server address");
	}

	return {
		url: `http://127.0.0.1:${address.port}`,
		close: () => closeLoopbackServer(server),
	};
}

describe("resolveAuthBrokerConfig config discovery", () => {
	let agentDir = "";
	let isolated: IsolatedConfigRoot | undefined;
	let configRoot = "";
	// Discovery also falls back to the machine-wide global config
	// (`~/<VEYYON_CONFIG_DIR>/config.yml`), so every test pins the config dir to
	// a per-test sandbox — otherwise a developer's real ~/.veyyon broker entry
	// would leak into (or break) these assertions.
	let suppressEnv: Record<string, string | undefined> = {};
	let activeStorage: AuthStorage | undefined;
	let stopBrokerServer: (() => Promise<void>) | undefined;

	beforeEach(async () => {
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-broker-config-"));
		// A temp root, not a fresh dot-directory name under the real home: the name form
		// isolates from other suites and writes into the developer's actual home.
		isolated = enterIsolatedConfigRoot("broker-discovery");
		configRoot = isolated.root;
		suppressEnv = {
			VEYYON_AUTH_BROKER_URL: undefined,
			VEYYON_AUTH_BROKER_TOKEN: undefined,
			VEYYON_CONFIG_DIR: isolated.envValue,
		VEYYON_AUTH_BROKER_SNAPSHOT_TTL_MS: undefined,
		};
	});

	afterEach(async () => {
		activeStorage?.close();
		activeStorage = undefined;
		await stopBrokerServer?.();
		stopBrokerServer = undefined;
		if (agentDir) {
			await removeWithRetries(agentDir);
			agentDir = "";
		}
		isolated?.restore();
		isolated = undefined;
		configRoot = "";
	});

	test("resolves broker URL and token from config.yaml when config.yml is absent", async () => {
		await Bun.write(
			path.join(agentDir, "config.yaml"),
			"auth.broker.url: https://yaml-broker.example/v1\nauth.broker.token: yaml-token\n",
		);

		await withEnv(suppressEnv, async () => {
			await expect(resolveAuthBrokerConfig({ agentDir })).resolves.toEqual({
				url: "https://yaml-broker.example/v1",
				token: "yaml-token",
			});
		});
	});

	test("prefers config.yml over config.yaml when both exist", async () => {
		await Bun.write(
			path.join(agentDir, "config.yaml"),
			"auth.broker.url: https://yaml-broker.example/v1\nauth.broker.token: yaml-token\n",
		);
		await Bun.write(
			path.join(agentDir, "config.yml"),
			"auth.broker.url: https://yml-broker.example/v1\nauth.broker.token: yml-token\n",
		);

		await withEnv(suppressEnv, async () => {
			await expect(resolveAuthBrokerConfig({ agentDir })).resolves.toEqual({
				url: "https://yml-broker.example/v1",
				token: "yml-token",
			});
		});
	});

	test("falls back to the machine-wide global config when the profile has no broker keys", async () => {
		// The Settings UI's Global tab writes here (nested form); one machine-wide
		// entry must serve a profile whose own config is silent.
		await fs.mkdir(configRoot, { recursive: true });
		await Bun.write(
			path.join(configRoot, "config.yml"),
			"auth:\n  broker:\n    url: https://global-broker.example/v1\n    token: global-token\n",
		);

		await withEnv(suppressEnv, async () => {
			await expect(resolveAuthBrokerConfig({ agentDir })).resolves.toEqual({
				url: "https://global-broker.example/v1",
				token: "global-token",
			});
		});
	});

	test("the profile's own config overrides the global config per key", async () => {
		// Profile sets only the URL; the token still fills from the global file —
		// per-key precedence, not whole-file shadowing.
		await fs.mkdir(configRoot, { recursive: true });
		await Bun.write(
			path.join(configRoot, "config.yml"),
			"auth:\n  broker:\n    url: https://global-broker.example/v1\n    token: global-token\n",
		);
		await Bun.write(path.join(agentDir, "config.yml"), "auth.broker.url: https://profile-broker.example/v1\n");

		await withEnv(suppressEnv, async () => {
			await expect(resolveAuthBrokerConfig({ agentDir })).resolves.toEqual({
				url: "https://profile-broker.example/v1",
				token: "global-token",
			});
		});
	});

	test("returns null when neither profile nor global config names a broker", async () => {
		await withEnv(suppressEnv, async () => {
			await expect(resolveAuthBrokerConfig({ agentDir })).resolves.toBeNull();
		});
	});

	test("treats an empty env-backed broker URL as unset", async () => {
		await fs.writeFile(
			path.join(agentDir, "config.yml"),
			"auth.broker.url: EMPTY_BROKER_URL\nauth.broker.token: unused-token\n",
		);

		await withEnv({ ...suppressEnv, EMPTY_BROKER_URL: "" }, async () => {
			await expect(resolveAuthBrokerConfig({ agentDir })).resolves.toBeNull();
		});
	});

	test("falls back to the isolated token file when an env-backed config token is empty", async () => {
		await fs.writeFile(
			path.join(agentDir, "config.yml"),
			"auth.broker.url: https://profile-broker.example/v1\nauth.broker.token: EMPTY_BROKER_TOKEN\n",
		);
		await fs.mkdir(configRoot, { recursive: true });
		await fs.writeFile(path.join(configRoot, "auth-broker.token"), "synthetic-broker-token\n");

		await withEnv({ ...suppressEnv, EMPTY_BROKER_TOKEN: "" }, async () => {
			await expect(resolveAuthBrokerConfig({ agentDir })).resolves.toEqual({
				url: "https://profile-broker.example/v1",
				token: "synthetic-broker-token",
			});
		});
	});

	test("non-empty env-backed values still override config literals", async () => {
		await fs.writeFile(
			path.join(agentDir, "config.yml"),
			"auth.broker.url: BROKER_URL_FROM_ENV\nauth.broker.token: BROKER_TOKEN_FROM_ENV\n",
		);

		await withEnv({
			...suppressEnv,
			BROKER_URL_FROM_ENV: "https://env-broker.example/v1",
			BROKER_TOKEN_FROM_ENV: "synthetic-env-token",
		}, async () => {
			await expect(resolveAuthBrokerConfig({ agentDir })).resolves.toEqual({
				url: "https://env-broker.example/v1",
				token: "synthetic-env-token",
			});
		});
	});

	test("does not echo credential-bearing broker URLs when the token is missing", async () => {
		const endpoint =
			"https://synthetic-user:synthetic-password@profile-broker.example/v1?access_token=synthetic-query-token";
		await fs.writeFile(path.join(agentDir, "config.yml"), `auth.broker.url: "${endpoint}"\n`);

		await withEnv(suppressEnv, async () => {
			let caught: unknown;
			try {
				await resolveAuthBrokerConfig({ agentDir });
			} catch (error) {
				caught = error;
			}

			expect(caught).toBeInstanceOf(Error);
			expect((caught as Error).name).toBe("MissingApiKeyError");
			const message = (caught as Error).message;
			expect(message).toContain("VEYYON_AUTH_BROKER_URL");
			expect(message).toContain("no bearer token is available");
			expect(message).toContain("Set VEYYON_AUTH_BROKER_TOKEN");
			expect(message).not.toContain("synthetic-user");
			expect(message).not.toContain("synthetic-password");
			expect(message).not.toContain("synthetic-query-token");
		});
	});
	test("uses credential-safe provenance for broker OAuth and API-key sources", async () => {
		const queryMarker = "synthetic-query-token";
		const fragmentMarker = "synthetic-fragment-token";
		const brokerToken = "synthetic-broker-token";
		const now = Date.now();
		const snapshot: SnapshotResponse = {
			generation: 1,
			generatedAt: now,
			serverNowMs: now,
			refresher: {
				enabled: false,
				intervalMs: 60_000,
				skewMs: 300_000,
				nextSweepInMs: Number.MAX_SAFE_INTEGER,
			},
			credentials: [
				{
					id: 1,
					provider: "anthropic",
					identityKey: null,
					rotatesInMs: null,
					credential: {
						type: "oauth",
						access: "synthetic-oauth-access",
						refresh: REMOTE_REFRESH_SENTINEL,
						expires: now + 60_000,
						email: "synthetic-oauth@example.test",
					},
				},
				{
					id: 2,
					provider: "openai-codex",
					identityKey: null,
					rotatesInMs: null,
					credential: { type: "api_key", key: "synthetic-api-key" },
				},
			],
		};
		let observedQuery: string | null = null;
		let snapshotRequests = 0;
		const server = await startLoopbackServer((request, response) => {
			if (request.headers.authorization !== "Bearer " + brokerToken) {
				response.writeHead(401);
				response.end("unauthorized");
				return;
			}
			if (request.headers.accept?.includes("text/event-stream")) {
				response.writeHead(404);
				response.end();
				return;
			}
			snapshotRequests += 1;
			observedQuery = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("access_token");
			response.writeHead(200, { "content-type": "application/json", etag: '"1"' });
			response.end(JSON.stringify(snapshot));
		});
		stopBrokerServer = server.close;
		// The fake broker accepts the client's request URL to isolate provenance generation;
		// this does not claim query/fragment-bearing broker base URLs are a supported route.
		const serverUrl = server.url.toString();
		const baseUrl = serverUrl.endsWith("/") ? serverUrl.slice(0, -1) : serverUrl;
		const brokerUrl =
			baseUrl +
			"/synthetic-user:synthetic-password?access_token=" +
			queryMarker +
			"#" +
			fragmentMarker;

		await withEnv(
			{
				...suppressEnv,
				VEYYON_AUTH_BROKER_URL: brokerUrl,
				VEYYON_AUTH_BROKER_TOKEN: brokerToken,
				VEYYON_AUTH_BROKER_SNAPSHOT_TTL_MS: "0",
			},
			async () => {
				const storage = await discoverAuthStorage({ agentDir });
				activeStorage = storage;
				try {
					const oauthSource = storage.describeCredentialSource("anthropic");
					const apiKeySource = storage.describeCredentialSource("openai-codex");
					if (!oauthSource || !apiKeySource) throw new Error("expected both synthetic broker credentials");
					expect(oauthSource).toContain("remote broker");
					expect(oauthSource).toContain("oauth");
					expect(apiKeySource).toContain("remote broker");
					expect(apiKeySource).toContain("api_key");
					for (const marker of [
						"synthetic-user",
						"synthetic-password",
						queryMarker,
						fragmentMarker,
					]) {
						expect(oauthSource).not.toContain(marker);
						expect(apiKeySource).not.toContain(marker);
					}
					expect(observedQuery).toBe(queryMarker);
					expect(snapshotRequests).toBeGreaterThan(0);
				} finally {
					storage.close();
					activeStorage = undefined;
				}

				const labelledStorage = await discoverAuthStorage({
					agentDir,
					sourceLabel: "caller-supplied broker label",
				});
				activeStorage = labelledStorage;
				try {
					const source = labelledStorage.describeCredentialSource("anthropic");
					if (!source) throw new Error("expected synthetic OAuth provenance");
					expect(source).toContain("caller-supplied broker label");
				} finally {
					labelledStorage.close();
					activeStorage = undefined;
				}
			},
		);
	});

	test("keeps local SQLite provenance when broker configuration is unset", async () => {
		await withEnv(suppressEnv, async () => {
			const storage = await discoverAuthStorage({ agentDir });
			activeStorage = storage;
			try {
				storage.upsertCredential("anthropic", {
					type: "api_key",
					key: "synthetic-local-api-key",
				});
				const source = storage.describeCredentialSource("anthropic");
				if (!source) throw new Error("expected local credential provenance");
				expect(source).toContain("local ");
				expect(source).toContain("api_key");
				expect(source).not.toContain("remote broker");
			} finally {
				storage.close();
				activeStorage = undefined;
			}
		});
	});

	test("does not fall back to local SQLite when a configured broker returns HTTP 503", async () => {
		let requestCount = 0;
		const server = await startLoopbackServer((_request, response) => {
			requestCount += 1;
			response.writeHead(503);
			response.end("synthetic broker unavailable");
		});
		stopBrokerServer = server.close;
		const brokerUrl = server.url;
		await withEnv(
			{
				...suppressEnv,
				VEYYON_AUTH_BROKER_URL: brokerUrl,
				VEYYON_AUTH_BROKER_TOKEN: "synthetic-broker-token",
				VEYYON_AUTH_BROKER_SNAPSHOT_TTL_MS: "0",
			},
			async () => {
				await expect(discoverAuthStorage({ agentDir })).rejects.toMatchObject({
					name: "AuthBrokerError",
					status: 503,
				});
				expect(requestCount).toBe(1);
			},
		);
	});

});
