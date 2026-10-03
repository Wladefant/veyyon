/**
 * WHY THIS SUITE EXISTS.
 *
 * THE DEFECT IT CLOSES. The `ai` package loads each provider client through `import()` on its first
 * turn (`providers/register-builtins.ts`), and loads the server-side compaction request on the first
 * compaction (`providers/openai-compaction.ts`). A launch still evaluated three of them statically: the
 * session imported the Anthropic fast-mode reset and the Claude device id from `providers/anthropic.ts`,
 * compaction and `/session` imported the Codex session-state readers from
 * `providers/openai-codex-responses.ts`, and `openai-compaction.ts` imported its own request half. A
 * session on any model paid for the Anthropic and Codex clients and the Responses compaction encoder
 * before its first request.
 *
 * THE CLASS. A module the `ai` package loads through `import()` is reached statically from a launch entry.
 * The set is read at run time from every `import("...")` under `packages/ai/src`, so a new lazy provider
 * module is covered when it is written, and the subset `main.ts` and `sdk.ts` reach statically is pinned
 * by exact equality: a module that becomes reachable turns this red until it is recorded below with the
 * reason the launch needs it.
 *
 * THE SIBLING. A helper shared by the provider clients is not loaded through `import()`, so the sweep
 * above does not see it: the remote summarizer took the Azure deployment map from
 * `providers/openai-shared.ts`, which put the OpenAI request builders, the message transform and the
 * vision guard (8 modules, 197 KiB) on every launch. Every module under `packages/ai/src/providers` a
 * launch entry reaches is pinned by exact equality as well, so a new provider module on the launch graph
 * turns this red whether or not anything loads it lazily.
 *
 * WHAT IT DOES NOT CATCH. The walk is static, so a module loaded through `await import(...)` from a launch
 * module is outside it by design. Size is not measured: a module recorded below can grow without limit.
 * That a turn still streams through each lazily loaded client is the provider suites' contract.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { dynamicImportSpecifiersIn, moduleReach, resolveModuleSpecifier } from "@veyyon/utils/module-reach";
import { CACHE, PACKAGES, RESOLUTION, SRC } from "../helpers/module-reach-gate";

const AI_SRC = path.join(PACKAGES, "ai", "src");
const PROVIDERS = path.join(AI_SRC, "providers");

/**
 * The provider modules a launch reaches, each with the reason. The clients themselves load through
 * `providers/register-builtins.ts` on a session's first request.
 */
const LAUNCH_PROVIDER_MODULES = [
	// The session clears the Anthropic fast-mode fallback when the model changes.
	"providers/anthropic-session-state.ts",
	// The remote summarizer maps an Azure model id to its deployment name.
	"providers/azure-deployment-names.ts",
	// The provider request derives the Claude Code device id header.
	"providers/claude-device-id.ts",
	// The GitLab Duo and OpenAI-Anthropic routers format a failed stream's message through it.
	"providers/error-message.ts",
	// `stream.ts` routes a GitLab Duo, Kimi or Synthetic model to the client that serves it, streams a
	// pi-native model and resolves a Vertex access token before dispatch.
	"providers/gitlab-duo.ts",
	"providers/google-auth.ts",
	// The provider wire counts the Gemini thought signatures a request elides.
	"providers/google-thought-signatures.ts",
	"providers/kimi.ts",
	// Kimi and Synthetic route through it to the Anthropic or OpenAI client.
	"providers/openai-anthropic-shim.ts",
	// Compaction and the startup prewarm read the Codex transport details and reset its history.
	"providers/openai-codex/session-state.ts",
	// Remote compaction resolves the server-side compaction transport; the request half loads on use.
	"providers/openai-compaction.ts",
	// The Codex session state normalizes its prompt cache key.
	"providers/openai-stable-ids.ts",
	"providers/pi-native-client.ts",
	// The table of lazy client loaders.
	"providers/register-builtins.ts",
	"providers/synthetic.ts",
];

/** Every module a file under `packages/ai/src` loads through `import()`, as paths relative to it, sorted. */
function lazyAiModules(): string[] {
	const lazy = new Set<string>();
	for (const name of fs.readdirSync(AI_SRC, { recursive: true, encoding: "utf8" })) {
		if (!name.endsWith(".ts")) continue;
		const file = path.join(AI_SRC, name);
		for (const specifier of dynamicImportSpecifiersIn(fs.readFileSync(file, "utf8"))) {
			const target = resolveModuleSpecifier(file, specifier, RESOLUTION);
			if (target?.startsWith(`${AI_SRC}${path.sep}`)) lazy.add(path.relative(AI_SRC, target));
		}
	}
	return [...lazy].sort();
}

function reachedLazy(entry: string): string[] {
	const reached = moduleReach(path.join(SRC, entry), RESOLUTION, CACHE);
	return lazyAiModules().filter(name => reached.has(path.join(AI_SRC, name)));
}

/** Every module under `packages/ai/src/providers` the entry reaches, as paths relative to `packages/ai/src`, sorted. */
function reachedProviders(entry: string): string[] {
	const reached = moduleReach(path.join(SRC, entry), RESOLUTION, CACHE);
	return fs
		.readdirSync(PROVIDERS, { recursive: true, encoding: "utf8" })
		.filter(name => name.endsWith(".ts"))
		.map(name => path.join(PROVIDERS, name))
		.filter(file => reached.has(file))
		.map(file => path.relative(AI_SRC, file))
		.sort();
}

describe("a launch loads no provider client", () => {
	it("reads a lazy module set worth judging", () => {
		expect(lazyAiModules()).toEqual(
			expect.arrayContaining([
				"providers/anthropic.ts",
				"providers/openai-codex-responses.ts",
				"providers/openai-compaction-request.ts",
			]),
		);
	});

	for (const entry of ["main.ts", "sdk.ts"]) {
		it(`${entry} statically reaches only the lazy ai modules recorded here`, () => {
			expect(reachedLazy(entry)).toEqual([
				// `getKimiCommonHeaders`, which the Kimi stream and the Kimi usage reader send on every request,
				// is declared beside the device-code login that `registry/kimi-code.ts` loads on first use.
				"registry/oauth/kimi.ts",
			]);
		});

		it(`${entry} statically reaches only the provider modules recorded here`, () => {
			expect(reachedProviders(entry)).toEqual(LAUNCH_PROVIDER_MODULES);
		});
	}
});
