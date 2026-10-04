import { calculateCost, emptyUsage } from "@veyyon/catalog/models";
import type { Api, Model, Usage } from "@veyyon/catalog/types";
import { VERSION } from "@veyyon/utils/dirs";
import { withTimeoutSignal } from "@veyyon/utils/scoped-timeout";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import { withAuth } from "../auth-retry";
import * as AIError from "../error";
import { SPEECH_FORMAT_MIME_TYPES, type SpeechFormat, type SpeechOptions, type SpeechResult } from "./types";

const SPEECH_TIMEOUT_MS = 60_000;
const USER_AGENT = `veyyon/${VERSION}`;

export class SpeechApiError extends AIError.ProviderHttpError {
	override readonly name = "SpeechApiError";
}

export async function postSpeechRequest(
	model: Model<Api>,
	path: string,
	payload: Record<string, unknown>,
	format: SpeechFormat,
	options: SpeechOptions,
): Promise<SpeechResult> {
	const signal = withTimeoutSignal(SPEECH_TIMEOUT_MS, options.signal);
	const fetchImpl = options.fetch ?? fetch;
	const label = `${model.provider}/${model.id}`;
	const seenKeys = new Set<string>();
	if (typeof options.apiKey === "string" && options.apiKey.length > 0) seenKeys.add(options.apiKey);
	const audio = await withAuth(
		options.apiKey,
		async key => {
			if (typeof key === "string" && key.length > 0) seenKeys.add(key);
			const modelWithResolve = model as {
				resolveHeaders?: (signal?: AbortSignal) => Promise<Record<string, string>> | Record<string, string>;
			};
			const configuredHeaders = modelWithResolve.resolveHeaders
				? await modelWithResolve.resolveHeaders(signal)
				: model.headers;
			const headers = new Headers();
			if (configuredHeaders) {
				const entries =
					configuredHeaders instanceof Headers ? configuredHeaders.entries() : Object.entries(configuredHeaders);
				for (const [name, value] of entries) {
					if (name.toLowerCase() !== "authorization") headers.set(name, String(value));
				}
			}
			headers.set("Authorization", `Bearer ${key}`);
			headers.set("Content-Type", "application/json");
			headers.set("User-Agent", USER_AGENT);

			const response = await fetchImpl(`${trimTrailingSlashes(model.baseUrl)}${path}`, {
				method: "POST",
				headers,
				body: JSON.stringify(payload),
				signal,
			});
			if (!response.ok) {
				let detail = AIError.redactProviderSecrets(await response.text());
				for (const secret of seenKeys) detail = detail.replaceAll(secret, "[redacted]");
				throw new SpeechApiError(
					`${label} speech API failed (${response.status}): ${detail.slice(0, 300)}`,
					response.status,
					{ headers: response.headers },
				);
			}
			return new Uint8Array(await response.arrayBuffer());
		},
		{ signal },
	);
	// Speech endpoints return only audio bytes. OpenRouter exposes a generation id,
	// but neither it nor the OpenAI/xAI wires report token or billable-unit usage.
	const usage: Usage = emptyUsage();
	calculateCost(model, usage);
	return { audio, mimeType: SPEECH_FORMAT_MIME_TYPES[format], usage };
}
