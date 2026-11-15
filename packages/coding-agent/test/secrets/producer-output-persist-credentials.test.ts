import { describe, expect, it } from "bun:test";
import { redactProviderSecrets } from "@veyyon/ai/error/error-body";
import { ProducerOutputGuard } from "../../src/secrets/producer-output";

const guard = new ProducerOutputGuard();
const sentinel = "Error: checkout failed\n";

function stream(input: string, split = input.length, redact?: (text: string) => string): string {
	const output = new ProducerOutputGuard(redact);
	return output.push(input.slice(0, split)) + output.push(input.slice(split)) + output.finish();
}

describe("producer output treats persist-credentials booleans as metadata", () => {
	it.each([
		"persist-credentials: false",
		'"persist-credentials": false',
		"persist-credentials: true",
		"persist-credentials: false\t",
		"persist-credentials: false \n",
	])("preserves the exact boolean metadata boundary in raw logs: %s", setting => {
		const input = `checkout ${setting}\n${sentinel}`;
		expect(guard.sanitize(input) === input).toBe(true);
		for (let split = 0; split <= input.length; split++) expect(stream(input, split) === input).toBe(true);
	});
	it.each(['{"persist-credentials":false}', '{"persist-credentials":true}'])(
		"preserves valid JSON boolean metadata and its quoted key: %s",
		input => {
			expect(guard.sanitize(input) === input).toBe(true);
			for (let split = 0; split <= input.length; split++) expect(stream(input, split) === input).toBe(true);
		},
	);

	it("preserves metadata in a JSON-serialized string log with an escaped newline", () => {
		const input = JSON.stringify({ message: `checkout persist-credentials: false\n${sentinel}` });
		expect(guard.sanitize(input) === input).toBe(true);
		for (let split = 0; split <= input.length; split++) {
			const output = stream(input, split);
			if (output !== input) throw new Error(`JSON object stream failed at split ${split} (${output.length}/${input.length})`);
		}
	});

	it("preserves a top-level JSON string log with an escaped newline", () => {
		const input = JSON.stringify(`checkout persist-credentials: false\n${sentinel}`);
		expect(guard.sanitize(input) === input).toBe(true);
		for (let split = 0; split <= input.length; split++) {
			const output = stream(input, split);
			if (output !== input) throw new Error(`JSON string LF stream failed at split ${split} (${output.length}/${input.length})`);
		}
	});

	it("preserves a top-level JSON string log with an escaped CRLF boundary", () => {
		const input = JSON.stringify(`checkout persist-credentials: false\r\n${sentinel}`);
		expect(guard.sanitize(input) === input).toBe(true);
		for (let split = 0; split <= input.length; split++) expect(stream(input, split) === input).toBe(true);
	});

	it("keeps an escaped JSON log below the output-record limit intact", () => {
		const lines = Array.from({ length: 716 }, (_, index) =>
			`row-${index.toString().padStart(3, "0")}: ${'"'.repeat(4)}`.padEnd(85, "x"),
		);
		lines[25] = ` `.repeat(50) + "persist-credentials: false";
		lines[715] = "Error: checkout failed";
		const input = JSON.stringify(`\ufeff${lines.join("\n")}`);
		expect(input.length).toBeGreaterThan(65000);
		expect(input.length).toBeLessThan(65536);
		expect(guard.sanitize(input) === input).toBe(true);
		expect(new ProducerOutputGuard(redactProviderSecrets).sanitize(input) === input).toBe(true);
		const split = input.indexOf("persist-credentials: false") + "persist-credentials: ".length;
		expect(stream(input, split) === input).toBe(true);
		expect(stream(input, split, redactProviderSecrets) === input).toBe(true);
	});

	it.each([
		"persist-credentials: falseish",
		"persist-credentials: false0",
		"persist-credentials: false-secret",
	])("does not exempt a false prefix with a credential suffix: %s", setting => {
		const input = `checkout ${setting}\n${sentinel}`;
		const sanitized = guard.sanitize(input);
		expect(sanitized).not.toContain(setting);
		expect(sanitized).toContain(sentinel);
	});
	it('does not treat the quoted string "false" as boolean metadata', () => {
		const input = 'persist-credentials: "false"\n';
		expect(guard.sanitize(input)).not.toContain('"false"');
	});

	it.each([
		`ghp_${"A".repeat(36)}`,
		`ghs_${"B".repeat(36)}`,
		`Bearer ${"C".repeat(36)}`,
	])("redacts real credential value while retaining following text and newline: %s", credential => {
		const input = `persist-credentials: ${credential} after\n${sentinel}`;
		for (let split = 0; split <= input.length; split++) {
			const output = stream(input, split);
			expect(output).not.toContain(credential);
			expect(output).toContain(" after\n");
			expect(output).toContain(sentinel);
		}
	});
});
