import { describe, expect, it } from "bun:test";
import { redactProviderSecrets } from "@veyyon/ai/error/error-body";
import * as producerOutput from "../../src/secrets/producer-output";
import { SecretObfuscator } from "../../src/secrets/obfuscator";
import { runWithProducerSecretOwner } from "../../src/secrets/producer-owner";

const { ProducerOutputGuard } = producerOutput;
const guard = new ProducerOutputGuard(redactProviderSecrets);

describe("producer output keeps complete credential spans closed", () => {
	it("redacts Authorization Bearer credentials, including every two-chunk split", () => {
		const token = "opaqueABCDEFGHIJK12345678";
		const input = `Authorization: Bearer ${token}\n`;
		const sanitized = guard.sanitize(input);

		expect(sanitized).not.toContain(token);
		for (let split = 0; split <= input.length; split++) {
			const streamGuard = new ProducerOutputGuard(redactProviderSecrets);
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
	it("withholds an unknown-length indented value after a label-only line", () => {
		const input = "secret:\n  opaqueSyntheticBody1234567890\n";
		expect(guard.sanitize(input)).not.toContain("opaqueSyntheticBody1234567890");
		for (let split = 0; split <= input.length; split++) {
			const streamGuard = new ProducerOutputGuard(redactProviderSecrets);
			const output =
				streamGuard.push(input.slice(0, split)) +
				streamGuard.push(input.slice(split)) +
				streamGuard.finish();
			expect(output).not.toContain("opaqueSyntheticBody1234567890");
		}
		const sanitizeJsonValue = (producerOutput as typeof producerOutput & {
			sanitizeProducerJson?: (value: unknown, guard: InstanceType<typeof ProducerOutputGuard>) => unknown;
		}).sanitizeProducerJson!;
		expect(JSON.stringify(sanitizeJsonValue({ message: input }, guard))).not.toContain(
			"opaqueSyntheticBody1234567890",
		);
	});

	it("classifies original password labels before owner redaction", () => {
		const password = "opaqueSyntheticCredentialABC123456";
		const obfuscator = new SecretObfuscator([
			{ type: "plain", origin: "config", content: "password", name: "PASSWORD_LABEL" },
		]);
		const owner = {
			redact: (text: string) => obfuscator.obfuscate(text),
			pendingPrefixLength: (text: string) => obfuscator.pendingRedactionPrefixLength(text),
		};
		const output = runWithProducerSecretOwner(owner, () =>
			new ProducerOutputGuard().sanitize(`password=${password}\n`),
		);
		expect(output).not.toContain(password);
		const input = `password=${password}\n`;
		for (let split = 0; split <= input.length; split++) {
			const streamed = runWithProducerSecretOwner(owner, () => {
				const streamGuard = new ProducerOutputGuard();
				return streamGuard.push(input.slice(0, split)) +
					streamGuard.push(input.slice(split)) +
					streamGuard.finish();
			});
			expect(streamed).not.toContain(password);
		}
		const sanitizeJsonValue = (producerOutput as typeof producerOutput & {
			sanitizeProducerJson?: (value: unknown, guard: InstanceType<typeof ProducerOutputGuard>) => unknown;
		}).sanitizeProducerJson!;
		expect(JSON.stringify(sanitizeJsonValue({ password }, new ProducerOutputGuard(text => obfuscator.obfuscate(text))))
		).not.toContain(password);
	});

	it("preserves bigint display values and safe JSON siblings", () => {
		const sanitizeJsonValue = (producerOutput as typeof producerOutput & {
			sanitizeProducerJson?: (value: unknown, guard: InstanceType<typeof ProducerOutputGuard>) => unknown;
		}).sanitizeProducerJson!;
		expect(sanitizeJsonValue({ count: 42n, commit: "abc" }, guard)).toEqual({
			count: "42n",
			commit: "abc",
		});
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

	it("keeps redaction markers idempotent", () => {
		const once = guard.sanitize("before token=opaqueValue12345 after");
		expect(guard.sanitize(once)).toBe(once);
	});

	it("sanitizes JSON fields structurally and preserves safe sibling metadata", () => {
		const sanitizeJsonValue = (producerOutput as typeof producerOutput & {
			sanitizeProducerJson?: (value: unknown, guard: InstanceType<typeof ProducerOutputGuard>) => unknown;
		}).sanitizeProducerJson;
		expect(sanitizeJsonValue).toBeTypeOf("function");
		const source = {
			token_count: 42,
			enabled: true,
			optional: null,
			commit: "abc",
			message: "before token=opaqueValue12345 after",
		};
		const result = sanitizeJsonValue!(source, guard) as typeof source;
		expect(result).toEqual({
			token_count: 42,
			enabled: true,
			optional: null,
			commit: "abc",
			message: "before token=[REDACTED]",
		});
	});
});
