import { describe, expect, it } from "bun:test";
import { runCheckTs } from "./check-ts";

describe("runCheckTs", () => {
	it("runs workspace typechecks even when root tools typecheck fails and preserves nonzero exit", async () => {
		const calls: string[][] = [];
		const code = await runCheckTs(async command => {
			calls.push(command);
			return calls.length === 1 ? 2 : 0;
		});
		expect(calls).toEqual([
			["bun", "run", "check:types"],
			["bun", "run", "--workspaces", "--if-present", "check:types"],
		]);
		expect(code).toBe(2);
	});

	it("returns nonzero when workspace typechecks fail after tools passes", async () => {
		const calls: string[][] = [];
		const code = await runCheckTs(async command => {
			calls.push(command);
			return calls.length === 2 ? 3 : 0;
		});
		expect(calls).toEqual([
			["bun", "run", "check:types"],
			["bun", "run", "--workspaces", "--if-present", "check:types"],
		]);
		expect(code).toBe(3);
	});

	it("runs workspace typechecks even when root tools step rejects and returns nonzero", async () => {
		const calls: string[][] = [];
		const code = await runCheckTs(async command => {
			calls.push(command);
			if (calls.length === 1) throw new Error("spawn EAGAIN");
			return 0;
		});
		expect(calls).toEqual([
			["bun", "run", "check:types"],
			["bun", "run", "--workspaces", "--if-present", "check:types"],
		]);
		expect(code).toBe(1);
	});

	it("returns zero when both steps pass", async () => {
		const code = await runCheckTs(async () => 0);
		expect(code).toBe(0);
	});
});
