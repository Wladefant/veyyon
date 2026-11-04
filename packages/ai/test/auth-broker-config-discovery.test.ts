import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveAuthBrokerConfig } from "@veyyon/ai/auth-broker";
import { removeWithRetries } from "../../utils/src/temp";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../utils/test/helpers/isolated-config-root";
import { withEnv } from "./helpers";

describe("resolveAuthBrokerConfig config discovery", () => {
	let agentDir = "";
	let isolated: IsolatedConfigRoot | undefined;
	let configRoot = "";
	// Discovery also falls back to the machine-wide global config
	// (`~/<VEYYON_CONFIG_DIR>/config.yml`), so every test pins the config dir to
	// a per-test sandbox — otherwise a developer's real ~/.veyyon broker entry
	// would leak into (or break) these assertions.
	let suppressEnv: Record<string, string | undefined> = {};

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
		};
	});

	afterEach(async () => {
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
		await Bun.write(
			path.join(agentDir, "config.yml"),
			"auth.broker.url: EMPTY_BROKER_URL\nauth.broker.token: unused-token\n",
		);

		await withEnv({ ...suppressEnv, EMPTY_BROKER_URL: "" }, async () => {
			await expect(resolveAuthBrokerConfig({ agentDir })).resolves.toBeNull();
		});
	});

	test("falls back to the isolated token file when an env-backed config token is empty", async () => {
		await Bun.write(
			path.join(agentDir, "config.yml"),
			"auth.broker.url: https://profile-broker.example/v1\nauth.broker.token: EMPTY_BROKER_TOKEN\n",
		);
		await fs.mkdir(configRoot, { recursive: true });
		await Bun.write(path.join(configRoot, "auth-broker.token"), "synthetic-broker-token\n");

		await withEnv({ ...suppressEnv, EMPTY_BROKER_TOKEN: "" }, async () => {
			await expect(resolveAuthBrokerConfig({ agentDir })).resolves.toEqual({
				url: "https://profile-broker.example/v1",
				token: "synthetic-broker-token",
			});
		});
	});

	test("non-empty env-backed values still override config literals", async () => {
		await Bun.write(
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
		await Bun.write(path.join(agentDir, "config.yml"), `auth.broker.url: "${endpoint}"\n`);

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
});
