/**
 * Contract: building the provider-bound tool list does not import the agent loop.
 *
 * WHAT MOVED. `normalizeTools` (intent injection, description pruning, example rendering) and
 * `extractIntent` sat inside `agent-loop.ts`. `append-only-context.ts` builds its stable prefix from
 * `normalizeTools` and nothing else in the loop, yet the import loaded the whole loop: the streaming
 * engine, instrumentation, the Harmony leak recovery and the tool batch machinery. Measured before the
 * split: `append-only-context.ts` reached 294 modules, the same set as `agent-loop.ts` itself. After:
 * 221, and `tool-normalization.ts` alone reaches 220.
 *
 * WHAT THIS CATCHES. A value import from `./agent-loop` returning to either module, directly or through
 * a new helper that imports the loop.
 *
 * NOT CAUGHT. Growth that stays under the ceiling and avoids the named modules, such as a new import of
 * an unrelated `@veyyon/ai` subsystem.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { packageModuleReach } from "@veyyon/utils/module-reach-workspace";

const SRC = path.join(import.meta.dir, "..", "src");
const REPO_ROOT = path.join(SRC, "..", "..", "..");

const { reachedNames } = packageModuleReach(REPO_ROOT, SRC);

/** Measured at 221 for `append-only-context.ts` and 220 for `tool-normalization.ts`; the loop is 294. */
const WIRE_TOOL_LIST_CEILING = 240;

/** Modules only the loop needs. Each is one `./agent-loop` import away from both subjects. */
const LOOP_ONLY = [
	"packages/agent/src/agent-loop.ts",
	"packages/ai/src/stream.ts",
	"packages/ai/src/instrumentation.ts",
	"packages/ai/src/utils/harmony-leak.ts",
];

describe.each(["tool-normalization.ts", "append-only-context.ts"])("%s", subject => {
	it(`reaches at most ${WIRE_TOOL_LIST_CEILING} modules`, () => {
		expect(reachedNames(subject).length).toBeLessThanOrEqual(WIRE_TOOL_LIST_CEILING);
	});

	it("reaches none of the modules only the loop needs", () => {
		const reached = new Set(reachedNames(subject));
		expect(LOOP_ONLY.filter(name => reached.has(name))).toEqual([]);
	});
});
