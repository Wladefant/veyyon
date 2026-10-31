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
import { ProducerOutputGuard } from "../../src/secrets/producer-output";
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
			const streamed =
				guard.push(input.slice(0, split)) +
				guard.push(input.slice(split)) +
				guard.finish();

			expect(streamed).not.toContain(SECRET);
			expect(streamed).toContain("#MULTILINE_CANARY#");
			expect(streamed).toContain("before\n");
			expect(streamed).toContain("after\n");
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

	it("withholds a known multiline literal that exceeds the bounded pending record", () => {
		const longSecret = `${"a".repeat(32 * 1024)}\n${"b".repeat(32 * 1024)}`;
		const guard = guardFor(longSecret);
		const firstRecord = `${"a".repeat(32 * 1024)}\n`;
		const secondRecord = `${"b".repeat(32 * 1024)}\n`;

		expect(guard.push(firstRecord)).toBe("");
		const blocked = guard.push(secondRecord);
		expect(blocked).toBe("[credential output withheld]\n");
		expect(blocked).not.toContain(longSecret);
		expect(guard.push("after\n")).toBe("");
	});
	it("matches multiline literals after supported ANSI normalization", () => {
		const guard = guardFor();
		const streamed =
			guard.push(`synthetic-first-line\nsyn\u001b[31mthetic-second-line\n`) + guard.finish();

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

});
