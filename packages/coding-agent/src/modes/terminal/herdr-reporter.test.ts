import { describe, expect, it } from "bun:test";
import type { AgentSession } from "../../session/agent-session";
import type { AgentSessionEvent } from "../../session/agent-session-types";
import { HerdrReporter, herdrResumeArgv } from "./herdr-reporter";

const env = { HERDR_ENV: "1", HERDR_BIN_PATH: "herdr", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "isolated.sock" };

function session(id: string, file: string | null = `/sessions/${id}.jsonl`) {
	let listener: ((event: AgentSessionEvent) => void) | undefined;
	const value = {
		isStreaming: false,
		sessionManager: { getSessionId: () => id, getSessionFile: () => file },
		subscribe: (callback: (event: AgentSessionEvent) => void) => {
			listener = callback;
			return () => {
				listener = undefined;
			};
		},
	} as unknown as AgentSession;
	return { value, emit: (type: "agent_start" | "agent_end") => listener?.({ type } as AgentSessionEvent) };
}

async function settle() {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("Herdr restores the foreground Veyyon conversation", () => {
	it("does nothing outside a fully identified Herdr pane", async () => {
		const calls: string[][] = [];
		for (const missing of Object.keys(env)) {
			const partial = { ...env, [missing]: undefined };
			const reporter = new HerdrReporter(
				partial,
				async (_binary, args) => {
					calls.push(args);
				},
				"work",
				[],
			);
			reporter.attach(session("a").value);
			reporter.release();
		}
		await settle();
		expect(calls).toEqual([]);
	});

	it("reports the exact persisted session, profile and explicit extensions without replaying prompts", async () => {
		const calls: string[][] = [];
		const reporter = new HerdrReporter(
			env,
			async (_binary, args) => {
				calls.push(args);
			},
			"work",
			["--extension", "/telegram/index.ts", "--fork", "old", "do it"],
		);
		reporter.attach(session("a").value);
		await settle();
		expect(calls[0]!.slice(calls[0]!.indexOf("--") + 1)).toEqual([
			"veyyon",
			"--profile",
			"work",
			"--resume",
			"/sessions/a.jsonl",
			"--extension",
			"/telegram/index.ts",
		]);
		expect(calls[0]).toContain("--agent-session-id");
	});

	it("changes the resume target and stops listening to the previous foreground session", async () => {
		const calls: string[][] = [];
		const reporter = new HerdrReporter(
			env,
			async (_binary, args) => {
				calls.push(args);
			},
			"default",
			[],
		);
		const a = session("a");
		const b = session("b");
		reporter.attach(a.value);
		await settle();
		reporter.attach(b.value);
		await settle();
		a.emit("agent_start");
		await settle();
		expect(calls).toHaveLength(2);
		expect(calls[1]).toContain("/sessions/b.jsonl");
		b.emit("agent_start");
		await settle();
		expect(calls[2]).toContain("working");
		expect(Number(calls[2]![calls[2]!.indexOf("--seq") + 1])).toBeGreaterThan(
			Number(calls[0]![calls[0]!.indexOf("--seq") + 1]),
		);
	});

	it("coalesces state bursts and releases only once after an intentional quit", async () => {
		const gate = Promise.withResolvers<void>();
		const calls: string[][] = [];
		const reporter = new HerdrReporter(
			env,
			async (_binary, args) => {
				calls.push(args);
				if (calls.length === 1) await gate.promise;
			},
			"default",
			[],
		);
		const s = session("a");
		reporter.attach(s.value);
		s.emit("agent_start");
		s.emit("agent_end");
		reporter.release();
		reporter.release();
		gate.resolve();
		await settle();
		expect(calls).toHaveLength(2);
		expect(calls[1]![1]).toBe("release-agent");
	});

	it("ignores transport errors and never sends an invalid resume argv", async () => {
		const calls: string[][] = [];
		const reporter = new HerdrReporter(
			env,
			async (_binary, args) => {
				calls.push(args);
				throw new Error("server disappeared");
			},
			"default",
			[],
		);
		const s = session("a", "/sessions/it's-invalid.jsonl");
		reporter.attach(s.value);
		await settle();
		s.emit("agent_start");
		await settle();
		expect(calls).toHaveLength(2);
		expect(calls[0]).not.toContain("--");
		expect(herdrResumeArgv("/a\n.jsonl", "default", [], "/launch")).toBeUndefined();
		expect(
			herdrResumeArgv(
				"/a.jsonl",
				"default",
				Array.from({ length: 70 }, () => "--extension=x"),
				"/launch",
			),
		).toBeUndefined();
	});

	it("re-reports after an in-place session switch while idle, and only then", async () => {
		const calls: string[][] = [];
		const current = { id: "a", file: "/sessions/a.jsonl" };
		const value = {
			isStreaming: false,
			sessionManager: { getSessionId: () => current.id, getSessionFile: () => current.file },
			subscribe: () => () => {},
		} as unknown as AgentSession;
		const reporter = new HerdrReporter(
			env,
			async (_binary, args) => {
				calls.push(args);
			},
			"work",
			[],
			"/launch",
			5,
		);
		reporter.attach(value);
		await Bun.sleep(30);
		expect(calls).toHaveLength(1);
		current.id = "b";
		current.file = "/sessions/b.jsonl";
		await Bun.sleep(40);
		expect(calls).toHaveLength(2);
		expect(calls[1]).toContain("b");
		expect(calls[1]!.slice(calls[1]!.indexOf("--") + 1)).toContain("/sessions/b.jsonl");
		reporter.release();
		const sent = calls.length;
		current.id = "c";
		await Bun.sleep(30);
		expect(calls).toHaveLength(sent);
	});

	it("pins relative extension paths to the launch directory", () => {
		const argv = herdrResumeArgv(
			"/s/a.jsonl",
			"work",
			["-e", "./tools/ext.ts", "--hook=h/x.ts", "--extension", "~/e.ts"],
			"/launch",
		);
		expect(argv).toEqual([
			"veyyon",
			"--profile",
			"work",
			"--resume",
			"/s/a.jsonl",
			"-e",
			"/launch/tools/ext.ts",
			"--hook",
			"/launch/h/x.ts",
			"--extension",
			"~/e.ts",
		]);
	});
});
