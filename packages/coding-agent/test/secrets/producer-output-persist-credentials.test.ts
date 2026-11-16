import { describe, expect, it } from "bun:test";
import { ProducerOutputGuard } from "../../src/secrets/producer-output";

const guard = new ProducerOutputGuard();
const sentinel = "Error: checkout failed\n";

function stream(input: string, split = input.length): string {
	const output = new ProducerOutputGuard();
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
		for (let split = 0; split <= input.length; split++) expect(stream(input, split) === input).toBe(true);
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
