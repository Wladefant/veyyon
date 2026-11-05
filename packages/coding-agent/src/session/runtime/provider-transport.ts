/**
 * The provider hooks every request of a session runs with, and the transport its side requests share.
 *
 * This is a session collaborator. It reaches the session only through {@link ProviderTransportHost}.
 *
 * - The response and raw SSE interceptors are installed on the agent at construction, and the
 *   advisors take the same pair, so every request records into one raw SSE buffer and one usage
 *   ledger.
 * - A side request is one the session makes for itself rather than for the conversation: a
 *   summarization, a handoff, a title, a tree navigation summary. {@link ProviderTransport.sideComplete}
 *   runs one on the side stream function, which applies the provider settings (the stream idle and
 *   first-event watchdogs, the in-flight cap, the concurrency limiter) that a bare `completeSimple`
 *   omits.
 * - {@link ProviderTransport.prepare} puts the session's hooks, metadata and provider settings on the
 *   options of a side request that builds its own.
 */
import type { Agent, StreamFn } from "@veyyon/agent-core";
import type { Api, AssistantMessage, Context, Model, ProviderResponseMetadata, SimpleStreamOptions } from "@veyyon/ai";
import { streamSimple } from "@veyyon/ai/stream";
import type { SideCompleteImpl } from "@veyyon/kernel/session/side-complete";
import { validateProviderMaxInFlightRequests } from "../../config/settings";
import type { SettingValue } from "../../config/settings-schema";
import { RawSseDebugBuffer } from "../../debug/raw-sse-buffer";
import type { AgentSessionConfig, SecretRuntimeLease } from "../agent-session-types";

/** The transport inputs of an {@link AgentSessionConfig}. */
export type ProviderTransportConfig = Pick<
	AgentSessionConfig,
	"sideStreamFn" | "rawSseDebugBuffer" | "isSpawned" | "onResponse" | "onSseEvent"
>;

/** The provider settings a side request carries, read once per {@link ProviderTransport.prepare}. */
export interface SideRequestSettings {
	/** `providers.openrouterVariant`, applied to an OpenRouter request whose caller names no variant. */
	readonly openrouterVariant: SettingValue<"providers.openrouterVariant">;
	/** `providers.antigravityEndpoint`, applied to a `google-antigravity` request. */
	readonly antigravityEndpoint: SettingValue<"providers.antigravityEndpoint">;
	/** `providers.maxInFlightRequests`, applied when the caller sets no cap. */
	readonly maxInFlightRequests: SettingValue<"providers.maxInFlightRequests">;
	/** `model.loopGuard.enabled`. */
	readonly loopGuardEnabled: SettingValue<"model.loopGuard.enabled">;
	/** `model.loopGuard.checkAssistantContent`. */
	readonly loopGuardChecksAssistantContent: SettingValue<"model.loopGuard.checkAssistantContent">;
}

/** What {@link ProviderTransport} needs from the session that holds it. */
export interface ProviderTransportHost {
	/** Takes the interceptors, and supplies the provider metadata a side request is stamped with. */
	readonly agent: Pick<Agent, "metadataForProvider" | "setProviderResponseInterceptor" | "setRawSseEventInterceptor">;
	/** Records a response's rate-limit headers against the credential the session routes under. */
	ingestUsageHeaders(response: ProviderResponseMetadata, model: Model | undefined): void;
	/** Admits the secret runtime a side request's payload is obfuscated with. */
	leaseSecretRuntime(): Promise<SecretRuntimeLease>;
	/** The session's payload hook, resolved per request. */
	payloadHook(): SimpleStreamOptions["onPayload"];
	/** Read on every {@link ProviderTransport.prepare}, so a changed setting applies to the next request. */
	sideRequestSettings(): SideRequestSettings;
}

export class ProviderTransport {
	readonly #host: ProviderTransportHost;
	/**
	 * The stream function every side request runs on, fixed when the session is built:
	 * `config.sideStreamFn`, or the `streamSimple` export as it stood at construction.
	 */
	readonly sideStreamFn: StreamFn;
	/**
	 * Recent raw SSE traffic for the debug viewer and the report bundle, which read the session the
	 * terminal displays. Undefined on a spawned agent's session unless the caller passes a buffer:
	 * the displayed session is always a top-level one, so a spawned agent's capture has no reader.
	 */
	readonly rawSse: RawSseDebugBuffer | undefined;
	/** The response interceptor of every request: the raw SSE record, the usage headers, then the caller's hook. */
	readonly onResponse: SimpleStreamOptions["onResponse"];
	/** The raw SSE interceptor of every request; undefined when there is neither a buffer nor a caller hook. */
	readonly onSseEvent: SimpleStreamOptions["onSseEvent"] | undefined;

	constructor(host: ProviderTransportHost, config: ProviderTransportConfig) {
		this.#host = host;
		this.sideStreamFn = config.sideStreamFn ?? streamSimple;
		const rawSse = config.rawSseDebugBuffer ?? (config.isSpawned === true ? undefined : new RawSseDebugBuffer());
		this.rawSse = rawSse;
		// Avoid wrapping in an `async` closure when no caller hook is configured: the outer await on
		// `onResponse` (provider-response.ts) tolerates a sync void return, and skipping the wrapper
		// drops a per-event `newPromiseCapability` allocation that shows up as ~3.5% self time in
		// streaming profiles.
		const configuredOnResponse = config.onResponse;
		this.onResponse = configuredOnResponse
			? async (response, model) => {
					rawSse?.recordResponse(response, model);
					host.ingestUsageHeaders(response, model);
					await configuredOnResponse(response, model);
				}
			: (response, model) => {
					rawSse?.recordResponse(response, model);
					host.ingestUsageHeaders(response, model);
				};
		const configuredOnSseEvent = config.onSseEvent;
		// With no buffer and no caller hook the provider gets no observer, so it neither builds the
		// per-event record nor resolves an OpenAI event name for one.
		this.onSseEvent = !rawSse
			? configuredOnSseEvent
			: configuredOnSseEvent
				? (event, model) => {
						rawSse.recordEvent(event, model);
						configuredOnSseEvent(event, model);
					}
				: (event, model) => {
						rawSse.recordEvent(event, model);
					};
		host.agent.setProviderResponseInterceptor(this.onResponse);
		host.agent.setRawSseEventInterceptor(this.onSseEvent);
	}

	/**
	 * The transport every side request shares, in the `completeImpl` shape `compact()`, the handoff
	 * and the branch summary all take. Every site names this rather than writing the adapter again,
	 * so a new one cannot run unwatched by construction.
	 */
	readonly sideComplete: SideCompleteImpl = async <TApi extends Api>(
		model: Model<TApi>,
		ctx: Context,
		options: SimpleStreamOptions,
	): Promise<AssistantMessage> => {
		const stream = await this.sideStreamFn(model, ctx, options);
		return stream.result();
	};

	/**
	 * Apply the session's stream hooks to a direct side request.
	 *
	 * The lease is admitted before any caller or extension hook can run and is captured by the
	 * returned payload hook for the request's full lifetime.
	 */
	async prepare(options: SimpleStreamOptions, provider = "anthropic"): Promise<SimpleStreamOptions> {
		const runtime = await this.#host.leaseSecretRuntime();
		const sessionOnPayload = this.#host.payloadHook();
		const sessionOnResponse = this.onResponse;
		const sessionMetadata = this.#host.agent.metadataForProvider(provider);
		const sessionOnSseEvent = this.onSseEvent;
		const settings = this.#host.sideRequestSettings();
		const openrouterRoutingPreset = provider === "openrouter" ? settings.openrouterVariant : "default";
		const openrouterVariant =
			openrouterRoutingPreset !== "default" && options.openrouterVariant === undefined
				? openrouterRoutingPreset
				: undefined;
		const antigravityEndpointMode = provider === "google-antigravity" ? settings.antigravityEndpoint : undefined;

		const preparedOptions: SimpleStreamOptions = {
			...options,
			...(openrouterVariant !== undefined && { openrouterVariant }),
			...(antigravityEndpointMode !== undefined && { antigravityEndpointMode }),
			maxInFlightRequests: validateProviderMaxInFlightRequests(
				options.maxInFlightRequests ?? settings.maxInFlightRequests,
			),
			loopGuard: {
				enabled: settings.loopGuardEnabled,
				checkAssistantContent: settings.loopGuardChecksAssistantContent,
				...options.loopGuard,
			},
		};

		// Stamp session metadata (e.g. user_id={session_id}) onto direct-call requests so they share
		// the same session bucket as Agent.prompt-routed requests on Anthropic OAuth. Caller-provided
		// metadata wins so explicit overrides are respected.
		if (sessionMetadata && !options.metadata) {
			preparedOptions.metadata = sessionMetadata;
		}

		const requestOnPayload = options.onPayload;
		if (runtime.hasRedactions || sessionOnPayload || requestOnPayload) {
			preparedOptions.onPayload = async (payload, model) => {
				const sessionPayload = sessionOnPayload ? await sessionOnPayload(payload, model) : undefined;
				const sessionResolvedPayload = sessionPayload ?? payload;
				const requestPayload = requestOnPayload ? await requestOnPayload(sessionResolvedPayload, model) : undefined;
				return runtime.obfuscatePayload(requestPayload ?? sessionResolvedPayload);
			};
		}

		if (sessionOnResponse) {
			if (!options.onResponse) {
				preparedOptions.onResponse = sessionOnResponse;
			} else {
				const requestOnResponse = options.onResponse;
				preparedOptions.onResponse = async (response, model) => {
					await sessionOnResponse(response, model);
					await requestOnResponse(response, model);
				};
			}
		}

		if (sessionOnSseEvent) {
			if (!options.onSseEvent) {
				preparedOptions.onSseEvent = sessionOnSseEvent;
			} else {
				const requestOnSseEvent = options.onSseEvent;
				preparedOptions.onSseEvent = (event, model) => {
					sessionOnSseEvent(event, model);
					requestOnSseEvent(event, model);
				};
			}
		}

		return preparedOptions;
	}
}
