/**
 * A closed nested object rejects undeclared null placeholders. Open native
 * fixtures retain their existing behavior: Zod strips the extra during parse,
 * and the ArkType pipeline omits the placeholder before validation.
 *
 * ArkType's default permits nested extras even when the emitted wire schema is
 * closed. Runtime rejection depends on the input schema, not the wire schema.
 *
 * Not covered: the root object, where an undeclared key is kept on purpose so the caller can
 * reject a hallucinated field (tool-argument-coercion.test.ts covers that), and an undeclared key
 * with any other value.
 */
import { describe, expect, it } from "bun:test";
import type { Tool, ToolCall } from "@veyyon/ai/types";
import { validateToolArguments } from "@veyyon/ai/utils/validation";
import { type } from "arktype";
import { z } from "zod/v4";

const PARAMETERS: Record<string, Tool["parameters"]> = {
	"JSON Schema": {
		type: "object",
		properties: {
			opts: {
				type: "object",
				properties: { inner: { type: "string" } },
				required: ["inner"],
				additionalProperties: false,
			},
		},
		required: ["opts"],
	} as unknown as Tool["parameters"],
	Zod: z.object({ opts: z.object({ inner: z.string() }) }),
	"strict Zod": z.object({ opts: z.object({ inner: z.string() }).strict() }),
	ArkType: type({ opts: type({ inner: "string" }) }),
	"closed ArkType": type({ "+": "reject", opts: type({ "+": "reject", inner: "string" }) }),
};

const PLACEHOLDERS: readonly unknown[] = [null, "null"];

for (const [style, parameters] of Object.entries(PARAMETERS)) {
	const strict = style !== "Zod" && style !== "ArkType";
	describe(`a nested null placeholder under ${style} parameters`, () => {
		const tool: Tool = { name: "nested", description: "", parameters };
		for (const placeholder of PLACEHOLDERS) {
			it(`${strict ? "rejects" : "strips"} an undeclared ${JSON.stringify(placeholder)} placeholder`, () => {
				const args = { opts: { inner: "v", junk: placeholder } };
				const toolCall: ToolCall = { type: "toolCall", id: "c", name: "nested", arguments: args };
				if (strict) expect(() => validateToolArguments(tool, toolCall)).toThrow(/junk/);
				else expect(validateToolArguments(tool, toolCall)).toEqual({ opts: { inner: "v" } });
				expect(args).toEqual({ opts: { inner: "v", junk: placeholder } });
			});
		}
	});
}
