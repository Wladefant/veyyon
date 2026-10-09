/**
 * Which argument is which, for each of the two ways to author a tool.
 *
 * Why this suite exists: the agent calls every tool as
 * `execute(toolCallId, params, signal, onUpdate, context)`. An EXTENSION tool
 * (`pi.registerTool`, `ToolDefinition.execute`) is handed those arguments
 * straight through, in that order. A CUSTOM tool (a file under `tools/`,
 * `CustomTool.execute`) is handed `(toolCallId, params, onUpdate, context,
 * signal)` — the last three in a different order, translated by
 * `CustomToolAdapter`.
 *
 * Two adjacent authoring APIs, same five arguments, two orders. Copying one into
 * the other place produces no type error worth noticing at the call site and no
 * runtime error at all: the arguments still arrive, so `ctx` is a function and
 * `signal` is an object, and the failure surfaces as a confusing
 * `ctx.sessionManager is undefined` later.
 * `packages/coding-agent/examples/extensions/api-demo.ts` shipped exactly that
 * mistake, with fourteen type errors nothing was running.
 *
 * These tests pin each order through the real adapter, so flipping either one
 * fails here rather than in a user's tool.
 */
import { describe, expect, it } from "bun:test";
import type { AgentToolUpdateCallback } from "@veyyon/agent-core";
import { CustomToolAdapter } from "@veyyon/coding-agent/extensibility/custom-tools/wrapper";
import {
	ExtensionToolWrapper,
	RegisteredToolAdapter,
	wrapRegisteredTool,
} from "@veyyon/coding-agent/extensibility/extensions/wrapper";
import { Type } from "@veyyon/kernel/registry/typebox";

/** What a tool's `execute` saw, recorded by position rather than by name. */
interface Observed {
	first: unknown;
	second: unknown;
	third: unknown;
	fourth: unknown;
	fifth: unknown;
}

const PARAMETERS = Type.Object({ input: Type.String() });
const OK = { content: [{ type: "text" as const, text: "ok" }] };

/** A recognizable context object, so "which argument is the context" is decidable. */
const CONTEXT_MARKER = { marker: "the-context" };

function recorder(): { observed: Observed | undefined; execute: (...args: unknown[]) => Promise<typeof OK> } {
	const box: { observed: Observed | undefined } = { observed: undefined };
	return {
		get observed() {
			return box.observed;
		},
		execute: async (...args: unknown[]) => {
			box.observed = { first: args[0], second: args[1], third: args[2], fourth: args[3], fifth: args[4] };
			return OK;
		},
	};
}

describe("extension tools (pi.registerTool)", () => {
	/**
	 * THE contract for the extension side: signal third, onUpdate fourth, context
	 * fifth — the same order the agent itself uses, passed through unchanged.
	 */
	it("receives (toolCallId, params, signal, onUpdate, context)", async () => {
		const tool = recorder();
		const signal = new AbortController().signal;
		const onUpdate: AgentToolUpdateCallback<unknown> = () => {};
		const wrapper = new RegisteredToolAdapter(
			{
				definition: {
					name: "recorder",
					label: "Recorder",
					description: "records its arguments",
					parameters: PARAMETERS,
					execute: tool.execute as never,
				},
			} as never,
			{ createContext: () => CONTEXT_MARKER } as never,
		);

		await wrapper.execute("call-1", { input: "x" }, signal, onUpdate);

		expect(tool.observed).toEqual({
			first: "call-1",
			second: { input: "x" },
			third: signal,
			fourth: onUpdate,
			fifth: CONTEXT_MARKER,
		});
	});

	/** The context comes from the runner on every call, not from the agent's
	 *  `context` argument, which the wrapper deliberately ignores. */
	it("takes the context from the runner, not from the caller", async () => {
		const tool = recorder();
		const wrapper = new RegisteredToolAdapter(
			{
				definition: {
					name: "recorder",
					label: "Recorder",
					description: "records its arguments",
					parameters: PARAMETERS,
					execute: tool.execute as never,
				},
			} as never,
			{ createContext: () => CONTEXT_MARKER } as never,
		);

		await wrapper.execute("call-2", { input: "x" }, undefined, undefined, { marker: "from-caller" } as never);

		expect(tool.observed?.fifth).toBe(CONTEXT_MARKER);
	});

	/**
	 * An extension tool's interruptible predicate survives the adapter so the
	 * agent loop can abort long-running waits for queued steering messages.
	 */
	it("forwards interruptible predicate surviving adapter for waiting and non-waiting arguments", () => {
		const QUESTION_PARAMETERS = Type.Object({
			action: Type.String(),
			wait: Type.Optional(Type.Boolean()),
		});
		const predicate = (args: { action?: string; wait?: boolean }) => args?.wait === true;
		const registeredTool = {
			definition: {
				name: "telegram_question",
				label: "Telegram Question",
				description: "ask or wait for a question",
				parameters: QUESTION_PARAMETERS,
				interruptible: predicate,
				execute: async () => OK,
			},
			extensionPath: "test-extension.ts",
		};

		const adapter = new RegisteredToolAdapter(
			registeredTool as never,
			{ createContext: () => CONTEXT_MARKER } as never,
		);
		const wrapped = wrapRegisteredTool(registeredTool as never, { createContext: () => CONTEXT_MARKER } as never);
		const sessionWrapped = new ExtensionToolWrapper(adapter);

		// Predicate survives adapter unchanged
		expect(adapter.interruptible).toBe(predicate);
		expect(wrapped.interruptible).toBe(predicate);
		expect(sessionWrapped.interruptible).toBe(predicate);
		expect(typeof adapter.interruptible).toBe("function");
		expect(typeof wrapped.interruptible).toBe("function");
		expect(typeof sessionWrapped.interruptible).toBe("function");

		// Resolves correctly for waiting arguments
		expect((adapter.interruptible as (args: unknown) => boolean)({ action: "wait", wait: true })).toBe(true);
		expect((wrapped.interruptible as (args: unknown) => boolean)({ action: "wait", wait: true })).toBe(true);
		expect((sessionWrapped.interruptible as (args: unknown) => boolean)({ action: "wait", wait: true })).toBe(true);

		// Resolves correctly for non-waiting arguments
		expect((adapter.interruptible as (args: unknown) => boolean)({ action: "get", wait: false })).toBe(false);
		expect((wrapped.interruptible as (args: unknown) => boolean)({ action: "get", wait: false })).toBe(false);
		expect((sessionWrapped.interruptible as (args: unknown) => boolean)({ action: "get", wait: false })).toBe(false);
		expect((adapter.interruptible as (args: unknown) => boolean)({ action: "get" })).toBe(false);
		expect((wrapped.interruptible as (args: unknown) => boolean)({ action: "get" })).toBe(false);
		expect((sessionWrapped.interruptible as (args: unknown) => boolean)({ action: "get" })).toBe(false);
	});

	it("preserves boolean and absent interruptible declarations through adapter", () => {
		const boolTool = {
			definition: {
				name: "always_interruptible",
				label: "Always Interruptible",
				description: "interruptible tool",
				parameters: PARAMETERS,
				interruptible: true,
				execute: async () => OK,
			},
			extensionPath: "test-extension.ts",
		};
		const plainTool = {
			definition: {
				name: "plain_tool",
				label: "Plain Tool",
				description: "plain tool",
				parameters: PARAMETERS,
				execute: async () => OK,
			},
			extensionPath: "test-extension.ts",
		};

		const boolAdapter = new RegisteredToolAdapter(
			boolTool as never,
			{ createContext: () => CONTEXT_MARKER } as never,
		);
		const plainAdapter = new RegisteredToolAdapter(
			plainTool as never,
			{ createContext: () => CONTEXT_MARKER } as never,
		);

		const boolWrapped = new ExtensionToolWrapper(boolAdapter);
		const plainWrapped = new ExtensionToolWrapper(plainAdapter);

		expect(boolAdapter.interruptible).toBe(true);
		expect(boolWrapped.interruptible).toBe(true);
		expect(plainAdapter.interruptible).toBeUndefined();
		expect(plainWrapped.interruptible).toBeUndefined();
	});
});

describe("custom tools (a file under tools/)", () => {
	/**
	 * THE contract for the custom-tool side, and the reason the two must be pinned
	 * separately: onUpdate third, context fourth, signal LAST.
	 */
	it("receives (toolCallId, params, onUpdate, context, signal)", async () => {
		const tool = recorder();
		const signal = new AbortController().signal;
		const onUpdate: AgentToolUpdateCallback<unknown> = () => {};
		const adapter = new CustomToolAdapter(
			{
				name: "recorder",
				label: "Recorder",
				description: "records its arguments",
				parameters: PARAMETERS,
				execute: tool.execute as never,
			} as never,
			() => CONTEXT_MARKER as never,
		);

		await adapter.execute("call-3", { input: "x" }, signal, onUpdate);

		expect(tool.observed).toEqual({
			first: "call-3",
			second: { input: "x" },
			third: onUpdate,
			fourth: CONTEXT_MARKER,
			fifth: signal,
		});
	});

	/**
	 * Unlike the extension wrapper, a custom tool CAN be given a context by the
	 * caller, and the adapter's own `getContext` is the fallback. Both directions
	 * are asserted, because a wrapper that ignored the passed context would still
	 * pass the test above.
	 */
	it("prefers a caller-supplied context over its own", async () => {
		const tool = recorder();
		const fromCaller = { marker: "from-caller" };
		const adapter = new CustomToolAdapter(
			{
				name: "recorder",
				label: "Recorder",
				description: "records its arguments",
				parameters: PARAMETERS,
				execute: tool.execute as never,
			} as never,
			() => CONTEXT_MARKER as never,
		);

		await adapter.execute("call-4", { input: "x" }, undefined, undefined, fromCaller as never);

		expect(tool.observed?.fourth).toBe(fromCaller);
	});

	/** With no context from either side the tool still gets the adapter's, never
	 *  `undefined`: a custom tool's `ctx.sessionManager` is not optional. */
	it("falls back to its own context when the caller passes none", async () => {
		const tool = recorder();
		const adapter = new CustomToolAdapter(
			{
				name: "recorder",
				label: "Recorder",
				description: "records its arguments",
				parameters: PARAMETERS,
				execute: tool.execute as never,
			} as never,
			() => CONTEXT_MARKER as never,
		);

		await adapter.execute("call-5", { input: "x" });

		expect(tool.observed?.fourth).toBe(CONTEXT_MARKER);
	});
});

describe("the two orders differ", () => {
	/**
	 * The statement of the trap itself, as one assertion: given the SAME agent-side
	 * call, the two authoring APIs see different things in positions three through
	 * five. If a future change unifies them, this test fails and is the place to
	 * record that the divergence is gone — it is not a test to loosen while the two
	 * orders still differ.
	 */
	it("puts the signal third for an extension tool and last for a custom tool", async () => {
		const signal = new AbortController().signal;
		const onUpdate: AgentToolUpdateCallback<unknown> = () => {};
		const definition = {
			name: "recorder",
			label: "Recorder",
			description: "records its arguments",
			parameters: PARAMETERS,
		};

		const extensionTool = recorder();
		await new RegisteredToolAdapter(
			{ definition: { ...definition, execute: extensionTool.execute as never } } as never,
			{ createContext: () => CONTEXT_MARKER } as never,
		).execute("call-6", { input: "x" }, signal, onUpdate);

		const customTool = recorder();
		await new CustomToolAdapter(
			{ ...definition, execute: customTool.execute as never } as never,
			() => CONTEXT_MARKER as never,
		).execute("call-6", { input: "x" }, signal, onUpdate);

		expect({ extension: extensionTool.observed?.third, custom: customTool.observed?.third }).toEqual({
			extension: signal,
			custom: onUpdate,
		});
		expect({ extension: extensionTool.observed?.fifth, custom: customTool.observed?.fifth }).toEqual({
			extension: CONTEXT_MARKER,
			custom: signal,
		});
	});
});
