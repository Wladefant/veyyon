/**
 * A start with no usable credential is diagnosed from the catalog's provider names, and does not
 * build the catalog to do it.
 *
 * WHY: the no-credential sentence counted every catalog model, so a launch with no stored
 * credential built all 4,400 bundled models, about 40 ms of a 112 ms boot, to print one number.
 * The sentence counts providers instead, which the registry reads without building a model.
 *
 * THE CLASS THIS CLOSES. A provider list that differs from the providers the catalog lists: the
 * bundled providers, a models.yml provider and a provider an extension registers at run time,
 * read before the catalog is built, after it, and after a reload drops it again. And a diagnosis
 * that lists the catalog to report missing credentials, for the empty request a start makes and
 * for a named one: either fails the count of `getAll` calls, the only method that builds the
 * whole catalog.
 *
 * NOT COVERED: a request that names a model while another provider has a credential, which lists
 * the catalog to match the id against unauthenticated models, and the empty-registry branch,
 * which a registry holding the bundled catalog cannot reach.
 */
import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Api, Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModels } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { modelResolutionFailureMessage } from "@veyyon/coding-agent/config/model-resolution-failure";
import { useTempDirs } from "../helpers/temp-dirs";

const makeTempDir = useTempDirs();

/** A models.yml provider with one model. */
const CONFIG_PROVIDER = "cfg-gateway";
/** A provider an extension registers at run time; registering it builds the catalog. */
const RUNTIME_PROVIDER = "ext-gateway";

const MODEL_LIMITS = { contextWindow: 64000, maxTokens: 4096 };

/** A registry over an empty auth store, with the models.yml provider when `configProvider` is set. */
async function openRegistry(
	configProvider: boolean,
): Promise<{ registry: ModelRegistry; authStorage: AuthStorage; modelsPath: string }> {
	const dir = makeTempDir("@no-credential-");
	const modelsPath = path.join(dir, "models.yml");
	if (configProvider) {
		await fs.writeFile(
			modelsPath,
			JSON.stringify({
				providers: {
					[CONFIG_PROVIDER]: {
						baseUrl: "https://cfg.example.com/v1",
						api: "openai-completions",
						apiKey: "literal:TEST_KEY",
						models: [{ id: "cfg-model", name: "cfg-model", ...MODEL_LIMITS }],
					},
				},
			}),
		);
	}
	const authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
	return { registry: new ModelRegistry(authStorage, modelsPath, { snapshotIo: false }), authStorage, modelsPath };
}

/** Registers the runtime provider; `removes` names a provider whose models its sign-in drops. */
function registerRuntimeProvider(registry: ModelRegistry, removes?: string): void {
	registry.registerProvider(RUNTIME_PROVIDER, {
		baseUrl: "https://ext.example.com/v1",
		apiKey: "literal:TEST_KEY",
		api: "openai-completions",
		models: [
			{
				id: "ext-model",
				name: "Ext Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				...MODEL_LIMITS,
			},
		],
		oauth:
			removes === undefined
				? undefined
				: {
						name: "Ext Gateway",
						login: async () => "test-token",
						modifyModels: models => models.filter(model => model.provider !== removes),
					},
	});
}

/** Providers in the order the catalog first lists them. */
function providersListedBy(models: readonly Model<Api>[]): string[] {
	return [...new Set(models.map(model => model.provider))];
}

describe("ModelRegistry.getProviders", () => {
	it("names the providers the catalog lists, in its order, whether or not the catalog is built", async () => {
		const { registry, modelsPath } = await openRegistry(true);
		const unbuilt = registry.getProviders();
		const catalog = registry.getAll();
		expect(unbuilt).toEqual(providersListedBy(catalog));
		expect(unbuilt).toContain(CONFIG_PROVIDER);
		expect(registry.getProviders()).toEqual(providersListedBy(catalog));

		registerRuntimeProvider(registry);
		const registered = registry.getProviders();
		expect(registered).toContain(RUNTIME_PROVIDER);
		expect(registered).toEqual(providersListedBy(registry.getAll()));

		// A changed models.yml reloads the static models and drops the built catalog; the runtime
		// provider survives the reload, so the unbuilt list has to name it too.
		const later = new Date(Date.now() + 60_000);
		await fs.utimes(modelsPath, later, later);
		await registry.refresh("offline");
		const reloaded = registry.getProviders();
		expect(reloaded).toEqual(providersListedBy(registry.getAll()));
		expect(reloaded).toContain(RUNTIME_PROVIDER);
	});

	it("leaves out a provider a sign-in removed every model of, once the catalog is built", async () => {
		const { registry, authStorage } = await openRegistry(false);
		await authStorage.set(RUNTIME_PROVIDER, {
			type: "oauth",
			access: "test-token",
			refresh: "test-refresh",
			expires: Date.now() + 100_000,
		});
		expect(registry.getProviders()).toContain("anthropic");

		registerRuntimeProvider(registry, "anthropic");

		const providers = registry.getProviders();
		expect(providers).not.toContain("anthropic");
		expect(providers).toContain(RUNTIME_PROVIDER);
		expect(providers).toEqual(providersListedBy(registry.getAll()));
	});
});

describe("a registry with no usable credential", () => {
	const bundled = getBundledModels("anthropic")[0];
	for (const requested of [[], ["no-such-model"], [`${bundled.provider}/${bundled.id}`]]) {
		it(`is reported as an authentication failure without listing the catalog, for ${JSON.stringify(requested)}`, async () => {
			const { registry } = await openRegistry(false);
			const listing = spyOn(registry, "getAll");
			expect(registry.getAvailable()).toEqual([]);

			const message = modelResolutionFailureMessage(requested, registry);

			expect(listing.mock.calls.length).toBe(0);
			const providers = registry.getProviders();
			expect(message).toStartWith(
				`No models are available: the registry knows models from ${providers.length} provider(s) but none has usable credentials`,
			);
			expect(message).toContain(`for one of ${providers.slice(0, 5).join(", ")}, or set`);
		});
	}
});
