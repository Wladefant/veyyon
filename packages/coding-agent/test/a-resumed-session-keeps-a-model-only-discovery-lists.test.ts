/**
 * A resumed session runs on the model it last ran, even when that model exists only through a
 * provider's discovery listing and the registry does not list it yet.
 *
 * Defect: a resume looked the session's model up in the registry, which before discovery runs
 * holds the bundled catalog plus whatever the discovery cache yields. A cold cache (a deleted
 * `models.db`, a new machine) or a rejected one (the first launch after the cache schema
 * version changes) yields nothing, so a discovery-only model was not found. A launch resume
 * then started on the settings default or another authenticated provider's model, and an
 * in-process switch made before the background refresh finished kept the current model. The
 * refresh discovered the model afterwards, too late.
 *
 * Class closed: both entry points a session's model is restored through, `--resume` at launch
 * and an in-process switch (`/resume`, the picker, RPC `switch_session`). Each discovers the
 * providers of the preferred models the registry does not list, once, before choosing.
 *
 * Bounds pinned: a resume whose model the registry already lists sends no discovery request,
 * and neither does one whose provider has no credential.
 *
 * Not caught: a provider whose listing no longer includes the model. That resume still falls
 * back, by design, and reports the model it could not restore.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import type { FetchImpl } from "@veyyon/ai/types";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { Snowflake } from "@veyyon/utils";

const BASE_URL = "https://example.com/v1";
const DISCOVERED = "my-provider/some-model";
const LISTED = `openai/${getBundledModel("openai", "gpt-4.1").id}`;
const BOTH_KEYS = { "my-provider": "test-provider-key", openai: "test-openai-key" };

/** How the session file is reopened. */
type Entry = "launch" | "switch";
const ENTRIES: Entry[] = ["launch", "switch"];

describe("a resumed session keeps a model only discovery lists", () => {
	let tempDir: string;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `veyyon-resume-discovered-model-${Snowflake.next()}-`));
	});

	afterEach(() => {
		for (const authStorage of authStorages) authStorage.close();
		authStorages.length = 0;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	/** `models.yml` with one provider that ships no static models and lists them through discovery. */
	function writeDiscoveryProvider(): string {
		const modelsPath = path.join(tempDir, "models.yml");
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  my-provider:",
				`    baseUrl: ${BASE_URL}`,
				"    api: openai-completions",
				"    apiKey: MY_API_KEY",
				"    discovery:",
				"      type: openai-models-list",
				"",
			].join("\n"),
		);
		return modelsPath;
	}

	/** A session whose last model change selected `model`. */
	function writeSession(model: string): string {
		const file = path.join(tempDir, `session-${Snowflake.next()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		const entries = [
			{ type: "session", version: 3, id: `session-${Snowflake.next()}`, timestamp, cwd: tempDir },
			{ type: "model_change", id: "model", parentId: null, timestamp, model, role: "default" },
		];
		fs.writeFileSync(file, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
		return file;
	}

	/** Serves `some-model` on the provider's `/models` route and counts every request. */
	function discovery(): { fetch: FetchImpl; calls: () => number } {
		let calls = 0;
		const fetch: FetchImpl = async input => {
			calls++;
			if (String(input) === `${BASE_URL}/models`) return Response.json({ data: [{ id: "some-model" }] });
			return new Response("not found", { status: 404 });
		};
		return { fetch, calls: () => calls };
	}

	/**
	 * Reopen a session that last ran `sessionModel` through `entry`, against a fresh registry over
	 * an empty cache, and return the model it runs on. `switch` starts a new session on the settings
	 * default and switches to the file, as `/resume` does.
	 */
	async function reopen(
		entry: Entry,
		options: { sessionModel: string; providerKeys: Record<string, string>; defaultModel?: string; fetch: FetchImpl },
	): Promise<string | undefined> {
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorages.push(authStorage);
		for (const [provider, key] of Object.entries(options.providerKeys)) authStorage.setRuntimeApiKey(provider, key);
		const modelRegistry = new ModelRegistry(authStorage, writeDiscoveryProvider(), { fetch: options.fetch });
		const settings = Settings.isolated();
		if (options.defaultModel) settings.setDefaultModel(options.defaultModel);
		const sessionFile = writeSession(options.sessionModel);
		const sessionDir = path.join(tempDir, "sessions");
		const sessionManager =
			entry === "launch"
				? await SessionManager.open(sessionFile, sessionDir)
				: SessionManager.create(tempDir, sessionDir);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		try {
			if (entry === "switch") expect(await session.switchSession(sessionFile)).toBe(true);
			return session.model ? `${session.model.provider}/${session.model.id}` : undefined;
		} finally {
			await session.dispose();
		}
	}

	test.each([
		...ENTRIES.map(entry => ({ entry, fallback: "a configured settings default", defaultModel: LISTED })),
		{ entry: "launch" as Entry, fallback: "another authenticated provider", defaultModel: undefined },
	])("$entry restores the discovered model over $fallback", async ({ entry, defaultModel }) => {
		const model = await reopen(entry, {
			sessionModel: DISCOVERED,
			providerKeys: BOTH_KEYS,
			defaultModel,
			fetch: discovery().fetch,
		});
		expect(model).toBe(DISCOVERED);
	});

	test.each(ENTRIES)("%s sends no discovery request when the registry lists the session model", async entry => {
		const counted = discovery();
		const model = await reopen(entry, {
			sessionModel: LISTED,
			providerKeys: BOTH_KEYS,
			defaultModel: LISTED,
			fetch: counted.fetch,
		});
		expect(model).toBe(LISTED);
		expect(counted.calls()).toBe(0);
	});

	test.each(ENTRIES)("%s sends no discovery request for a provider with no credential", async entry => {
		const counted = discovery();
		const model = await reopen(entry, {
			sessionModel: DISCOVERED,
			providerKeys: { openai: "test-openai-key" },
			defaultModel: LISTED,
			fetch: counted.fetch,
		});
		expect(model).toBe(LISTED);
		expect(counted.calls()).toBe(0);
	});
});
