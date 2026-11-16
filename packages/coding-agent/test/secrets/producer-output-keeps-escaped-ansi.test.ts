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

	it("does not let a malformed caret-escaped prefix swallow a container opener", () => {
		const envObject = "^[[ {\n  DATABASE_URL: 'fake-db',\n  AWS_REGION: 'us-east-1',\n  MY_ENV: 'val'\n}\n";
		const output = streamed(envObject, 0);
		expect(output).toContain(BLOCKED_OUTPUT_RECORD);
		expect(output).not.toContain("fake-db");
	});

	it("still detects inventory keys inside objects containing caret-escaped ANSI", () => {
		const styledEnv = "{ ^[[36;1mDATABASE_URL: 'fake-db', AWS_REGION: 'us-east-1', MY_ENV: 'val'^[[0m }\n";
		const output = streamed(styledEnv, 0);
		expect(output).toContain(BLOCKED_OUTPUT_RECORD);
		expect(output).not.toContain("fake-db");
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

	it("keeps benign private-mode, intermediate, and tilde CSI sequences", () => {
		for (const seq of ["^[[?25h", "^[[2 q", "^[[15~"]) {
			const input = `before\n${seq}ok\nafter\n`;
			expect(new ProducerOutputGuard(redactProviderSecrets).sanitize(input)).toBe(input);
			for (let split = 0; split <= input.length; split++) {
				expect(streamed(input, split)).toBe(input);
			}
		}
	});

	it("does not let malformed bracket or quote CSI prefixes hide an unterminated container", () => {
		for (const prefix of ["^[[ [", '^[["key"']) {
			const envObject = `${prefix}\n  DATABASE_URL: 'fake-db',\n  AWS_REGION: 'us-east-1',\n  MY_ENV: 'val'\n}\n`;
			const output = streamed(envObject, 0);
			expect(output).toContain(BLOCKED_OUTPUT_RECORD);
			expect(output).not.toContain("fake-db");
		}
	});

	it("redacts credential labels preceded or followed by caret-escaped ANSI", () => {
		const canary = "opaqueSyntheticCanary123";
		const cases = [
			`^[[36mPASSWORD=${canary}^[[0m\n`,
			`^[[36mDB_PASSWORD=^[[31m${canary}^[[0m\n`,
			`^[[36mSECRET^[[0m: ${canary}\n`,
			`^[[36mTOKEN^[[0m=^[[33m${canary}^[[0m\n`,
		];
		const ownerRedact = (text: string) => text.replaceAll(canary, "#CANARY#");
		for (const input of cases) {
			for (const redact of [undefined, redactProviderSecrets, ownerRedact]) {
				const guard = new ProducerOutputGuard(redact);
				expect(guard.sanitize(input)).not.toContain(canary);
				for (let split = 0; split <= input.length; split++) {
					const g = new ProducerOutputGuard(redact);
					const output = g.push(input.slice(0, split)) + g.push(input.slice(split)) + g.finish();
					expect(output).not.toContain(canary);
				}
			}
		}
	});

	it("keeps 1 or 2 caret-colored env assignments but withholds 3 or more", () => {
		const one = "^[[36mALPHA=synthetic-one^[[0m\n";
		const two = `${one}^[[36mexport BETA=synthetic-two^[[0m\n`;
		const three = `${two}^[[36m^[[1mGAMMA=synthetic-three^[[0m\n`;
		for (const benign of [one, two]) {
			expect(new ProducerOutputGuard(redactProviderSecrets).sanitize(benign)).toBe(benign);
			for (let split = 0; split <= benign.length; split++) {
				expect(streamed(benign, split)).toBe(benign);
			}
		}
		expect(new ProducerOutputGuard(redactProviderSecrets).sanitize(three)).toBe(BLOCKED_OUTPUT_RECORD);
		for (let split = 0; split <= three.length; split++) {
			const output = streamed(three, split);
			expect(output).toContain(BLOCKED_OUTPUT_RECORD);
			expect(output).not.toContain("synthetic-three");
		}
	});
});
