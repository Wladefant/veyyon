import { describe, expect, it } from "bun:test";
import { BLOCKED_OUTPUT_RECORD, ProducerOutputGuard } from "@veyyon/coding-agent/secrets/producer-output";

// WHY: harmless compact CI JSON crossed the ordinary 64 KiB record limit and disappeared.
// Cover structured records across formatting and chunk boundaries without weakening credential or ordinary-record bounds.
// The structured budget remains finite; records above 1 MiB still fail closed.
const payload = "x".repeat(66_000);

describe("large structured producer records retain bounded harmless output", () => {
	for (const sourceFactory of [
		(pretty: boolean) => JSON.stringify({ result: payload, count: 3 }, null, pretty ? 2 : undefined),
		(pretty: boolean) => JSON.stringify([payload, { count: 3 }], null, pretty ? 2 : undefined),
	]) {
		for (const pretty of [false, true]) {
			for (const chunkSize of [1, 127, 65_536, 100_000]) {
				it(`preserves ${pretty ? "pretty" : "compact"} object or array JSON in ${chunkSize}-character chunks`, () => {
					const source = ` \t${sourceFactory(pretty)}\n`;
					const guard = new ProducerOutputGuard();
					const parts: string[] = [];
					for (let offset = 0; offset < source.length; offset += chunkSize) {
						parts.push(guard.push(source.slice(offset, offset + chunkSize)));
					}
					parts.push(guard.finish());
					expect(parts.join("")).toBe(source);
				});
			}
		}
	}
	for (const sourceFactory of [
		() => JSON.stringify({ result: payload, count: 3 }),
		() => JSON.stringify([payload, { count: 3 }]),
	]) {
		it("preserves complete large objects and arrays in sanitize()", () => {
			const source = ` \t${sourceFactory()}\n`;
			expect(new ProducerOutputGuard().sanitize(source)).toBe(source);
		});
	}
	it("withholds a complete large object with late credential or inventory keys in sanitize()", () => {
		for (const tail of [
			', "access_token": "fake-private-tail"}',
			', "ALPHA": "a", "BETA": "b", "GAMMA": "c"}',
		]) {
			const source = ` \t${JSON.stringify({ result: payload }).slice(0, -1)}${tail}\n`;
			const result = new ProducerOutputGuard().sanitize(source);
			expect(result).toContain(BLOCKED_OUTPUT_RECORD);
			expect(result).not.toContain(payload);
			expect(result).not.toContain("fake-private-tail");
		}
	});

	it("keeps the ordinary 64 KiB cap in sanitize()", () => {
		expect(new ProducerOutputGuard().sanitize(payload)).toContain(BLOCKED_OUTPUT_RECORD);
	});



	it("still withholds an oversized ordinary line", () => {
		const guard = new ProducerOutputGuard();
		expect(guard.push(payload) + guard.finish()).toContain(BLOCKED_OUTPUT_RECORD);
	});

	it("withholds a structured record beyond the finite budget", () => {
		const source = JSON.stringify({ result: "x".repeat(1_048_576) });
		const guard = new ProducerOutputGuard();
		expect(guard.push(source) + guard.finish()).toBe(BLOCKED_OUTPUT_RECORD);
	});

	for (const secretTail of [",\"access_token\":\"fake-private-tail\"}", ",\"ALPHA\":\"a\",\"BETA\":\"b\",\"GAMMA\":\"c\"}"]) {
		it("holds the full large object until its late credential or inventory classification", () => {
			const prefix = JSON.stringify({ result: payload }).slice(0, -1);
			const guard = new ProducerOutputGuard();
			expect(guard.push(prefix)).toBe("");
			const result = guard.push(secretTail + "\n") + guard.finish();
			expect(result).toContain(BLOCKED_OUTPUT_RECORD);
			expect(result).not.toContain(payload);
			expect(result).not.toContain("fake-private-tail");
		});
	}

	it("applies registered-literal redaction to the complete large structured record", () => {
		const secret = "fake-registered-large-value";
		const source = JSON.stringify({ result: payload, note: secret });
		const guard = new ProducerOutputGuard(text => text.replaceAll(secret, "<redacted>"));
		const result = guard.push(source) + guard.finish();
		expect(JSON.parse(result)).toEqual({ result: payload, note: "<redacted>" });
	});
});
