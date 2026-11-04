/**
 * WHY: the bundled catalog silently fell 13 providers behind oh-my-pi because nothing compared the two
 * provider sets. `OMP_BUNDLED_PROVIDERS` records the provider ids omp's bundled `models.json` carried at
 * omp `fa786c0d790a6f8408960386530efe95ef45f8c6`. A provider omp bundles that Veyyon does not must sit on
 * `OMP_PROVIDER_OPT_OUTS` with a reason, pinned by exact equality: a new gap fails here until someone
 * ports it or records a decision, and a ported provider fails here until its entry is removed.
 * Gap: this checks provider ids, not rows inside a provider, and it does not re-read omp.
 */
import { describe, expect, test } from "bun:test";
import { getBundledProviders } from "@veyyon/catalog/models";

const OMP_BUNDLED_PROVIDERS: readonly string[] = [
	"abliteration",
	"aiand",
	"aimlapi",
	"alibaba-coding-plan",
	"alibaba-token-plan",
	"amazon-bedrock",
	"anthropic",
	"azure",
	"baseten",
	"bedrock-mantle",
	"cerebras",
	"cline-pass",
	"cloudflare-ai-gateway",
	"commandcode",
	"coreweave",
	"cursor",
	"deepinfra",
	"deepseek",
	"devin",
	"firepass",
	"fireworks",
	"github-copilot",
	"gitlab-duo",
	"gitlab-duo-agent",
	"gmi-cloud",
	"google",
	"google-antigravity",
	"google-gemini-cli",
	"google-vertex",
	"groq",
	"helmcode",
	"huggingface",
	"kilo",
	"kimi-code",
	"local",
	"meta",
	"minimax",
	"minimax-cn",
	"minimax-code",
	"minimax-code-cn",
	"mistral",
	"moonshot",
	"muse-code",
	"nanogpt",
	"novita",
	"nvidia",
	"ollama-cloud",
	"openai",
	"openai-codex",
	"opencode-go",
	"opencode-zen",
	"openrouter",
	"qianfan",
	"qwen-portal",
	"sakana",
	"stepfun",
	"synthetic",
	"together",
	"typesafe",
	"umans",
	"venice",
	"vercel-ai-gateway",
	"wafer-serverless",
	"web",
	"xai",
	"xai-oauth",
	"xiaomi",
	"xiaomi-token-plan-ams",
	"xiaomi-token-plan-cn",
	"xiaomi-token-plan-sgp",
	"yolo-auto",
	"zai",
	"zenmux",
	"zhipu-coding-plan",
];

/** Providers omp bundles that Veyyon does not, each with the reason it is not ported yet. */
const OMP_PROVIDER_OPT_OUTS: Readonly<Record<string, string>> = {
	aiand: "needs the omp KDL seed layer and its reasoning_efforts discovery mapping; no key to discover rows",
	"alibaba-token-plan": "needs the Token Plan credential envelope and usage client; no key to discover rows",
	"bedrock-mantle": "AWS SigV4 and bearer-token auth path; needs an independent auth review before it lands",
	"cline-pass":
		"needs the cline-enabled-false disable mode and the cline-pass wire model id transform in the model contract; no key to discover rows",
	commandcode: 'same provider as the local "command-code" id; renaming would orphan saved credentials',
	deepinfra: "open port, PR 354",
	helmcode: "omp bundles keyed discovery rows hydrated from resold vendors and ships no static seed; no key here",
	local: "open port, PR 351 (synthetic role provider)",
	typesafe: "open port, PR 345",
	web: "open port, PR 351 (synthetic role provider)",
	"yolo-auto":
		"its deepseek-flash-v4 row needs the chat-template thinking format, which the model contract here lacks",
};

describe("bundled provider parity with oh-my-pi", () => {
	test("every provider omp bundles is bundled here or recorded as an opt-out", () => {
		const ours = new Set<string>(getBundledProviders());
		const missing = OMP_BUNDLED_PROVIDERS.filter(id => !ours.has(id)).sort();
		expect(missing).toEqual(Object.keys(OMP_PROVIDER_OPT_OUTS).sort());
	});

	test("an opt-out names a provider omp really bundles", () => {
		const omp = new Set(OMP_BUNDLED_PROVIDERS);
		expect(Object.keys(OMP_PROVIDER_OPT_OUTS).filter(id => !omp.has(id))).toEqual([]);
	});
});
