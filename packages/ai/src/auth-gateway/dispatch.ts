/**
 * Per-request plumbing shared by every auth-gateway route.
 *
 * Route modules (chat/pi-native handlers in server.ts, media handlers in
 * routes/*.ts) own only their wire format: parse the body, pick a model, call
 * the client, encode the reply. Credential resolution, session identity,
 * auth rotation, and usage recording live here so each route drives the same
 * broker-backed policies.
 */
import * as logger from "@veyyon/utils/logger";
import type { AuthStorage } from "../auth-storage";
import { classifyGatewayError, type GatewayErrorClassification } from "../error/gateway";
import type { Api, FetchImpl, Model } from "../types";
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
	/** Upstream transport for every provider call; defaults to global fetch. */
	fetch?: FetchImpl;
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

export function mirrorRequestAbort(req: Request): AbortController {
	const controller = new AbortController();
	if (req.signal.aborted) {
		controller.abort(req.signal.reason);
	} else {
		req.signal.addEventListener("abort", () => controller.abort(req.signal.reason), { once: true });
	}
	return controller;
}
