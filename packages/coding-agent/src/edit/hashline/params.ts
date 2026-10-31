/**
 * Arktype schema for the `edit` tool's hashline mode payload. The schema is
 * deliberately permissive (allows extra keys) so providers can attach extra
 * keys without rejection; only `input` is required.
 */

import { type } from "@veyyon/ai/utils/schema/arktype";
import { toolSchema } from "@veyyon/ai/utils/schema/tool-schema";

export const hashlineEditParamsSchema = toolSchema("edit:hashline", () =>
	type({
		input: "string",
	}),
);

export type HashlineParams = typeof hashlineEditParamsSchema.value.infer;
