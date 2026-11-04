import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolUpdateCallback } from "@veyyon/agent-core";
import { SecretObfuscator } from "../../src/secrets/obfuscator";
import { bindProducerSecretOwner, runWithProducerSecretOwner } from "../../src/secrets/producer-owner";
import { enforceInlineByteCap, OutputSink } from "../../src/session/streaming-output";
import { wrapToolWithMetaNotice } from "../../src/tools/core/output-meta";
import { saveOutputArtifact } from "../../src/tools/core/output-artifact";
import type { ToolSession } from "../../src/tools/index";
import { makeToolSession } from "../helpers/tool-session";

const SECRET = "SYNTHETIC_PRODUCER_CANARY_7f91d2";
const obfuscator = new SecretObfuscator([{ type: "plain", origin: "config", content: SECRET }]);

let directory: string;

afterEach(() => {
	if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

function textOf(value: unknown): string {
	return JSON.stringify(value);
}

describe("a tool result keeps its producing secret owner", () => {
	it("redacts content, details, progress, and real artifact bytes under the captured owner", async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "producer-retention-"));
		const artifactPath = path.join(directory, "full-output.txt");
		const originalOutputPath = path.join(directory, "minimized-original.txt");
		const owner = { redact: (text: string) => obfuscator.obfuscate(text) };
		const session = makeToolSession({
			captureProducerSecretOwner: () => owner,
			allocateOutputArtifact: async (toolType: string) => ({
				id: `synthetic-${toolType}`,
				path: toolType === "producer-minimized-original" ? originalOutputPath : artifactPath,
			}),
		} satisfies Partial<ToolSession>);
		const progress: unknown[] = [];
		const tool = wrapToolWithMetaNotice({
			name: "producer-probe",
			description: "synthetic producer test",
			parameters: {},
			execute: async (_id: string, _args: unknown, _signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback | undefined) => {
				onUpdate?.({ content: [{ type: "text", text: `progress ${SECRET}` }], details: { note: SECRET } });
				const artifactId = await saveOutputArtifact(session, "producer-probe", `artifact ${SECRET}`);
				const original = `raw ${SECRET}\n${"ordinary output ".repeat(64)}`;
				const minimized = await enforceInlineByteCap(original, {
					maxBytes: 24,
					saveArtifact: full => saveOutputArtifact(session, "producer-minimized-original", full),
				});
				return {
					content: [{ type: "text", text: `result ${SECRET}` }],
					details: { note: SECRET, artifactId, minimized },
				};
			},
		} as unknown as AgentTool, session);

		const result = await tool.execute("synthetic-call", {}, undefined, update => progress.push(update));
		const artifact = fs.readFileSync(artifactPath, "utf8");
		for (const sink of [textOf(result.content), textOf(result.details), textOf(progress), artifact]) {
			expect(sink).not.toContain(SECRET);
			expect(sink).toContain("#");
		}
		expect(artifact).toBe(obfuscator.obfuscate(`artifact ${SECRET}`));
		const originalArtifact = fs.readFileSync(originalOutputPath, "utf8");
		expect(originalArtifact).toBe(obfuscator.obfuscate(`raw ${SECRET}\n${"ordinary output ".repeat(64)}`));
	});
	it("redacts split output before live callbacks, inline retention, and artifact writes", async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "producer-sink-"));
		const owner = { redact: (text: string) => obfuscator.obfuscate(text) };
		const stdoutPath = path.join(directory, "stdout.txt");
		const stderrPath = path.join(directory, "stderr.txt");
		const previews: string[] = [];
		const stdout = await runWithProducerSecretOwner(owner, () =>
			new OutputSink({
				artifactPath: stdoutPath,
				artifactId: "synthetic-stdout",
				spillThreshold: 1,
				onChunk: chunk => previews.push(chunk),
			}),
		);
		const stderr = await runWithProducerSecretOwner(owner, () =>
			new OutputSink({ artifactPath: stderrPath, artifactId: "synthetic-stderr", spillThreshold: 1 }),
		);
		await runWithProducerSecretOwner(owner, async () => {
			const midpoint = Math.floor(SECRET.length / 2);
			stdout.push(`stdout ${SECRET.slice(0, midpoint)}`);
			stdout.push(`${SECRET.slice(midpoint)}\n`);
			stderr.push(`stderr ${SECRET.slice(0, midpoint)}`);
			stderr.push(`${SECRET.slice(midpoint)}\n`);
			const stdoutSummary = await stdout.dump();
			const stderrSummary = await stderr.dump();
			const stdoutArtifact = fs.readFileSync(stdoutPath, "utf8");
			const stderrArtifact = fs.readFileSync(stderrPath, "utf8");
			for (const sink of [stdoutSummary.output, stderrSummary.output, previews.join(""), stdoutArtifact, stderrArtifact]) {
				expect(sink).not.toContain(SECRET);
			}
			expect(stdoutArtifact).toContain(obfuscator.obfuscate(SECRET));
			expect(stderrArtifact).toContain(obfuscator.obfuscate(SECRET));
		});
	});

	it("keeps concurrent producer owners isolated across completion and retry", async () => {
		const firstSecret = "SYNTHETIC_PRODUCER_ALPHA_8d319f";
		const secondSecret = "SYNTHETIC_PRODUCER_BRAVO_4a720c";
		const firstObfuscator = new SecretObfuscator([{ type: "plain", origin: "config", content: firstSecret }]);
		const secondObfuscator = new SecretObfuscator([{ type: "plain", origin: "config", content: secondSecret }]);
		const session = (secretOwner: { redact(text: string): string }) =>
			makeToolSession({ captureProducerSecretOwner: () => secretOwner });
		const gate = Promise.withResolvers<void>();
		const firstTool = wrapToolWithMetaNotice({
			name: "producer-a",
			description: "synthetic producer test",
			parameters: {},
			execute: async () => {
				await gate.promise;
				return { content: [{ type: "text", text: firstSecret }], details: { value: firstSecret } };
			},
		} as unknown as AgentTool, session({ redact: text => firstObfuscator.obfuscate(text) }));
		const secondTool = wrapToolWithMetaNotice({
			name: "producer-b",
			description: "synthetic producer test",
			parameters: {},
			execute: async () => ({ content: [{ type: "text", text: secondSecret }], details: { value: secondSecret } }),
		} as unknown as AgentTool, session({ redact: text => secondObfuscator.obfuscate(text) }));

		const firstPending = firstTool.execute("a", {});
		const secondResult = await secondTool.execute("b", {});
		gate.resolve();
		const firstResult = await firstPending;
		const retryResult = await firstTool.execute("a-retry", {});
		const firstSinks = [textOf(firstResult), textOf(retryResult)];
		const secondSink = textOf(secondResult);
		for (const sink of firstSinks) {
			expect(sink).not.toContain(firstSecret);
			expect(sink).toContain(firstObfuscator.obfuscate(firstSecret));
			expect(sink).not.toContain(secondSecret);
		}
		expect(secondSink).not.toContain(secondSecret);
		expect(secondSink).toContain(secondObfuscator.obfuscate(secondSecret));
		expect(secondSink).not.toContain(firstSecret);
	});
	it("redacts thrown errors without replacing the error or cancellation identity", async () => {
		const error = Object.assign(new Error(`cancelled ${SECRET}`, { cause: new Error(`cause ${SECRET}`) }), {
			name: "AbortError",
			details: { credential: SECRET },
		});
		const tool = wrapToolWithMetaNotice({
			name: "producer-error",
			description: "synthetic producer test",
			parameters: {},
			execute: async () => {
				throw error;
			},
		} as unknown as AgentTool, {
			captureProducerSecretOwner: () => ({ redact: (text: string) => obfuscator.obfuscate(text) }),
		} as unknown as ToolSession);

		let caught: unknown;
		try {
			await tool.execute("synthetic-abort", {});
		} catch (value) {
			caught = value;
		}
		expect(caught).toBe(error);
		expect(error.name).toBe("AbortError");
		expect(error.message).not.toContain(SECRET);
		expect(error.stack).not.toContain(SECRET);
		expect((error.cause as Error).message).not.toContain(SECRET);
		expect(JSON.stringify(error.details)).not.toContain(SECRET);
	});
	it("prefers the owner bound to final execution arguments over the session fallback", async () => {
		const firstSecret = "SYNTHETIC_BOUND_OWNER_ALPHA_8091";
		const secondSecret = "SYNTHETIC_BOUND_OWNER_BRAVO_6402";
		const firstObfuscator = new SecretObfuscator([{ type: "plain", origin: "config", content: firstSecret }]);
		const secondObfuscator = new SecretObfuscator([{ type: "plain", origin: "config", content: secondSecret }]);
		const tool = wrapToolWithMetaNotice({
			name: "bound-owner",
			description: "synthetic producer test",
			parameters: {},
			execute: async (_id: string, args: { value: string; other: string }) => ({
				content: [{ type: "text", text: `${args.value} ${args.other}` }],
				details: { value: args.value, other: args.other },
			}),
		} as unknown as AgentTool, makeToolSession({
			captureProducerSecretOwner: () => ({ redact: text => secondObfuscator.obfuscate(text) }),
		}));
		const args = bindProducerSecretOwner({ value: firstSecret, other: secondSecret }, {
			redact: text => firstObfuscator.obfuscate(text),
		});

		const result = await tool.execute("bound-owner-call", args);
		const serialized = textOf(result);
		expect(serialized).not.toContain(firstSecret);
		expect(serialized).toContain(firstObfuscator.obfuscate(firstSecret));
		expect(serialized).toContain(secondSecret);
		expect(serialized).not.toContain(secondObfuscator.obfuscate(secondSecret));
	});
});
