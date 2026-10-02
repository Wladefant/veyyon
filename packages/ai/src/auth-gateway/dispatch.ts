/**
 * Per-request plumbing shared by every auth-gateway route.
 *
 * Route modules (chat/pi-native handlers in server.ts, media handlers in
 * routes/*.ts) own only their wire format: parse the body, pick a model, call
 * the client, encode the reply. Credential resolution, session identity,
 * auth rotation, and usage recording live here so each route drives the same
 * broker-backed policies.
 */
import { extractRetryHint } from "@veyyon/utils/fetch-retry";
import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import type { ApiKeyResolver } from "../auth-retry";
import type { AuthStorage } from "../auth-storage";
import * as AIError from "../error";
import { classifyGatewayError, type GatewayErrorClassification } from "../error/gateway";
import type { Api, Model, Usage } from "../types";
import type { AuthGatewayServerOptions } from "./types";

export interface ClientUsageIdentity {
	installId?: string;
	hostname?: string;
	app?: string;
}

export type ModelResolver = (modelId: string) => Model<Api> | undefined;

export interface AuthGatewayBootOptions extends AuthGatewayServerOptions {
	/** Source of credentials. Caller wires this to a broker-backed AuthStorage. */
	storage: AuthStorage;
	/** Resolve a client-requested model id to a Model. */
	resolveModel: ModelResolver;
	/** Optional supplier for /v1/models listing. Returns the full model array. */
	listModels?: () => Iterable<Model<Api>>;
}

export function normalizeClientSessionKey(clientKey: string | undefined): string | undefined {
	return clientKey !== undefined && clientKey.trim().length > 0 ? clientKey : undefined;
}

export function resolveGatewayAccount(
	storage: AuthStorage,
	provider: string,
	sessionId: string,
	apiKey: string,
): string {
	const identity = storage.getOAuthAccountIdentity(provider, sessionId);
	if (identity) {
		return `oauth:${JSON.stringify([
			identity.accountId ?? "",
			identity.email ?? "",
			identity.projectId ?? "",
			identity.orgId ?? "",
		])}`;
	}
	return `key:${Bun.hash(apiKey).toString(36)}`;
}

export async function resolveGatewayApiKey(
	storage: AuthStorage,
	model: Model<Api>,
	sessionId: string,
	signal: AbortSignal,
	peer: string,
): Promise<string | GatewayErrorClassification> {
	let apiKey: string | undefined;
	try {
		apiKey = await storage.getApiKey(model.provider, sessionId, { modelId: model.id, signal });
	} catch (error) {
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway getApiKey threw", { provider: model.provider, peer, error: classified.message });
		return classified;
	}
	if (apiKey) return apiKey;
	return {
		status: 401,
		type: "authentication_error",
		message: `No credential available for provider ${model.provider}`,
	};
}

async function refreshGatewayApiKeyAfterAuthError(
	storage: AuthStorage,
	model: Model<Api>,
	sessionId: string,
	provider: string,
	oldKey: string,
	error: unknown,
	signal: AbortSignal,
	format: string,
	peer: string,
): Promise<string | undefined> {
	const message = errorMessage(error);
	if (AIError.isUsageLimit(error)) {
		const retryAfterMs = extractRetryHint(undefined, message);
		const { switched, retryAtMs } = await storage.markUsageLimitReached(provider, sessionId, {
			retryAfterMs,
			baseUrl: model.baseUrl,
			modelId: model.id,
			apiKey: oldKey,
			signal,
		});
		logger.debug("auth-gateway retrying provider request after usage-limit block", {
			format, provider, peer, switched, retryAfterMs, retryAtMs, error: message,
		});
		if (!switched) return undefined;
		return storage.getApiKey(provider, sessionId, { modelId: model.id, signal });
	}
	await storage.invalidateCredentialMatching(provider, oldKey, { sessionId, signal });
	logger.debug("auth-gateway retrying provider request after credential invalidation", {
		format, provider, peer, error: message,
	});
	return storage.getApiKey(provider, sessionId, { modelId: model.id, signal });
}

export function buildGatewayApiKeyResolver(
	storage: AuthStorage,
	model: Model<Api>,
	sessionId: string,
	initialKey: string,
	requestSignal: AbortSignal,
	format: string,
	peer: string,
	onResolvedKey?: (apiKey: string) => void,
): ApiKeyResolver {
	let lastKey = initialKey;
	return async ({ lastChance, error, signal }) => {
		const sig = signal ?? requestSignal;
		if (error === undefined) {
			lastKey = initialKey;
			return initialKey;
		}
		if (!lastChance) {
			const refreshed = await storage.getApiKey(model.provider, sessionId, {
				modelId: model.id,
				signal: sig,
				forceRefresh: true,
			});
			lastKey = refreshed ?? lastKey;
			if (refreshed) onResolvedKey?.(refreshed);
			return refreshed;
		}
		const next = await refreshGatewayApiKeyAfterAuthError(
			storage, model, sessionId, model.provider, lastKey, error, sig, format, peer,
		);
		lastKey = next ?? lastKey;
		if (next) onResolvedKey?.(next);
		return next;
	};
}

export type GatewayStorage = AuthStorage & {
	recordObservedUsage?(entry: {
		provider: string;
		model: string;
		at?: number;
		usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
		costUsd: number;
		client: ClientUsageIdentity;
	}): void;
};

export function recordGatewayUsage(
	storage: GatewayStorage,
	model: Model<Api>,
	client: ClientUsageIdentity,
	usage: Usage,
	at?: number,
): void {
	if (usage.input + usage.output + usage.cacheRead + usage.cacheWrite === 0) return;
	storage.recordObservedUsage?.({
		provider: model.provider,
		model: model.id,
		at,
		usage: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite },
		costUsd: usage.cost.total,
		client,
	});
	if (usage.cost.total > 0) {
		storage.recordUsageCost?.(model.provider, usage.cost.total, at !== undefined ? { recordedAt: at } : undefined);
	}
}

export function mirrorRequestAbort(req: Request): AbortController {
	const controller = new AbortController();
	if (req.signal.aborted) {
		controller.abort(req.signal.reason);
	} else {
		req.signal.addEventListener("abort", () => controller.abort(req.signal.reason), { once: true });
	}
	return controller;
}
