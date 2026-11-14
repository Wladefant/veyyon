import { describe, expect, it } from "bun:test";
import { Semaphore } from "../../src/task/parallel";

const turn = async () => {
	await Promise.resolve();
	await Promise.resolve();
};

describe("priority spawn admission", () => {
	it("admits high priority at the next release without exceeding the ceiling", async () => {
		const semaphore = new Semaphore(1);
		await semaphore.acquire();
		const admitted: string[] = [];
		const normal = semaphore.acquire().then(() => admitted.push("normal"));
		const high = semaphore.acquire(undefined, "high").then(() => admitted.push("high"));
		await turn();
		expect(admitted).toEqual([]);
		semaphore.release();
		await turn();
		expect(admitted).toEqual(["high"]);
		semaphore.release();
		await Promise.all([normal, high]);
		expect(admitted).toEqual(["high", "normal"]);
		semaphore.release();
	});

	it("preserves FIFO within each priority when the ceiling rises", async () => {
		const semaphore = new Semaphore(1);
		await semaphore.acquire();
		const admitted: string[] = [];
		const pending = [
			semaphore.acquire().then(() => admitted.push("normal1")),
			semaphore.acquire(undefined, "high").then(() => admitted.push("high1")),
			semaphore.acquire(undefined, "normal").then(() => admitted.push("normal2")),
			semaphore.acquire(undefined, "high").then(() => admitted.push("high2")),
		];
		semaphore.resize(5);
		await Promise.all(pending);
		expect(admitted).toEqual(["high1", "high2", "normal1", "normal2"]);
		for (let i = 0; i < 5; i++) semaphore.release();
	});

	it("removes cancelled high-priority waiters without losing the released slot", async () => {
		const semaphore = new Semaphore(1);
		await semaphore.acquire();
		const controller = new AbortController();
		const normal = semaphore.acquire();
		const high = semaphore.acquire(controller.signal, "high");
		const rejected = expect(high).rejects.toThrow("cancel priority");
		controller.abort(new Error("cancel priority"));
		await rejected;
		semaphore.release();
		await normal;
		semaphore.release();
		await semaphore.acquire();
		semaphore.release();
	});
});
