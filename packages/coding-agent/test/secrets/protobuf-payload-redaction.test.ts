import { describe, expect, it } from "bun:test";
import { mapJsonStrings } from "@veyyon/coding-agent/secrets/obfuscator";

// WHY THIS SUITE EXISTS. Devin hands the redaction hook its typed protobuf request. A 64-bit
// field is a bigint and a bytes field is a Uint8Array, and the walker used to refuse both, so
// every request with secrets configured failed. This pins the class: secrets in any string leaf
// are redacted, and every non-string leaf (bigint, bytes) reaches the wire unchanged. It does not
// cover a non-protobuf object or a future leaf type; those stay refused by the walker's own tests.

const SECRET = "sk-live-secret-value";
const REDACTED = "[redacted]";

describe("redaction of a typed protobuf request", () => {
	it("redacts secrets in strings and keeps bigint and bytes leaves unchanged", () => {
		const requestId = 18446744073709551615n;
		const request = {
			metadata: { requestId, apiKey: SECRET, userJwt: new Uint8Array([9, 8]) },
			messages: [{ content: `use ${SECRET} now`, parts: [new Uint8Array([7])] }],
		};

		const redacted = mapJsonStrings(request, text => text.replaceAll(SECRET, REDACTED)) as typeof request;

		expect(redacted.metadata.apiKey).toBe(REDACTED);
		expect(redacted.messages[0].content).toBe(`use ${REDACTED} now`);
		expect(redacted.metadata.requestId).toBe(requestId);
		expect(redacted.metadata.userJwt).toEqual(new Uint8Array([9, 8]));
		expect(redacted.messages[0].parts[0]).toEqual(new Uint8Array([7]));
	});
});
