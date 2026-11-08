import { describe, expect, it } from "bun:test";
import { redactUsageText } from "@veyyon/ai/auth-storage/usage-redaction";
import { ProducerOutputGuard } from "../../src/secrets/producer-output";

const guard = new ProducerOutputGuard(text => redactUsageText(text, []));

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
		const text = JSON.stringify(["token: str", "secret: string", "password: str"]);

		expect(guard.sanitize(text)).toBe(text);
	});

	it("masks only the value of a labelled synthetic credential", () => {
		const token = `ghp_${"A".repeat(36)}`;
		const text = `before token=${token} after`;

		expect(guard.sanitize(text)).toBe("before token=<redacted 40 chars> after");
	});

	it("masks a bare real-format synthetic token and preserves surrounding metadata", () => {
		const token = `ghp_${"B".repeat(36)}`;
		const text = `before ${token} after`;

		expect(guard.sanitize(text)).toBe("before <redacted 40 chars> after");
	});
});
