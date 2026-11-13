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
	it("does not group printed ANSI colour codes as an unterminated JSON array", () => {
		const input = `job\tstep\t2026-01-01T00:00:00Z ^[[36;1mnode check^[[0m\n${"safe build output\n".repeat(4000)}${sentinel}`;
		expect(input.length).toBeGreaterThan(65536);
		expect(stream(input)).toBe(input);
		for (let split = 0; split <= input.indexOf("node"); split++) expect(stream(input, split)).toBe(input);
	});
	it("keeps later diagnostics after unmatched braces inside complete inline code suggestions", () => {
		const suggestion = "##[error] Replace `field: string; item: string` with `{ field: string;`.\n";
		const input = `${suggestion}${"safe diagnostic\n".repeat(5000)}${sentinel}`;
		expect(stream(input)).toBe(input);
	});
	it("still masks credential inventories inside inline code", () => {
		const input = '`{"ALPHA":"opaque-one","BRAVO":"opaque-two","CHARLIE":"opaque-three"}`\n';
		expect(stream(input)).not.toContain("opaque-one");
		expect(stream(input)).not.toContain("opaque-three");
	});
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
	it("preserves a label-only token record at end-of-output without corrupting JSON framing", () => {
		const value = "TOKEN:\n";
		const input = JSON.stringify(value);
		expect(input).toBe('"TOKEN:\\n"');
		expect(guard.sanitize(value)).toBe(value);
		expect(guard.sanitize(input)).toBe(input);
		for (let split = 0; split <= input.length; split++) expect(stream(input, split)).toBe(input);
	});
	it("does not exempt token labels with a multiline value continuation", () => {
		const secret = `ghp_${"E".repeat(36)}`;
		const value = `TOKEN:\n  ${secret}\n${sentinel}`;
		const input = JSON.stringify(value);
		const sanitized = JSON.parse(guard.sanitize(input)) as string;
		expect(sanitized).not.toContain(secret);
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
		const expected = JSON.parse(input).replace(/\r\n/g, "\n");
		expect(JSON.parse(guard.sanitize(input))).toBe(expected);
		for (let split = 0; split <= input.length; split++) expect(JSON.parse(stream(input, split))).toBe(expected);
	});

	it("keeps an escaped JSON log below the output-record limit intact", () => {
		const lines = Array.from({ length: 716 }, (_, index) =>
			`row-${index.toString().padStart(3, "0")}: ${'"'.repeat(4)}`.padEnd(85, "x"),
		);
		lines[25] = `${" ".repeat(50)}persist-credentials: false`;
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
	it("redacts long top-level JSON string logs across every credential split and keeps the final error", () => {
		const secret = `ghp_${"D".repeat(36)}`;
		const lines = Array.from({ length: 800 }, (_, index) =>
			`row-${index.toString().padStart(4, "0")}: ${"x".repeat(80)}`,
		);
		lines[0] = "persist-credentials: false";
		lines[731] = `persist-credentials: ${secret} following text`;
		lines[799] = sentinel.trimEnd();
		const input = JSON.stringify(`\ufeff${lines.join("\n")}\n`);
		expect(input.length).toBeGreaterThan(65536);
		const payload = JSON.parse(guard.sanitize(input)) as string;
		expect(payload).not.toContain(secret);
		expect(payload).toContain("persist-credentials: false");
		expect(payload).toContain("following text\n");
		expect(payload).toContain(sentinel);
		const tokenStart = input.indexOf(secret);
		for (let split = tokenStart; split <= tokenStart + secret.length; split++) {
			const streamed = JSON.parse(stream(input, split)) as string;
			expect(streamed).not.toContain(secret);
			expect(streamed).toContain("following text\n");
			expect(streamed).toContain(sentinel);
		}
		const streamedAtRecordLimit = JSON.parse(stream(input, 65536)) as string;
		expect(streamedAtRecordLimit).not.toContain(secret);
		expect(streamedAtRecordLimit).toContain(sentinel);
	});

	it("bounds serialized scalar buffering without exposing a credential beyond the bound", () => {
		const secret = `ghp_${"E".repeat(36)}`;
		const input = JSON.stringify(`${`${"x".repeat(60000)}\n`.repeat(300)}${secret}\n`);
		expect(guard.sanitize(input) === "[line over 65,536 chars, not scanned]").toBe(true);
		const bounded = new ProducerOutputGuard();
		let output = "";
		for (let offset = 0; offset < input.length; offset += 8192) output += bounded.push(input.slice(offset, offset + 8192));
		output += bounded.finish();
		expect(output === "[line over 65,536 chars, not scanned]").toBe(true);
		expect(output).not.toContain(secret);
	});
	it.each([
		["Bearer", `Bearer ${"F".repeat(36)}`],
		["github_pat_", `github_pat_${"G".repeat(40)}`],
		["ghp_", `ghp_${"H".repeat(36)}`],
		["password=value", `password=${"I".repeat(40)}`],
	])("redacts %s at every offset across the serialized scalar chunk boundary", (_label, secret) => {
		for (let interiorOffset = 0; interiorOffset < secret.length; interiorOffset++) {
			const prefixLength = 65536 - interiorOffset;
			const prefix = `${"x".repeat(prefixLength - 3)}\n`;
			const input = JSON.stringify(`${prefix}${secret}${"z".repeat(30)}`);
			const bounded = new ProducerOutputGuard();
			let output = "";
			for (let offset = 0; offset < input.length; offset += 8192) output += bounded.push(input.slice(offset, offset + 8192));
			output += bounded.finish();
			expect(typeof JSON.parse(output) === "string").toBe(true);
			expect(output.includes(secret) === false).toBe(true);
			expect(output.includes(secret.slice(-12)) === false).toBe(true);
		}
	});
	it.each([
		["Bearer", `Bearer ${"J".repeat(36)}`],
		["github_pat_", `github_pat_${"K".repeat(40)}`],
		["ghp_", `ghp_${"L".repeat(36)}`],
		["password=value", `password=${"M".repeat(40)}`],
	])("fails closed for raw oversized %s credential offsets at the record boundary", (_label, secret) => {
		for (let interiorOffset = 0; interiorOffset < secret.length; interiorOffset++) {
			const prefixLength = 65536 - interiorOffset;
			const input = `${"x".repeat(prefixLength)}${secret}${"z".repeat(65536)}`;
			const bounded = new ProducerOutputGuard();
			let output = "";
			for (let offset = 0; offset < input.length; offset += 8192) output += bounded.push(input.slice(offset, offset + 8192));
			output += bounded.finish();
			expect(output === "[line over 65,536 chars, not scanned]").toBe(true);
			expect(output.includes(secret) === false).toBe(true);
			expect(output.includes(secret.slice(-12)) === false).toBe(true);
		}
	});
	it("does not expose the tail of an oversized unterminated structured record", () => {
		const rawTail = `unique-raw-tail-${"N".repeat(48)}`;
		const input = `{"unclosed":"${"x".repeat(65536)}${rawTail}`;
		const output = new ProducerOutputGuard().sanitize(input);
		expect(output === "[line over 65,536 chars, not scanned]").toBe(true);
		expect(output.includes(rawTail) === false).toBe(true);
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
