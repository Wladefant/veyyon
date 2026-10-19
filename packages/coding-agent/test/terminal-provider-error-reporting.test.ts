import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { reportProviderError } from "../src/task/provider-error-reporter";

function fixture() {
	const child = new EventEmitter() as ChildProcess;
	const input = new EventEmitter();
	const bodies: string[] = [];
	const calls: unknown[][] = [];
	let kills = 0;
	let unrefs = 0;
	Object.assign(input, { end: (body: string) => bodies.push(body) });
	Object.assign(child, {
		stdin: input,
		kill: () => {
			kills++;
			return true;
		},
		unref: () => {
			unrefs++;
		},
	});
	const spawner = ((...args: unknown[]) => {
		calls.push(args);
		return child;
	}) as typeof spawn;
	return { child, input, bodies, calls, spawner, kills: () => kills, unrefs: () => unrefs };
}

const scriptPath = "model_routing.py";
describe("terminal provider error reporting", () => {
	afterEach(() => vi.useRealTimers());
	for (const body of [
		"429 usage_limit_reached",
		"HTTP 402 Payment Required",
		"Google API error (429): quota exceeded",
	]) {
		it(`reports ${body} once with the exact model and stdin body`, () => {
			const f = fixture();
			reportProviderError("openai-codex/gpt-5.6-sol", body, {
				scriptPath,
				scriptExists: () => true,
				spawner: f.spawner,
			});
			expect(f.calls).toHaveLength(1);
			expect(f.calls[0].slice(1)).toEqual([
				[scriptPath, "record-error", "--model", "openai-codex/gpt-5.6-sol"],
				{ stdio: ["pipe", "ignore", "ignore"], windowsHide: true },
			]);
			expect(f.bodies).toEqual([body]);
			expect(f.unrefs()).toBe(1);
			f.child.emit("close", 0, null);
		});
	}
	it("ignores other errors, numeric text and a missing script", () => {
		const f = fixture();
		for (const body of ["HTTP 500 server error", "processed 429 items", "port 4020", ""]) {
			reportProviderError("provider/model", body, { scriptExists: () => true, spawner: f.spawner });
		}
		reportProviderError("provider/model", "429 quota", { scriptExists: () => false, spawner: f.spawner });
		expect(f.calls).toHaveLength(0);
	});
	it("returns immediately and kills a hanging script at the deadline", () => {
		vi.useFakeTimers();
		const f = fixture();
		expect(
			reportProviderError("provider/model", "429 quota", {
				scriptExists: () => true,
				spawner: f.spawner,
				timeoutMs: 20,
			}),
		).toBeUndefined();
		expect(f.kills()).toBe(0);
		vi.advanceTimersByTime(60);
		expect(f.kills()).toBe(1);
	});
	it("clears the deadline when the child exits", () => {
		vi.useFakeTimers();
		const f = fixture();
		reportProviderError("provider/model", "429 quota", {
			scriptExists: () => true,
			spawner: f.spawner,
			timeoutMs: 20,
		});
		f.child.emit("close", 0, null);
		vi.advanceTimersByTime(60);
		expect(f.kills()).toBe(0);
	});
	it("contains spawn, process and stdin failures", () => {
		expect(() =>
			reportProviderError("provider/model", "429 quota", {
				scriptExists: () => true,
				spawner: (() => {
					throw new Error("secret");
				}) as typeof spawn,
			}),
		).not.toThrow();
		const f = fixture();
		reportProviderError("provider/model", "429 quota", { scriptExists: () => true, spawner: f.spawner });
		expect(() => {
			f.child.emit("error", new Error("secret"));
			f.input.emit("error", new Error("secret"));
		}).not.toThrow();
		f.child.emit("close", 1, null);
	});
});
