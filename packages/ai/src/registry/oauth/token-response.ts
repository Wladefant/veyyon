import { isRecord } from "@veyyon/utils/type-guards";
import * as AIError from "../../error";

/**
 * `body`, the parsed answer of a token endpoint, as the JSON object every token response is.
 *
 * A 200 whose JSON is `null`, an array, a string or a number is a fault of the endpoint, not a
 * refusal of the grant. Reading a field of `null` threw a `TypeError` whose message was the crash
 * text; this fails as a validation error instead, which keeps the stored login and retries it. The
 * fields themselves are unchecked: each caller validates the ones it reads.
 */
export function requireTokenResponseObject<T extends object>(body: unknown, provider: string, operation: string): T {
	if (isRecord(body)) return body as T;
	const shape = body === null ? "null" : Array.isArray(body) ? "an array" : typeof body;
	throw new AIError.OAuthError(`${provider} ${operation} answered with ${shape} instead of a JSON object`, {
		kind: "validation",
		provider,
	});
}
