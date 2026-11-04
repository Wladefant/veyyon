import { describe, expect, it } from "bun:test";
import {
	bindProducerSecretOwner,
	currentProducerSecretOwner,
	producerRedactText,
	producerSecretOwnerFor,
	runWithProducerSecretOwner,
} from "../../src/secrets/producer-owner";

function owner(marker: string) {
	return { redact: (text: string) => `${marker}:${text}` };
}

describe("producer secret ownership", () => {
	it("keeps overlapping async jobs on their own redaction authority", async () => {
		const first = owner("first");
		const second = owner("second");
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();

		const firstJob = runWithProducerSecretOwner(first, async () => {
			firstStarted.resolve();
			await releaseFirst.promise;
			return producerRedactText("output");
		});
		await firstStarted.promise;
		const secondResult = await runWithProducerSecretOwner(second, async () => {
			await Promise.resolve();
			return producerRedactText("output");
		});
		releaseFirst.resolve();

		expect(secondResult).toBe("second:output");
		expect(await firstJob).toBe("first:output");
		expect(currentProducerSecretOwner()).toBeUndefined();
	});

	it("uses identity outside an owner and binds final arguments by object identity", () => {
		const authority = owner("admitted");
		const args = { command: "run" };
		const otherArgs = { command: "run" };

		expect(producerRedactText("plain")).toBe("plain");
		expect(bindProducerSecretOwner(args, authority)).toBe(args);
		expect(producerSecretOwnerFor(args)).toBe(authority);
		expect(producerSecretOwnerFor(otherArgs)).toBeUndefined();
	});
});
