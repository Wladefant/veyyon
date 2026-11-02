import { describe, expect, it } from "bun:test";
import { BLOCKED_OUTPUT_RECORD, ProducerOutputGuard } from "../src/secrets/producer-output";

// The real eval JS OutputSink uses this guard before streaming or artifact retention.
// All examples use invented values; no environment or provider is contacted.
function filterChunks(...chunks: string[]): string {
	const guard = new ProducerOutputGuard();
	let published = "";
	for (const chunk of chunks) published += guard.push(chunk);
	return published + guard.finish();
}

const OPEN_OBJECT = '{\n  "ALPHA": "fake-a",\n  "BETA": "fake-b",\n';

describe("an interrupted structured inventory cannot be flushed at eval completion", () => {
	it("withholds two neutral-key records in an object with no closing brace", () => {
		const guard = new ProducerOutputGuard();
		expect(guard.push('{\n  "ALPHA": "fake-a",\n')).toBe("");
		expect(guard.push('  "BETA": "fake-b",\n')).toBe("");
		expect(guard.finish()).toBe(BLOCKED_OUTPUT_RECORD);
		// The completion hook must not re-release held data on a later call.
		expect(guard.finish()).toBe("");
	});

	it("withholds a final incomplete line when cancellation ends mid-object", () => {
		const output = filterChunks(
			"ordinary status\n{\n",
			'  "ALPHA": "fake-a",\n',
			'  "BETA": "fake-b"',
		);
		expect(output).toBe("ordinary status\n" + BLOCKED_OUTPUT_RECORD);
		expect(output).not.toContain("fake-a");
		expect(output).not.toContain("fake-b");
	});

	it("keeps the incomplete object hidden when the producer splits every character", () => {
		const guard = new ProducerOutputGuard();
		for (const character of OPEN_OBJECT) {
			expect(guard.push(character)).toBe("");
		}
		expect(guard.finish()).toBe(BLOCKED_OUTPUT_RECORD);
	});

	it("still emits a complete small structured object with two ordinary keys", () => {
		const closed = '{\n  "ALPHA": "fake-a",\n  "BETA": "fake-b"\n}\n';
		expect(filterChunks(closed.slice(0, 17), closed.slice(17))).toBe(closed);
	});

	it("preserves the existing two-assignment allowance for complete records", () => {
		expect(filterChunks("ALPHA=fake-a\n", "BETA=fake-b\n")).toBe("ALPHA=fake-a\nBETA=fake-b\n");
	});

	it("continues to withhold three complete consecutive assignments", () => {
		const result = filterChunks("ALPHA=fake-a\n", "BETA=fake-b\n", "GAMMA=fake-c\n");
		expect(result).toContain(BLOCKED_OUTPUT_RECORD);
		expect(result).not.toContain("fake-a");
		expect(result).not.toContain("fake-b");
		expect(result).not.toContain("fake-c");
	});
});
