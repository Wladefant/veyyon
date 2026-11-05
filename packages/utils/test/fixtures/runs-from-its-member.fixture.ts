// A suite the leak tracer runs to prove where it starts a traced file: the directory of the
// workspace member that holds it, where the suite runner starts it and where Bun reads that
// member's bunfig.toml. Named outside the `*.test.ts` glob so no ordinary run collects it.
import { expect, it } from "bun:test";
import * as path from "node:path";

it("runs from the workspace member that holds it", () => {
	expect(process.cwd()).toBe(path.resolve(import.meta.dirname, "..", ".."));
});
