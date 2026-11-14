import { describe, expect, it } from "bun:test";
import { redactProviderSecrets } from "@veyyon/ai/error/error-body";
import { BLOCKED_OUTPUT_RECORD, ProducerOutputGuard } from "../../src/secrets/producer-output";

function streamed(input: string, split: number): string {
	const guard = new ProducerOutputGuard(redactProviderSecrets);
	return guard.push(input.slice(0, split)) + guard.push(input.slice(split)) + guard.finish();
}

const echo = "job\tstep\t2026-11-12T15:29:32Z ^[[36;1mnode scripts/check.mjs^[[0m\n";

describe("producer output keeps caret-escaped ANSI", () => {
	it("keeps command echoes and following records at every stream split", () => {
		const input = `before\n${echo}after\n`;
		for (let split = 0; split <= input.length; split++) {
			expect(streamed(input, split)).toBe(input);
		}
	});

	it("does not hide a real unterminated array after an escaped sequence", () => {
		expect(streamed(`${echo}values: [\n`, 0)).toContain(BLOCKED_OUTPUT_RECORD);
	});

	it("keeps credential redaction active beside escaped sequences", () => {
		const secrets = [
			`ghp_${"A".repeat(36)}`,
			`github_pat_${"B".repeat(30)}`,
			`sk-${"C".repeat(24)}`,
			`AKIA${"D".repeat(16)}`,
			`Bearer ${"E".repeat(24)}`,
			"-----BEGIN PRIVATE KEY-----\nU3ludGhldGlj\n-----END PRIVATE KEY-----",
		];
		for (const secret of secrets) {
			const input = `${echo}${secret}\nafter\n`;
			for (let split = 0; split <= input.length; split++) {
				const output = streamed(input, split);
				expect(output).not.toContain(secret);
				expect(output).toContain(echo);
			}
		}
	});
});
