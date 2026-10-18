/**
 * The one module that knows every usage backend.
 *
 * Importing this module IS the wiring: it fills the registry in `usage/registry.ts` at module scope,
 * and until something imports it the registry refuses to answer rather than reporting no usage for
 * everything. That refusal is deliberate — see `assertPopulated` there.
 *
 * The imports below pull provider transports and, through `usage/claude`, the streaming engine; keeping
 * them here means the credential store does not pay for them, and that a new backend is added in one
 * place instead of two.


import type { Provider } from "../types";
import type { CredentialRankingStrategy, UsageProvider } from "../usage";
import { alibabaTokenPlanRankingStrategy, alibabaTokenPlanUsageProvider } from "./alibaba-token-plan";
import { charmHyperUsageProvider } from "./charm-hyper";
import { claudeRankingStrategy, claudeUsageProvider } from "./claude";
import { clinePassUsageProvider } from "./cline-pass";
import { commandCodeRankingStrategy, commandCodeUsageProvider } from "./commandcode";
import { cursorRankingStrategy, cursorUsageProvider } from "./cursor";
import { devinUsageProvider } from "./devin";
import { factoryDroidRankingStrategy, factoryDroidUsageProvider } from "./factory-droid";
import { googleGeminiCliUsageProvider } from "./gemini";
import { githubCopilotUsageProvider } from "./github-copilot";
import { antigravityRankingStrategy, antigravityUsageProvider } from "./google-antigravity";
import { kimiRankingStrategy, kimiUsageProvider } from "./kimi";
import { minimaxCodeUsageProvider } from "./minimax-code";
import { museCodeUsageProvider } from "./muse-code";
import { ollamaCloudUsageProvider, ollamaUsageProvider } from "./ollama";
import { codexRankingStrategy, openaiCodexUsageProvider } from "./openai-codex";
import { opencodeGoRankingStrategy, opencodeGoUsageProvider } from "./opencode-go";
import { syntheticUsageProvider } from "./synthetic";
import { umansUsageProvider } from "./umans";
import { xaiOauthRankingStrategy, xaiOauthUsageProvider } from "./xai-oauth";
import { zaiRankingStrategy, zaiUsageProvider } from "./zai";
import { registerUsageProviders } from "./registry";

/** Every implemented provider usage backend, in the established probe order. */
export const DEFAULT_USAGE_PROVIDERS: readonly UsageProvider[] = [
	alibabaTokenPlanUsageProvider,
	openaiCodexUsageProvider,
	kimiUsageProvider,
	minimaxCodeUsageProvider,
	museCodeUsageProvider,
	antigravityUsageProvider,
	googleGeminiCliUsageProvider,
	ollamaUsageProvider,
	factoryDroidUsageProvider,
	ollamaCloudUsageProvider,
	claudeUsageProvider,
	clinePassUsageProvider,
	zaiUsageProvider,
	umansUsageProvider,
	opencodeGoUsageProvider,
	githubCopilotUsageProvider,
	cursorUsageProvider,
	syntheticUsageProvider,
	xaiOauthUsageProvider,
	devinUsageProvider,
	charmHyperUsageProvider,
	commandCodeUsageProvider,
];

/** Providers with a usage-aware credential-ranking strategy. */
export const DEFAULT_RANKING_STRATEGIES: readonly (readonly [Provider, CredentialRankingStrategy])[] = [
	["alibaba-token-plan", alibabaTokenPlanRankingStrategy],
	["openai-codex", codexRankingStrategy],
	["anthropic", claudeRankingStrategy],
	["cursor", cursorRankingStrategy],
	["google-antigravity", antigravityRankingStrategy],
	["factory-droid", factoryDroidRankingStrategy],
	["kimi-code", kimiRankingStrategy],
	["zai", zaiRankingStrategy],
	["opencode-go", opencodeGoRankingStrategy],
	["xai-oauth", xaiOauthRankingStrategy],
	["commandcode", commandCodeRankingStrategy],
];

registerUsageProviders({ providers: DEFAULT_USAGE_PROVIDERS, rankingStrategies: DEFAULT_RANKING_STRATEGIES });
