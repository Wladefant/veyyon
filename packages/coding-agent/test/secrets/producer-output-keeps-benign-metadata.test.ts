import { BLOCKED_OUTPUT_RECORD, ProducerOutputGuard, sanitizeProducerJson } from "../../src/secrets/producer-output";
import { PR1699_BODY_FIXTURE } from "./fixtures/pr1699-body-fixture";
import { describe, expect, it } from "bun:test";
import { redactProviderSecrets } from "@veyyon/ai/error/error-body";

const guard = new ProducerOutputGuard(redactProviderSecrets);

describe("producer output keeps benign metadata", () => {
	it("keeps hashes, UUIDs, and GitHub node ids unchanged", () => {
		const hashes = Array.from({ length: 4 }, (_, index) => (index + 1).toString(16).padStart(40, "a"));
		const uuids = [
			"550e8400-e29b-41d4-a716-446655440000",
			"6ba7b810-9dad-11d1-80b4-00c04fd430c8",
			"f47ac10b-58cc-4372-a567-0e02b2c3d479",
		];
		const nodeIds = ["MDQ6VXNlcjE=", "MDU6SXNzdWU0"];
		const text = `commit ${hashes.join(" ")}\nids ${uuids.join(" ")}\nnodes ${nodeIds.join(" ")}`;

		expect(guard.sanitize(text)).toBe(text);
	});

	it("keeps defs-style string arrays unchanged", () => {
		const text = JSON.stringify(["figma_secret: str", "live_token: string", "password: str"]);

		expect(guard.sanitize(text)).toBe(text);
	});

	it("masks a JSON credential value while preserving its commit metadata", () => {
		const token = `ghp_${"E".repeat(36)}`;
		const commit = "5a".repeat(20);
		const text = JSON.stringify({ token, commit });
		const sanitized = guard.sanitize(text);
		const parsed = JSON.parse(sanitized) as { token: string; commit: string };

		expect(parsed.token).not.toContain(token);
		expect(parsed.commit).toBe(commit);
	});

	it("keeps gcloud log fields readable while masking auth values", () => {
		const token = "opaqueAuthToken1234567890";
		const input = JSON.stringify({
			timestamp: "2026-01-02T03:04:05Z",
			severity: "ERROR",
			message: "request failed",
			jsonPayload: {
				auth: token,
				authorization: { principal: "alice@example.test", value: token },
			},
		});
		const output = guard.sanitize(input);
		expect(output).not.toContain(token);
		expect(output).toContain('"auth":"[REDACTED]"');
		expect(output).toContain('"authorization":"[REDACTED]"');
		expect(output).toContain('"timestamp"');
		expect(output).toContain('"severity":"ERROR"');
		expect(output).toContain('"message":"request failed"');
	});

	it("keeps structured UTC window metadata outside environment inventory matching", () => {
		const record = {
			until: "2026-11-10T13:34:56Z",
			since15: "2026-11-10T13:19:56Z",
			since60: "2026-11-10T12:34:56Z",
		};

		expect(guard.sanitize(JSON.stringify(record))).toBe(JSON.stringify(record));
		expect(guard.sanitize("T=2026-11-10T13:34:56Z\nSTART15=2026-11-10T13:19:56Z\nSTART60=2026-11-10T12:34:56Z\n"))
			.toBe("[credential output withheld]");
	});

	it("keeps plain defs-style metadata unchanged", () => {
		const text = "figma_secret: str";

		expect(guard.sanitize(text)).toBe(text);
	});

	it("keeps defs metadata and known-token context across every stream split", () => {
		const token = `ghp_${"C".repeat(36)}`;
		const inputs = ["before\nfigma_secret: str\nafter\n", `before token=${token} after\n`];

		for (const input of inputs) {
			for (let split = 0; split <= input.length; split++) {
				const streamGuard = new ProducerOutputGuard(redactProviderSecrets);
				const streamed =
					streamGuard.push(input.slice(0, split)) +
					streamGuard.push(input.slice(split)) +
					streamGuard.finish();

				if (input.includes("figma_secret")) {
					expect(streamed).toBe(input);
				} else {
					expect(streamed).not.toContain(token);
					expect(streamed).toContain(" after\n");
				}
			}
		}
	});

	it("preserves TypeScript type annotations with token fields", () => {
		const text = "type Options = { token: string, retries: number };";
		expect(guard.sanitize(text)).toBe(text);
	});

	it("masks only a known token span and preserves its safe suffix", () => {
		const token = `ghp_${"F".repeat(36)}`;
		const text = `before token=${token} after`;
		const output = guard.sanitize(text);
		expect(output).not.toContain(token);
		expect(output).toContain(" after");
	});

	it("masks only the value after a spaced assignment delimiter", () => {
		const token = `ghp_${"D".repeat(36)}`;
		const text = `before token= ${token} after`;

		expect(guard.sanitize(text)).not.toContain(token);
		expect(guard.sanitize(text)).toContain(" after");
	});

	it("masks a bare real-format synthetic token and preserves surrounding metadata", () => {
		const token = `ghp_${"B".repeat(36)}`;
		const text = `before ${token} after`;

		expect(guard.sanitize(text)).toBe("before <redacted 40 chars> after");
	});

	it("preserves safe suffixes around known tokens for every stream split", () => {
		const token = `ghp_${"G".repeat(36)}`;
		const input = `before token=${token} after`;
		for (let split = 0; split <= input.length; split++) {
			const streamGuard = new ProducerOutputGuard(redactProviderSecrets);
			const output =
				streamGuard.push(input.slice(0, split)) +
				streamGuard.push(input.slice(split)) +
				streamGuard.finish();
			expect(output).not.toContain(token);
			expect(output).toContain(" after");
		}
	});

	it("preserves JSON-safe BigInt metadata and redacts the sensitive BigInt value", () => {
		const result = sanitizeProducerJson(
			{ count: 42n, commit: "abc", password: 987654321n },
			guard,
		) as { count: unknown; commit: unknown; password: unknown };
		expect(result.count).toBe("42n");
		expect(result.commit).toBe("abc");
		expect(result.password).toBe("[REDACTED]");
	});
	it("preserves safe text after a complete PEM credential span", () => {
		const input =
			"before private_key: -----BEGIN PRIVATE KEY-----\n" +
			"Q29uc2VydmF0aXZlU3ludGhldGljRGF0YQ==\n" +
			"-----END PRIVATE KEY----- after";
		const output = guard.sanitize(input);
		expect(output).not.toContain("Q29uc2VydmF0aXZlU3ludGhldGljRGF0YQ==");
		expect(output).toContain("before private_key:");
		expect(output).toContain(" after");
	});

	it("preserves numeric PIN counts and lengths while redacting a PIN value", () => {
		const text = "pin_count=42\npin_length: 6\npin=123456\n";
		expect(guard.sanitize(text)).toBe("pin_count=42\npin_length: 6\npin=[REDACTED]\n");
	});
	it("preserves only complete numeric metadata strings in JSON and text", () => {
		const json = sanitizeProducerJson(
			{
				token_count: "42",
				pin_length: "6",
				commit: "abc",
				api_key: "opaque",
				token_count_hint: "42,opaque",
			},
			guard,
		) as Record<string, unknown>;
		expect(json).toEqual({
			token_count: "42",
			pin_length: "6",
			commit: "abc",
			api_key: "[REDACTED]",
			token_count_hint: "[REDACTED]",
		});
		expect(
			sanitizeProducerJson({ token_count: "42,opaque", pin_length: "42\nopaque", api_key: "42" }, guard),
		).toEqual({
			token_count: "[REDACTED]",
			pin_length: "[REDACTED]",
			api_key: "[REDACTED]",
		});
		expect(guard.sanitize('{"token_count":"42","api_key":"opaque"}')).toBe(
			'{"token_count":"42","api_key":"[REDACTED]"}',
		);
	});


	it("keeps an owner-replaced prefix token from exposing its opaque suffix", () => {
		const opaqueSuffix = "opaqueRegisteredSuffixCanary";
		const composite = `ghp_${"A".repeat(36)} ${opaqueSuffix}`;
		const ownerGuard = new ProducerOutputGuard(value =>
			value.replaceAll(composite, "#COMPOSITE_CANARY#"),
		);
		const output = ownerGuard.sanitize(`before token=${composite}\nafter`);
		expect(output).not.toContain(opaqueSuffix);
		expect(output).toContain("after");
	});

	it("preserves safe text after an owner-redacted known token", () => {
		const token = `ghp_${"Z".repeat(36)}`;
		const ownerGuard = new ProducerOutputGuard(value =>
			value.replaceAll(token, "#TOKEN_CANARY#"),
		);
		const output = ownerGuard.sanitize(`before token=${token} after`);
		expect(output).not.toContain(token);
		expect(output).toContain(" after");
	});

	it("preserves PR 1699 body with Source commit pin metadata across sanitize, JSON wrapper, and stream splits", () => {
		expect(guard.sanitize(PR1699_BODY_FIXTURE)).toBe(PR1699_BODY_FIXTURE);

		const jsonWrapped = JSON.stringify({ body: PR1699_BODY_FIXTURE });
		expect(guard.sanitize(jsonWrapped)).toBe(jsonWrapped);
		expect(sanitizeProducerJson({ body: PR1699_BODY_FIXTURE }, guard)).toEqual({
			body: PR1699_BODY_FIXTURE,
		});

		const representativeDelimiters = [
			"\n",
			"\n\n",
			"- Source pin:",
			"Source pin: [",
			"https://github.com",
			"74e89ad9f7d2467f5449590ebe4b0b378902de45",
			"## CI evidence",
			"## Existing controls",
			"## Native AFTER checklist",
		];
		for (const delim of representativeDelimiters) {
			let pos = 0;
			while (true) {
				const idx = PR1699_BODY_FIXTURE.indexOf(delim, pos);
				if (idx === -1) break;
				const streamGuard = new ProducerOutputGuard(redactProviderSecrets);
				const streamed =
					streamGuard.push(PR1699_BODY_FIXTURE.slice(0, idx)) +
					streamGuard.push(PR1699_BODY_FIXTURE.slice(idx)) +
					streamGuard.finish();
				expect(streamed).toBe(PR1699_BODY_FIXTURE);
				pos = idx + delim.length;
				if (delim === "\n" && pos > 500) break;
			}
		}
	});

	it("withholds ordinary pin bracket literals without Source commit pin context", () => {
		const plainPin = "pin: [1234, 5678]";
		expect(guard.sanitize(plainPin)).toBe(BLOCKED_OUTPUT_RECORD);

		const bulletPin =
			"- pin: [pinned source commit](https://github.com/Wladefant/heylolo-app/commit/74e89ad9f7d2467f5449590ebe4b0b378902de45)\n";
		expect(guard.sanitize(bulletPin)).toBe(BLOCKED_OUTPUT_RECORD);
	});

	it("redacts numeric Source pin values that lack a markdown commit link", () => {
		const bulletNumeric = "- Source pin: 123456\n";
		expect(guard.sanitize(bulletNumeric)).toBe("- Source pin: [REDACTED]\n");

		const plainNumeric = "Source pin: 987654\n";
		expect(guard.sanitize(plainNumeric)).toBe("Source pin: [REDACTED]\n");
	});

	it("withholds Source pin links that do not link to a 40-hex commit", () => {
		const treeLink = "- Source pin: [pinned branch](https://github.com/Wladefant/heylolo-app/tree/main)\n";
		expect(guard.sanitize(treeLink)).toBe(BLOCKED_OUTPUT_RECORD);

		const issueLink = "- Source pin: [issue](https://github.com/Wladefant/heylolo-app/issues/1224)\n";
		expect(guard.sanitize(issueLink)).toBe(BLOCKED_OUTPUT_RECORD);

		const shortCommitLink =
			"- Source pin: [short commit](https://github.com/Wladefant/heylolo-app/commit/74e89ad)\n";
		expect(guard.sanitize(shortCommitLink)).toBe(BLOCKED_OUTPUT_RECORD);
	});

	it("redacts credentials even when combined with a Source commit link", () => {
		const text =
			"- Source pin: [pinned source commit](https://github.com/Wladefant/heylolo-app/commit/74e89ad9f7d2467f5449590ebe4b0b378902de45) token=ghp_syntheticOpaqueTokenVal123456789012\n";
		const result = guard.sanitize(text);
		expect(result).not.toContain("ghp_syntheticOpaqueTokenVal123456789012");
		expect(result).toContain(
			"- Source pin: [pinned source commit](https://github.com/Wladefant/heylolo-app/commit/74e89ad9f7d2467f5449590ebe4b0b378902de45)",
		);
		expect(result).toContain("token=");
	});

	it("withholds output when three ENV assignments are appended to the body", () => {
		const textWithEnv = PR1699_BODY_FIXTURE + "\nENV_A=1\nENV_B=2\nENV_C=3\n";
		expect(guard.sanitize(textWithEnv)).toBe(BLOCKED_OUTPUT_RECORD);
	});

});
