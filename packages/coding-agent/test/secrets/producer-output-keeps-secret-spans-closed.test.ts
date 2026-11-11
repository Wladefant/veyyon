import { describe, expect, it } from "bun:test";
import { redactProviderSecrets } from "@veyyon/ai/error/error-body";
import { ProducerOutputGuard, sanitizeProducerJson } from "../../src/secrets/producer-output";
import { SecretObfuscator } from "../../src/secrets/obfuscator";
import { runWithProducerSecretOwner } from "../../src/secrets/producer-owner";

const guard = new ProducerOutputGuard();

describe("producer output keeps complete credential spans closed", () => {
	it("redacts Authorization Bearer credentials, including every two-chunk split", () => {
		const token = "opaqueABCDEFGHIJK12345678";
		const input = `Authorization: Bearer ${token}\n`;
		const sanitized = guard.sanitize(input);

		expect(sanitized).not.toContain(token);
		for (let split = 0; split <= input.length; split++) {
			const streamGuard = new ProducerOutputGuard();
			const output =
				streamGuard.push(input.slice(0, split)) +
					streamGuard.push(input.slice(split)) +
					streamGuard.finish();
			expect(output).not.toContain(token);
			expect(output).toBe(sanitized);
		}
	});

	it("does not leak a Bearer suffix when an owner redactor masks only the scheme", () => {
		const token = "opaqueABCDEFGHIJK12345678";
		const schemeOnlyGuard = new ProducerOutputGuard(text => text.replace("Bearer", "[REDACTED]"));
		expect(schemeOnlyGuard.sanitize(`Authorization: Bearer ${token}\n`)).not.toContain(token);
	});

	it("does not publish unquoted multiword secret suffixes", () => {
		expect(guard.sanitize("secret: multiple words in secret\n")).not.toContain("words in secret");
	});

	it("redacts a registered literal before removing its control characters", () => {
		const secret = "opaque\u0000registered-value";
		const obfuscator = new SecretObfuscator([
			{ type: "plain", origin: "config", content: secret, name: "CONTROL_CANARY" },
		]);
		const output = runWithProducerSecretOwner(
			{
				redact: text => obfuscator.obfuscate(text),
				pendingPrefixLength: text => obfuscator.pendingRedactionPrefixLength(text),
			},
			() => new ProducerOutputGuard().sanitize(`before ${secret} after`),
		);
		expect(output).not.toContain("registered-value");
	});

	it("preserves a record when owner masking crosses a credential span", () => {
		const token = `ghp_${"A".repeat(36)}`;
		const composite = `${token} opaqueSuffix`;
		const owner = new SecretObfuscator([
			{ type: "plain", origin: "config", content: composite, name: "COMPOSITE_CANARY" },
		]);
		const output = runWithProducerSecretOwner(
			{
				redact: text => owner.obfuscate(text),
				pendingPrefixLength: text => owner.pendingRedactionPrefixLength(text),
			},
			() => new ProducerOutputGuard().sanitize(`before token=${composite} after\n`),
		);
		expect(output).toContain("#COMPOSITE_CANARY#");
		expect(output).toContain(" after");
		expect(output).not.toContain(token);
		expect(output).not.toContain("opaqueSuffix");
	});

	it.each([
		"private_key: -----BEGIN PRIVATE KEY-----\nQ29uc2VydmF0aXZlU3ludGhldGljRGF0YQ==\n-----END PRIVATE KEY-----\n",
		"private_key=-----BEGIN PRIVATE KEY-----\nQ29uc2VydmF0aXZlU3ludGhldGljRGF0YQ==\n-----END PRIVATE KEY-----\n",
		"private_key: |\n  -----BEGIN PRIVATE KEY-----\n  Q29uc2VydmF0aXZlU3ludGhldGljRGF0YQ==\n  -----END PRIVATE KEY-----\n",
		"-----BEGIN PRIVATE KEY-----\nQ29uc2VydmF0aXZlU3ludGhldGljRGF0YQ==\n-----END PRIVATE KEY-----\n",
	])("does not publish a PEM body or suffix from %j", input => {
		expect(guard.sanitize(input)).not.toContain("Q29uc2VydmF0aXZlU3ludGhldGljRGF0YQ==");
	});

	it("keeps unregistered PEM bodies closed across every stream split", () => {
		const inputs = [
			"private_key: -----BEGIN PRIVATE KEY-----\nQ29uc2VydmF0aXZlU3ludGhldGljRGF0YQ==\n-----END PRIVATE KEY-----\n",
			"private_key: |\n  -----BEGIN PRIVATE KEY-----\n  Q29uc2VydmF0aXZlU3ludGhldGljRGF0YQ==\n  -----END PRIVATE KEY-----\n",
		];
		for (const input of inputs) {
			for (let split = 0; split <= input.length; split++) {
				const streamGuard = new ProducerOutputGuard(redactProviderSecrets);
				const output =
					streamGuard.push(input.slice(0, split)) +
					streamGuard.push(input.slice(split)) +
					streamGuard.finish();
				expect(output).not.toContain("Q29uc2VydmF0aXZlU3ludGhldGljRGF0YQ==");
			}
		}
	});

	it.each([
		`github_pat_${"A".repeat(32)}`,
		`figd_${"B".repeat(32)}`,
	])("redacts bare synthetic credential formats: %s", token => {
		expect(guard.sanitize(`before ${token} after`)).not.toContain(token);
	});


	it.each(["pin=123456", "password: 98765432", "api_key=4242424242"])(
		"redacts numeric secret spans: %s",
		input => {
			const sanitized = guard.sanitize(input);
			expect(sanitized).toContain("[REDACTED]");
			expect(sanitized).not.toContain(input.match(/\d+/)![0]);
		},
	);

	it("masks numeric API keys in producer JSON and preserves token counts", () => {
		expect(sanitizeProducerJson({ api_key: 4242424242, token_count: 42 }, guard)).toEqual({
			api_key: "[REDACTED]",
			token_count: 42,
		});
	});
	it("keeps redaction markers idempotent", () => {
		const once = guard.sanitize("before token=opaqueValue12345 after");
		expect(guard.sanitize(once)).toBe(once);
	});

	it("sanitizes JSON fields structurally and preserves safe sibling metadata", () => {
		const source = {
			token_count: 42,
			enabled: true,
			optional: null,
			commit: "abc",
			message: "before token=opaqueValue12345 after",
		};
		const result = sanitizeProducerJson(source, guard) as typeof source;
		expect(result).toEqual({
			token_count: 42,
			enabled: true,
			optional: null,
			commit: "abc",
			message: "before token=[REDACTED]",
		});
	});

	it.each(["secret:\n  ", "secret:   \n  ", "secret:\r\n  "])(
		"keeps an opaque continuation closed after a label-only record: %j",
		inputPrefix => {
			const body = "opaqueSyntheticBody1234567890";
			const input = `${inputPrefix}${body}\nnext=safe\n`;
			expect(guard.sanitize(input)).not.toContain(body);
			for (let split = 0; split <= input.length; split++) {
				const streamGuard = new ProducerOutputGuard(redactProviderSecrets);
				const streamed =
					streamGuard.push(input.slice(0, split)) +
					streamGuard.push(input.slice(split)) +
					streamGuard.finish();
				expect(streamed).not.toContain(body);
			}
		},
	);

	it("keeps label-only continuation values closed in JSON messages", () => {
		const body = "opaqueSyntheticJsonBody1234567890";
		const input = JSON.stringify({ message: `secret:\n  ${body}\n`, sibling: "safe" });
		const output = guard.sanitize(input);
		expect(output).not.toContain(body);
		expect(JSON.parse(output)).toMatchObject({ sibling: "safe" });
	});

	it("retains sensitivity when the real owner obfuscates a password label", () => {
		const token = "opaqueSyntheticCredentialABC123456";
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "password", name: "PASSWORD_CANARY", source: "test", origin: "config" },
		]);
		const owner = {
			redact: (value: string) => obfuscator.obfuscate(value),
			pendingPrefixLength: (value: string) => obfuscator.pendingRedactionPrefixLength(value),
		};
		const text = `password=${token}\n`;
		const output = runWithProducerSecretOwner(owner, () => new ProducerOutputGuard().sanitize(text));
		expect(output).not.toContain(token);

		const jsonOutput = runWithProducerSecretOwner(
			owner,
			() => new ProducerOutputGuard().sanitize(JSON.stringify({ password: token, sibling: "safe" })),
		);
		expect(jsonOutput).not.toContain(token);
		expect(JSON.parse(jsonOutput)).toMatchObject({ sibling: "safe" });
	});

	it("retains sensitivity when a callback obscures password labels across every split", () => {
		const token = "opaqueSyntheticCallbackCredential123456";
		const owner = { redact: (text: string) => text.replaceAll("password", "#PASSWORD_ALIAS#") };
		const input = `password=${token}\n`;
		const withOwnerGuard = (text: string) =>
			runWithProducerSecretOwner(owner, () => new ProducerOutputGuard().sanitize(text));
		expect(withOwnerGuard(input)).not.toContain(token);
		for (let split = 0; split <= input.length; split++) {
			const output = runWithProducerSecretOwner(owner, () => {
				const streamGuard = new ProducerOutputGuard();
				return streamGuard.push(input.slice(0, split)) +
					streamGuard.push(input.slice(split)) +
					streamGuard.finish();
			});
			expect(output).not.toContain(token);
		}
	});
	it("P1: does not leak opaque credential suffix when value begins with fake redaction marker", () => {
		const suffix = "opaqueCredentialSuffixP1";
		const testCases = [
			`token=#NOT_A_REAL_MARKER# ${suffix}\n`,
			`token=<redacted 12 chars> ${suffix}\n`,
		];
		for (const input of testCases) {
			const sanitized = guard.sanitize(input);
			expect(sanitized).not.toContain(suffix);

			const jsonObject = { message: input, sibling: "safe" };
			const sanitizedJson = sanitizeProducerJson(jsonObject, guard) as typeof jsonObject;
			expect(sanitizedJson.message).not.toContain(suffix);

			const jsonString = JSON.stringify(jsonObject);
			const sanitizedJsonStr = guard.sanitize(jsonString);
			expect(sanitizedJsonStr).not.toContain(suffix);

			for (let split = 0; split <= input.length; split++) {
				const streamGuard = new ProducerOutputGuard();
				const streamed =
					streamGuard.push(input.slice(0, split)) +
					streamGuard.push(input.slice(split)) +
					streamGuard.finish();
				expect(streamed).not.toContain(suffix);
			}
		}
	});

	it("P1: does not publish PEM body when SecretObfuscator matches only PEM header or prefix", () => {
		const pemBody = "Q29uc2VydmF0aXZlU3ludGhldGljRGF0YVBPTUU=";
		const pemText = `-----BEGIN PRIVATE KEY-----\n${pemBody}\n-----END PRIVATE KEY-----\n`;

		const headerOnlyObfuscator = new SecretObfuscator([
			{ type: "plain", origin: "config", content: "-----BEGIN PRIVATE KEY-----", name: "PEM_HEADER_CANARY" },
		]);
		const headerOwner = {
			redact: (text: string) => headerOnlyObfuscator.obfuscate(text),
			pendingPrefixLength: (text: string) => headerOnlyObfuscator.pendingRedactionPrefixLength(text),
		};

		const directOutput = runWithProducerSecretOwner(headerOwner, () => new ProducerOutputGuard().sanitize(pemText));
		expect(directOutput).not.toContain(pemBody);

		const jsonMsg = { message: pemText, status: "ok" };
		const jsonOutput = runWithProducerSecretOwner(headerOwner, () => sanitizeProducerJson(jsonMsg, new ProducerOutputGuard()) as typeof jsonMsg);
		expect(jsonOutput.message).not.toContain(pemBody);

		const jsonStrOutput = runWithProducerSecretOwner(headerOwner, () => new ProducerOutputGuard().sanitize(JSON.stringify(jsonMsg)));
		expect(jsonStrOutput).not.toContain(pemBody);

		for (let split = 0; split <= pemText.length; split++) {
			const streamed = runWithProducerSecretOwner(headerOwner, () => {
				const streamGuard = new ProducerOutputGuard();
				return streamGuard.push(pemText.slice(0, split)) +
					streamGuard.push(pemText.slice(split)) +
					streamGuard.finish();
			});
			expect(streamed).not.toContain(pemBody);
		}

		const prefixContent = `-----BEGIN PRIVATE KEY-----\n${pemBody.slice(0, 10)}`;
		const prefixObfuscator = new SecretObfuscator([
			{ type: "plain", origin: "config", content: prefixContent, name: "PEM_PREFIX_CANARY" },
		]);
		const prefixOwner = {
			redact: (text: string) => prefixObfuscator.obfuscate(text),
			pendingPrefixLength: (text: string) => prefixObfuscator.pendingRedactionPrefixLength(text),
		};

		const directPrefixOutput = runWithProducerSecretOwner(prefixOwner, () => new ProducerOutputGuard().sanitize(pemText));
		expect(directPrefixOutput).not.toContain(pemBody.slice(10));

		const jsonPrefixOutput = runWithProducerSecretOwner(prefixOwner, () => sanitizeProducerJson(jsonMsg, new ProducerOutputGuard()) as typeof jsonMsg);
		expect(jsonPrefixOutput.message).not.toContain(pemBody.slice(10));

		for (let split = 0; split <= pemText.length; split++) {
			const streamed = runWithProducerSecretOwner(prefixOwner, () => {
				const streamGuard = new ProducerOutputGuard();
				return streamGuard.push(pemText.slice(0, split)) +
					streamGuard.push(pemText.slice(split)) +
					streamGuard.finish();
			});
			expect(streamed).not.toContain(pemBody.slice(10));
		}
	});

	it("P1: does not emit suffix when registered literal crosses label boundary prefix token=opaque", () => {
		const suffix = "OpaqueSuffixP1Canary";
		const registeredLiteral = "prefix token=opaque";
		const fullInput = `prefix token=opaque${suffix}\n`;
		const owner = new SecretObfuscator([
			{ type: "plain", origin: "config", content: registeredLiteral, name: "PREFIX_TOKEN_CANARY" },
		]);
		const secretOwner = {
			redact: (text: string) => owner.obfuscate(text),
			pendingPrefixLength: (text: string) => owner.pendingRedactionPrefixLength(text),
		};

		const directOutput = runWithProducerSecretOwner(secretOwner, () => new ProducerOutputGuard().sanitize(fullInput));
		expect(directOutput).not.toContain(suffix);

		const jsonMsg = { message: fullInput, safe: true };
		const jsonOutput = runWithProducerSecretOwner(secretOwner, () => sanitizeProducerJson(jsonMsg, new ProducerOutputGuard()) as typeof jsonMsg);
		expect(jsonOutput.message).not.toContain(suffix);

		const jsonStrOutput = runWithProducerSecretOwner(secretOwner, () => new ProducerOutputGuard().sanitize(JSON.stringify(jsonMsg)));
		expect(jsonStrOutput).not.toContain(suffix);

		for (let split = 0; split <= fullInput.length; split++) {
			const streamed = runWithProducerSecretOwner(secretOwner, () => {
				const streamGuard = new ProducerOutputGuard();
				return streamGuard.push(fullInput.slice(0, split)) +
					streamGuard.push(fullInput.slice(split)) +
					streamGuard.finish();
			});
			expect(streamed).not.toContain(suffix);
		}
	});
	it("redacts indented credentials after plain bullet authorization labels across splits while retaining subsequent sections", () => {
		const bullets = ["- Authorization:", "- Driver & Native Authorization:", "- **Driver & Native Authorization:**"];
		const credentials = ["arbitraryCredentialABC123", "Bearer secret123"];
		const following = "\n## Next steps\nReview the documented permissions.\n";

		for (const bullet of bullets) {
			for (const credential of credentials) {
				const secret = credential.startsWith("Bearer ") ? credential.slice("Bearer ".length) : credential;
				const input = `${bullet}\n  ${credential}${following}`;

				for (const owner of [undefined, redactProviderSecrets]) {
					const sanitized = new ProducerOutputGuard(owner).sanitize(input);
					expect(sanitized).not.toContain(secret);
					expect(sanitized).toContain("\n## Next steps\nReview the documented permissions.\n");

					const lineStream = new ProducerOutputGuard(owner);
					const lines = input.split(/(?<=\n)/);
					let lineOutput = "";
					for (const line of lines) {
						lineOutput += lineStream.push(line);
					}
					lineOutput += lineStream.finish();
					expect(lineOutput).not.toContain(secret);
					expect(lineOutput).toContain("\n## Next steps\nReview the documented permissions.\n");

					for (let split = 0; split <= input.length; split++) {
						const splitStream = new ProducerOutputGuard(owner);
						const streamed =
							splitStream.push(input.slice(0, split)) +
							splitStream.push(input.slice(split)) +
							splitStream.finish();
						expect(streamed).not.toContain(secret);
						expect(streamed).toContain("\n## Next steps\nReview the documented permissions.\n");
					}
				}
			}
		}
	});

	it("P1: redacts multiline JSON auth values starting with a terminal-looking marker", () => {
		const suffix = "482916";
		const inputs = [
			{ auth: `<redacted 8 chars>\n${suffix}`, sibling: "safe" },
			{ auth: `[REDACTED]\n${suffix}`, sibling: "safe" },
			{ auth: `#CANARY#\n${suffix}`, sibling: "safe" },
		];
		for (const obj of inputs) {
			const sanitizedObj = sanitizeProducerJson(obj, guard) as typeof obj;
			expect(sanitizedObj.auth).toBe("[REDACTED]");
			expect(sanitizedObj.sibling).toBe("safe");

			const serialized = guard.sanitize(JSON.stringify(obj));
			expect(serialized).not.toContain(suffix);
			expect(JSON.parse(serialized)).toEqual({ auth: "[REDACTED]", sibling: "safe" });
		}
	});

	it("P2: fails closed on multiword passphrases directly after an empty Authorization heading", () => {
		const passphrase = "correct horse battery staple";
		const input = `### Authorization:\n${passphrase}\n## Next steps\nReview permissions.\n`;
		for (const owner of [undefined, redactProviderSecrets]) {
			const sanitized = new ProducerOutputGuard(owner).sanitize(input);
			expect(sanitized).not.toContain(passphrase);
			expect(sanitized).toContain("## Next steps\nReview permissions.\n");

			for (let split = 0; split <= input.length; split++) {
				const streamGuard = new ProducerOutputGuard(owner);
				const streamed =
					streamGuard.push(input.slice(0, split)) +
					streamGuard.push(input.slice(split)) +
					streamGuard.finish();
				expect(streamed).not.toContain(passphrase);
				expect(streamed).toContain("## Next steps\nReview permissions.\n");
			}
		}
	});
});
