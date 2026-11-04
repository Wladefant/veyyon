/**
 * The pinned Codex client version must be new enough for every model the Codex registry serves.
 *
 * WHY THIS SUITE EXISTS. The Codex backend filters `/codex/models` by the `client_version` the caller sends.
 * A model above that version is OMITTED from the response: the list is a little shorter, with no error, no
 * warning and no "unsupported" row. `CODEX_CLIENT_VERSION` sat at `0.153.2` while OpenAI shipped `gpt-6-sol`,
 * `gpt-6-luna` and `gpt-6.1-sol`, so every discovery run, every model picker and every regeneration of
 * `models.json` quietly went without them. The endpoint also gates independently of a row's declared
 * `minimal_client_version` (`gpt-6.1-sol` declares `0.153.0` yet is absent at `0.155.1` and present at
 * `0.159.0`), so the declared number cannot be trusted and this file pins the versions the registry was
 * OBSERVED to list each model at.
 *
 * THE CLASS IT CLOSES. "A model the registry serves is hidden by a stale client-version pin." Three checks:
 *   1. every bundled frontier row (GPT-6 and later) has a recorded gate, so a model the next regeneration adds
 *      turns this red until someone records the version that lists it;
 *   2. the pin is at or above every recorded gate and every recorded model is bundled, so bumping a gate
 *      without the pin, or the pin without regenerating, both fail;
 *   3. discovery run at its default version against a registry that applies the same gate returns every
 *      recorded model, so a pin that is right but never reaches the wire (a hardcoded literal, a header and
 *      query string that disagree) fails too.
 *
 * WHAT IT DOES NOT CATCH. It reads no live registry, so a model OpenAI ships and nobody bundles or records
 * is invisible here: a credentialed `bun run gen:models --providers=openai-codex` is what finds those. The gate
 * table is evidence from probes on 2026-09-29 and 2026-09-30, and it is only as current as its last update.
 */
import { describe, expect, it } from "bun:test";
import { fetchCodexModels } from "@veyyon/catalog/discovery/codex";
import { getBundledModels } from "@veyyon/catalog/models";
import { CODEX_CLIENT_VERSION } from "@veyyon/catalog/wire/codex";

/** The client version at which the live registry began listing each model. */
const REGISTRY_GATES: Readonly<Record<string, string>> = {
	"gpt-6-astra": "0.153.0",
	"gpt-6-sol": "0.155.1",
	"gpt-6-luna": "0.155.1",
	"gpt-6.1-sol": "0.159.0",
};

function parseVersion(version: string): [number, number, number] {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!match) throw new Error(`not a x.y.z version: ${version}`);
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Positive when `left` is newer than `right`. */
function compareVersions(left: string, right: string): number {
	const a = parseVersion(left);
	const b = parseVersion(right);
	for (let index = 0; index < 3; index++) {
		if (a[index] !== b[index]) return a[index] - b[index];
	}
	return 0;
}

/** The bundled rows the registry gates by version: GPT-6 and later. */
function bundledFrontierIds(): string[] {
	return getBundledModels("openai-codex")
		.map(model => model.id)
		.filter(id => {
			const major = /^gpt-(\d+)/.exec(id)?.[1];
			return major !== undefined && Number(major) >= 6;
		});
}

/** A registry that omits every model whose gate is above the `client_version` it is asked with. */
function gatedRegistry(seen: { queryVersion?: string; headerVersion?: string | null }): typeof fetch {
	return Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			const queryVersion = url.searchParams.get("client_version") ?? undefined;
			seen.queryVersion = queryVersion;
			seen.headerVersion = new Headers(init?.headers).get("version");
			const models = Object.entries(REGISTRY_GATES)
				.filter(([, gate]) => queryVersion !== undefined && compareVersions(queryVersion, gate) >= 0)
				.map(([slug]) => ({
					slug,
					display_name: slug,
					context_window: 272_000,
					default_reasoning_level: "medium",
					supported_reasoning_levels: ["low", "medium", "high"],
					input_modalities: ["text", "image"],
					supported_in_api: true,
				}));
			return new Response(JSON.stringify({ models }));
		},
		{ preconnect() {} },
	);
}

describe("the Codex client version is new enough for every model the registry serves", () => {
	it("records a gate for every bundled GPT-6-and-later row", () => {
		const unrecorded = bundledFrontierIds().filter(id => REGISTRY_GATES[id] === undefined);
		expect(unrecorded).toEqual([]);
	});

	it("pins a version at or above every recorded gate, and bundles every recorded model", () => {
		const bundled = new Set(bundledFrontierIds());
		const hidden = Object.entries(REGISTRY_GATES)
			.filter(([, gate]) => compareVersions(CODEX_CLIENT_VERSION, gate) < 0)
			.map(([id]) => id);
		const unbundled = Object.keys(REGISTRY_GATES).filter(id => !bundled.has(id));
		expect({ hidden, unbundled }).toEqual({ hidden: [], unbundled: [] });
	});

	it("discovery at its default version receives every recorded model, with header and query in step", async () => {
		const seen: { queryVersion?: string; headerVersion?: string | null } = {};
		const result = await fetchCodexModels({ accessToken: "test-token", fetchFn: gatedRegistry(seen) });

		expect(seen.queryVersion).toBe(CODEX_CLIENT_VERSION);
		expect(seen.headerVersion).toBe(CODEX_CLIENT_VERSION);
		expect(result?.models.map(model => model.id).sort()).toEqual(Object.keys(REGISTRY_GATES).sort());
	});
});
