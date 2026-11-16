/**
 * WHY THIS SUITE EXISTS. A registered literal can cross newline-delimited producer records, so
 * redacting each record alone can publish pieces before the literal is complete. Every split of a
 * synthetic multiline literal must stay redacted, and a flushed partial prefix must not be joined
 * to later producer output.
 *
 * The class it closes: multiline registered literals split across stream chunks or record
 * boundaries, including cancellation and bounded-buffer cases.
 *
 * WHAT IT DOES NOT CATCH: regex-derived runtime secrets do not have a registered literal prefix
 * matcher, and this suite does not exercise producer artifacts outside the guard's output string.
 */

import { describe, expect, it } from "bun:test";
import { SecretObfuscator } from "../../src/secrets/obfuscator";
import { BLOCKED_OUTPUT_RECORD, OVERSIZED_OUTPUT_RECORD, ProducerOutputGuard } from "../../src/secrets/producer-output";
import { runWithProducerSecretOwner } from "../../src/secrets/producer-owner";

const SECRET = "synthetic-first-line\nsynthetic-second-line";
const PREFIX = "synthetic-first-line\n";

function guardFor(secret = SECRET): ProducerOutputGuard {
	const obfuscator = new SecretObfuscator([
		{ type: "plain", origin: "config", content: secret, name: "MULTILINE_CANARY" },
	]);
	return runWithProducerSecretOwner(
		{
			redact: text => obfuscator.obfuscate(text),
			pendingPrefixLength: text => obfuscator.pendingRedactionPrefixLength(text),
		},
		() => new ProducerOutputGuard(),
	);
}

describe("producer output withholds multiline registered literals", () => {
	it("redacts the literal across every two-chunk split in streamed output", () => {
		const input = `before\n${SECRET}\nafter\n`;
		for (let split = 0; split <= input.length; split++) {
			const guard = guardFor();
			const streamed = guard.push(input.slice(0, split)) + guard.push(input.slice(split)) + guard.finish();

			expect(streamed).not.toContain(SECRET);
			expect(streamed).toContain("#MULTILINE_CANARY#");
			expect(streamed).toContain("before\n");
			expect(streamed).toContain("after\n");
		}
	});
	describe("serialization-shaped records are independently safe across every boundary", () => {
		const cases = [
			{
				input: "env {\n  ALPHA: 'fake-a-fake-a-fake-a-fake-a-fake-a-fake-a-fake-a-fake-a',\n  BETA: 'fake-b-fake-b-fake-b-fake-b-fake-b-fake-b-fake-b-fake-b',\n  GAMMA: 'fake-c-fake-c-fake-c-fake-c-fake-c-fake-c-fake-c-fake-c'\n}\n",
				values: ["fake-a-fake-a", "fake-b-fake-b", "fake-c-fake-c"],
				visible: false,
			},
			{
				input: "{\n  ALPHA: `fake}'\"a`,\n  BETA: 'fake-bfake-bfake-bfake-bfake-bfake-bfake-bfake-b',\n  GAMMA: 'fake-cfake-cfake-cfake-cfake-cfake-cfake-cfake-c'\n}\n",
				values: ["fake-b", "fake-c"],
				visible: false,
			},
			{
				input: "{ ALPHA: 'fake-a', BETA: 'fake-b', Path: 'path-value' }\n",
				values: ["fake-a", "fake-b", "path-value"],
				visible: false,
			},
			{
				input: "{ ALPHA: 'fake-a', BETA: 'fake-b', SystemRoot: 'system-root-value' }\n",
				values: ["fake-a", "fake-b", "system-root-value"],
				visible: false,
			},
			{
				input: "{ ALPHA: 'fake-a', BETA: 'fake-b', ComSpec: 'command-value' }\n",
				values: ["fake-a", "fake-b", "command-value"],
				visible: false,
			},
			{
				input: '{ "ALPHA": "fake-a", "BETA": "fake-b", "Path": "path-value" }\n',
				values: ["fake-a", "fake-b", "path-value"],
				visible: false,
			},
			{
				input: '{ "ALPHA": "fake-a", "BETA": "fake-b", "SystemRoot": "system-root-value" }\n',
				values: ["fake-a", "fake-b", "system-root-value"],
				visible: false,
			},
			{
				input: '{ "ALPHA": "fake-a", "BETA": "fake-b", "ComSpec": "command-value" }\n',
				values: ["fake-a", "fake-b", "command-value"],
				visible: false,
			},
			{
				input: "Here's env: { ALPHA: 'fake-a', BETA: 'fake-b', GAMMA: 'fake-c' }\n",
				values: ["fake-a", "fake-b", "fake-c"],
				visible: false,
			},
			{
				input: "Here's \"env: { ALPHA: 'fake-a', BETA: 'fake-b', GAMMA: 'fake-c' }\n",
				values: ["fake-a", "fake-b", "fake-c"],
				visible: false,
			},
			{
				input: "Here's `env: { ALPHA: 'fake-a', BETA: 'fake-b', GAMMA: 'fake-c' }\n",
				values: ["fake-a", "fake-b", "fake-c"],
				visible: false,
			},
			{
				input: "Here's env: {\n  ALPHA: 'fake-a',\n  BETA: 'fake-b',\n  GAMMA: 'fake-c'\n}\n",
				values: ["fake-a", "fake-b", "fake-c"],
				visible: false,
			},
			{
				input: "{ message: 'Expected HTTP: 200, GOT: 404, RETRY: 1, STATUS: pending' }\ncompleted\n",
				values: ["Expected HTTP: 200, GOT: 404, RETRY: 1, STATUS: pending", "completed"],
				visible: true,
			},
			{
				input: "[warn] [worker] Here's env { ALPHA: 'fake-a', BETA: 'fake-b', GAMMA: 'fake-c' }\n",
				values: ["fake-a", "fake-b", "fake-c"],
				visible: false,
			},
			{
				input: "[warn] [worker's env] {\n ALPHA: 'fake-a',\n BETA: 'fake-b',\n GAMMA: 'fake-c'\n}\n",
				values: ["fake-a", "fake-b", "fake-c"],
				visible: false,
			},
			{
				input: "[\n{ ALPHA: 'fake-a' },\n{ BETA: 'fake-b' },\n{ GAMMA: 'fake-c' }\n]\n",
				values: ["fake-a", "fake-b", "fake-c"],
				visible: false,
			},
			{
				input: "env: [\n{ ALPHA: 'fake-a' },\n{ BETA: 'fake-b' },\n{ GAMMA: 'fake-c' }\n]\n",
				values: ["fake-a", "fake-b", "fake-c"],
				visible: false,
			},
			{
				input: "[warn] env: [\n{ ALPHA: 'fake-a' },\n{ BETA: 'fake-b' },\n{ GAMMA: 'fake-c' }\n]\n",
				values: ["fake-a", "fake-b", "fake-c"],
				visible: false,
			},
			{
				input: "[worker] \"unmatched label { ALPHA: 'fake-a', BETA: 'fake-b', GAMMA: 'fake-c' }\n",
				values: ["fake-a", "fake-b", "fake-c"],
				visible: false,
			},
			{
				input: "[ 'Expected response { HTTP: 200, RETRY: 1, STATUS: pending }' ]\ncompleted\n",
				values: ["Expected response { HTTP: 200, RETRY: 1, STATUS: pending }", "completed"],
				visible: true,
			},
			{
				input: '"Expected response { HTTP: 200, RETRY: 1, STATUS: pending }"\ncompleted\n',
				values: ["Expected response", "completed"],
				visible: true,
			},
			{
				input: 'env " { ALPHA: "fake\'a", BETA: "fake\'b", GAMMA: "fake\'c" }\n',
				values: ["fake'a", "fake'b", "fake'c"],
				visible: false,
			},
		];
		for (const { input, values, visible } of cases) {
			it(`classifies ${input.slice(0, 42)} safely at every chunk boundary`, () => {
				const atomic = guardFor().sanitize(input);
				if (visible) expect(atomic).toBe(input);
				else expect(atomic).toBe("[credential output withheld]");
				for (let split = 0; split <= input.length; split++) {
					const guard = guardFor();
					const output = guard.push(input.slice(0, split)) + guard.push(input.slice(split)) + guard.finish();
					if (visible) {
						for (const value of values) expect(output).toContain(value);
					} else {
						for (const value of values) expect(output).not.toContain(value);
						expect(output).toContain("[credential output withheld]");
					}
				}
				const guard = guardFor();
				const output = [...input].map(character => guard.push(character)).join("") + guard.finish();
				if (visible) {
					for (const value of values) expect(output).toContain(value);
				} else {
					for (const value of values) expect(output).not.toContain(value);
					expect(output).toContain("[credential output withheld]");
				}
			});
		}
	});
	it("flushes a complete secret on finish and blocks later chunks after an incomplete prefix", () => {
		const complete = guardFor();
		complete.push(SECRET);
		const flushed = complete.finish();
		expect(flushed).toContain("#MULTILINE_CANARY#");
		expect(flushed).not.toContain(SECRET);

		const cancelled = guardFor();
		expect(cancelled.push(PREFIX)).toBe("");
		const prefixFlush = cancelled.finish();
		expect(prefixFlush).toBe(PREFIX);
		expect(cancelled.push("synthetic-second-line\n")).toBe("");
	});

	it("segments a long structured-looking stream without splitting registered multiline secrets", () => {
		const lines = ["prefix {"];
		let length = lines[0]!.length + 1;
		for (let index = 0; length < 65_500; index++) {
			const line = `row-${index.toString().padStart(4, "0")}: ${"x".repeat(80)}`;
			lines.push(line);
			length += line.length + 1;
		}
		const prefix = `${lines.join("\n")}\n`;
		expect(prefix.length).toBeGreaterThan(65_400);
		expect(prefix.length).toBeLessThan(65_600);
		const input = `${prefix}${SECRET}\n}\nError: long checkout failed\n`;
		const start = input.indexOf(SECRET);
		for (let split = start; split <= start + SECRET.length; split++) {
			const guard = guardFor();
			const streamed = guard.push(input.slice(0, split)) + guard.push(input.slice(split)) + guard.finish();
			const leaked = streamed.includes(SECRET);
			expect(leaked, `split=${split} leaked a registered literal`).toBe(false);
			expect(
				streamed.includes("[line over 65,536 chars, not scanned]"),
				`split=${split} did not mask the oversized candidate`,
			).toBe(true);
			expect(streamed.includes("Error: long checkout failed\n"), `split=${split} lost the final diagnostic`).toBe(
				true,
			);
		}
	});
	it("labels oversized GitHub JSON lines without releasing planted credentials", () => {
		const longLine = `{"payload":"${"x".repeat(65_537)}","token":"ghs_planted_fake_value"}`;
		const direct = new ProducerOutputGuard().sanitize(longLine);
		expect(direct).toBe("[line over 65,536 chars, not scanned]");
		expect(direct).not.toContain("ghs_");

		const guard = new ProducerOutputGuard();
		const later = "Error: later safe diagnostic\n";
		const streamed = guard.push(`${longLine}\n${later}`) + guard.finish();
		expect(streamed).toBe(`[line over 65,536 chars, not scanned]\n${later}`);
		expect(streamed).not.toContain("ghs_");
		expect(guard.push('{"later":"safe"}\n')).toBe('{"later":"safe"}\n');
	});
	it("emits a single oversized placeholder for balanced or multiline structured oversized records", () => {
		const longLine = `{"payload":"${"x".repeat(65_537)}","token":"ghs_planted_fake_value"}`;
		const streamedNoNewline = new ProducerOutputGuard();
		expect(streamedNoNewline.push(longLine) + streamedNoNewline.finish()).toBe(OVERSIZED_OUTPUT_RECORD);

		const multilineGuard = new ProducerOutputGuard();
		const multiline = `foo: {\n  payload: "${"x".repeat(65_537)}"\n}\nError: after structured\n`;
		expect(multilineGuard.push(multiline) + multilineGuard.finish()).toBe(
			`${OVERSIZED_OUTPUT_RECORD}\nError: after structured\n`,
		);

		const assignmentGuard = new ProducerOutputGuard();
		expect(assignmentGuard.push(`A=1\n${longLine}\n`) + assignmentGuard.finish()).toBe(
			`A=1\n${OVERSIZED_OUTPUT_RECORD}\n`,
		);
	});
	it("withholds a known multiline literal that exceeds the bounded pending record", () => {
		const longSecret = `${"a".repeat(32 * 1024)}\n${"b".repeat(32 * 1024)}`;
		const guard = guardFor(longSecret);
		const firstRecord = `${"a".repeat(32 * 1024)}\n`;
		const secondRecord = `${"b".repeat(32 * 1024)}\n`;

		expect(guard.push(firstRecord)).toBe("");
		const blocked = guard.push(secondRecord);
		expect(blocked).toBe("[line over 65,536 chars, not scanned]\n");
		expect(blocked).not.toContain(longSecret);
		expect(guard.push("after\n")).toBe("after\n");
	});
	it("carries a registered literal through the record cap before resuming", () => {
		const partLength = 25 * 1024;
		const longSecret = `${"a".repeat(partLength)}\n${"b".repeat(partLength)}\n${"c".repeat(partLength)}\n${"d".repeat(partLength)}`;
		const guard = guardFor(longSecret);
		const first = `${"a".repeat(partLength)}\n`;
		const second = `${"b".repeat(partLength)}\n`;
		const third = `${"c".repeat(partLength)}\n`;
		const fourth = `${"d".repeat(partLength)}\n`;

		expect(guard.push(first)).toBe("");
		expect(guard.push(second)).toBe("");
		expect(guard.push(third.slice(0, 16 * 1024))).toBe("");
		expect(guard.push(third.slice(16 * 1024))).toBe("");
		expect(guard.push(fourth)).toBe("[line over 65,536 chars, not scanned]\n");
		expect(guard.push("after\n")).toBe("after\n");
		expect(guard.finish()).toBe("");
	});
	it("matches multiline literals after supported ANSI normalization", () => {
		const guard = guardFor();
		const streamed = guard.push(`synthetic-first-line\nsyn\u001b[31mthetic-second-line\n`) + guard.finish();

		expect(streamed).not.toContain(SECRET);
		expect(streamed).not.toContain("synthetic-second-line");
		expect(streamed).toContain("#MULTILINE_CANARY#");
	});

	it.each(["", "{}\n"])("keeps an inventory after a held prefix with preamble %j out of output", preamble => {
		const prefix = `synthetic-first-line\n${preamble}`;
		const guard = guardFor(`${prefix}expected-tail`);

		expect(guard.push(prefix)).toBe("");
		expect(guard.push("FIRST_VALUE=synthetic-first-value\n")).toBe("");
		expect(guard.push("SECOND_VALUE=synthetic-second-value\n")).toBe("");
		expect(guard.push("THIRD_VALUE=synthetic-third-value\n")).toBe("[credential output withheld]\n");
		expect(guard.finish()).toBe("");
	});

	it("includes the terminating newline when redacting a held literal", () => {
		const secret = `${SECRET}\n`;
		const guard = guardFor(secret);

		expect(guard.push(secret)).toBe("#MULTILINE_CANARY#");
		expect(guard.finish()).toBe("");
	});

	it("carries environment-inventory taint across oversized assignment records at every split", () => {
		const oversized = "x".repeat(65_537);
		const blockedCases = [
			`FIRST=${oversized}\nSECOND=opaque-second\nTHIRD=opaque-third\nend\n`,
			`FIRST=opaque-first\nSECOND=${oversized}\nTHIRD=opaque-third\nend\n`,
			`FIRST=opaque-first\nSECOND=opaque-second\nTHIRD=${oversized}\nend\n`,
			`FIRST=${oversized}\n\nSECOND=opaque-second\nTHIRD=opaque-third\nend\n`,
			`export FIRST=${oversized}\nSECOND=opaque-second\nTHIRD=opaque-third\nend\n`,
		];
		for (const input of blockedCases) {
			expect(new ProducerOutputGuard().sanitize(input)).toBe(BLOCKED_OUTPUT_RECORD);
			const wholeGuard = new ProducerOutputGuard();
			const whole = wholeGuard.push(input) + wholeGuard.finish();
			expect(whole).toBe(`${BLOCKED_OUTPUT_RECORD}\n`);
			expect(whole).not.toContain("opaque-second");
			expect(whole).not.toContain("opaque-third");
			const splits = new Set([
				0,
				5,
				6,
				7,
				65_535,
				65_536,
				65_537,
				input.indexOf("\n"),
				input.indexOf("\n") + 1,
				input.indexOf("THIRD") + 6,
			]);
			for (const split of splits) {
				if (split < 0 || split > input.length) continue;
				const splitGuard = new ProducerOutputGuard();
				const streamed =
					splitGuard.push(input.slice(0, split)) + splitGuard.push(input.slice(split)) + splitGuard.finish();
				expect(streamed).toBe(`${BLOCKED_OUTPUT_RECORD}\n`);
				expect(streamed).not.toContain("opaque-second");
				expect(streamed).not.toContain("opaque-third");
			}
			const chunkGuard = new ProducerOutputGuard();
			let chunked = "";
			for (let offset = 0; offset < input.length; offset += 8192) {
				chunked += chunkGuard.push(input.slice(offset, offset + 8192));
			}
			chunked += chunkGuard.finish();
			expect(chunked).toBe(`${BLOCKED_OUTPUT_RECORD}\n`);
		}

		const twoAssignmentCases = [
			`FIRST=${oversized}\nSECOND=opaque-second\nend\n`,
			`FIRST=opaque-first\nSECOND=${oversized}\nend\n`,
			`FIRST=opaque-first\n${oversized}\nSECOND=opaque-second\nTHIRD=opaque-third\nend\n`,
		];
		for (const input of twoAssignmentCases) {
			const direct = new ProducerOutputGuard().sanitize(input);
			const wholeGuard = new ProducerOutputGuard();
			expect(wholeGuard.push(input) + wholeGuard.finish()).toBe(direct);
			const chunkGuard = new ProducerOutputGuard();
			let chunked = "";
			for (let offset = 0; offset < input.length; offset += 8192) {
				chunked += chunkGuard.push(input.slice(offset, offset + 8192));
			}
			chunked += chunkGuard.finish();
			expect(chunked).toBe(direct);
		}
		const longOversizedCases = [
			`export ${" ".repeat(300)}FIRST=${oversized}\nSECOND=opaque-second\nTHIRD=opaque-third\nend\n`,
			`FIRST=opaque-first\nexport ${" ".repeat(300)}SECOND=${oversized}\nTHIRD=opaque-third\nend\n`,
			`FIRST=opaque-first\nSECOND=opaque-second\nexport ${" ".repeat(300)}THIRD=${oversized}\nend\n`,
			...[255, 256, 257, 320].flatMap(keyLength => {
				const key = "K".repeat(keyLength);
				return [
					`${key}=${oversized}\nSECOND=opaque-second\nTHIRD=opaque-third\nend\n`,
					`FIRST=opaque-first\n${key}=${oversized}\nTHIRD=opaque-third\nend\n`,
					`FIRST=opaque-first\nSECOND=opaque-second\n${key}=${oversized}\nend\n`,
				];
			}),
		];
		for (const input of longOversizedCases) {
			expect(new ProducerOutputGuard().sanitize(input)).toBe(BLOCKED_OUTPUT_RECORD);
			const wholeGuard = new ProducerOutputGuard();
			const whole = wholeGuard.push(input) + wholeGuard.finish();
			expect(whole).toBe(`${BLOCKED_OUTPUT_RECORD}\n`);
			expect(whole).not.toContain("opaque-second");
			expect(whole).not.toContain("opaque-third");

			const chunkGuard = new ProducerOutputGuard();
			let chunked = "";
			for (let offset = 0; offset < input.length; offset += 128) {
				chunked += chunkGuard.push(input.slice(offset, offset + 128));
			}
			chunked += chunkGuard.finish();
			expect(chunked).toBe(`${BLOCKED_OUTPUT_RECORD}\n`);
		}
	});

	it("bounds retained pending bytes across repeating prefixes past 16 Mi chars and resumes safely", () => {
		const guard = guardFor();
		const repeatChunk = PREFIX.repeat(10_000);
		let output = "";
		for (let batch = 0; batch < 100; batch++) {
			output += guard.push(repeatChunk);
		}
		output += guard.push("break\nError: after repeating prefix\n") + guard.finish();
		expect(output).toBe(`${OVERSIZED_OUTPUT_RECORD}\nError: after repeating prefix\n`);

		const completedSecretGuard = guardFor();
		let secretOutput = completedSecretGuard.push(PREFIX.repeat(4000));
		secretOutput += completedSecretGuard.push("synthetic-second-line\nError: secret stayed masked\n");
		secretOutput += completedSecretGuard.finish();
		expect(secretOutput).toBe(`${OVERSIZED_OUTPUT_RECORD}\nError: secret stayed masked\n`);
		expect(secretOutput).not.toContain("synthetic-second-line");

		const unnewlinedGuard = guardFor();
		let unnewlinedOutput = unnewlinedGuard.push(PREFIX.repeat(4000));
		unnewlinedOutput += unnewlinedGuard.push("x".repeat(2_000_000));
		unnewlinedOutput += unnewlinedGuard.push("\nError: after unnewlined overflow\n") + unnewlinedGuard.finish();
		expect(unnewlinedOutput).toBe(`${OVERSIZED_OUTPUT_RECORD}\nError: after unnewlined overflow\n`);

		const pathological = new ProducerOutputGuard(undefined, text => text.length);
		let pathologicalOutput = "";
		const line = `${"a".repeat(25_000)}\n`;
		for (let count = 0; count < 60; count++) {
			pathologicalOutput += pathological.push(line);
		}
		pathologicalOutput += pathological.finish();
		expect(pathologicalOutput).toBe(OVERSIZED_OUTPUT_RECORD);
	}, 15_000);
	it("preserves registered-literal protection across a 16 Mi quoted first record", () => {
		const tail = "Error: final diagnostic\n";
		const input = `"${"x".repeat(16 * 1024 * 1024 + 1)}"\n${SECRET}\n${tail}`;
		const direct = runWithProducerSecretOwner(
			{
				redact: text => new SecretObfuscator([{ type: "plain", origin: "config", content: SECRET, name: "MULTILINE_CANARY" }]).obfuscate(text),
				pendingPrefixLength: text => new SecretObfuscator([{ type: "plain", origin: "config", content: SECRET, name: "MULTILINE_CANARY" }]).pendingRedactionPrefixLength(text),
			},
			() => new ProducerOutputGuard().sanitize(input),
		);
		expect(direct).toContain("#MULTILINE_CANARY#");
		expect(direct).not.toContain(SECRET);
		expect(direct.endsWith(tail)).toBe(true);

		const streamGuard = guardFor();
		const streamed = streamGuard.push(input) + streamGuard.finish();
		expect(streamed).toBe(direct);

		const boundaryGuard = guardFor(`${"x".repeat(64)}\n${SECRET}`);
		const boundaryInput = `"${"x".repeat(16 * 1024 * 1024 + 64)}\n${SECRET}\n${tail}`;
		const boundaryStreamed = boundaryGuard.push(boundaryInput) + boundaryGuard.finish();
		expect(boundaryStreamed).toBe(OVERSIZED_OUTPUT_RECORD);
		expect(boundaryStreamed).not.toContain(SECRET);
	}, 25_000);
});
