import { describe, expect, it } from "bun:test";
import { redactProviderSecrets } from "@veyyon/ai/error/error-body";
import { ProducerOutputGuard } from "../../src/secrets/producer-output";

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

	it("keeps plain defs-style metadata unchanged", () => {
		const text = "figma_secret: str";

		expect(guard.sanitize(text)).toBe(text);
	});

	it("keeps defs metadata and labelled-token context across every stream split", () => {
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
					expect(streamed).toBe(`before token=[REDACTED]\n`);
				}
			}
		}
	});


	it("masks only the value of a labelled synthetic credential", () => {
		const token = `ghp_${"A".repeat(36)}`;
		const text = `before token=${token} after`;

		expect(guard.sanitize(text)).toBe("before token=[REDACTED]");
	});
	it("masks only the value after a spaced assignment delimiter", () => {
		const token = `ghp_${"D".repeat(36)}`;
		const text = `before token= ${token} after`;

		expect(guard.sanitize(text)).toBe("before token= [REDACTED]");
	});

	it("masks a bare real-format synthetic token and preserves surrounding metadata", () => {
		const token = `ghp_${"B".repeat(36)}`;
		const text = `before ${token} after`;

		expect(guard.sanitize(text)).toBe("before <redacted 40 chars> after");
	});
});
