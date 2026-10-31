/**
 * WHY. A compiled build stores the bundled model each custom model id resolved to, and a later launch
 * of that build reads the answer instead of indexing the catalog's model ids. An answer is correct only
 * for the build that computed it: another build embeds another catalog and other lookup rules, so its
 * answer can name a model this build does not hold, or miss one it does.
 *
 * THE CLASS. `resolveBundledModelReference` through the per-build store, each in a fresh process the
 * way a launch reaches it: a later launch of the same build serves every stored answer, a hit and a
 * miss alike, without reading the catalog's ids; answers stored by another build, and stored values of
 * the wrong shape, are recomputed; a launch with no build id (a run from source) writes nothing.
 *
 * WHAT IT DOES NOT CATCH. The store's file handling shared with the tool wire-schema store (another
 * store version, an unreadable file, two processes merging entries); that is
 * `a-stored-tool-wire-schema-is-read-only-by-the-build-that-stored-it.test.ts` in `packages/ai`. Nor
 * whether a computed answer is right; that is `bundled-reference-index.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HIT = "claude-3-5-sonnet-20241022";
const MISS = "completely-unknown-custom-model-id";
const QUERIES = [HIT, MISS];

type Answer = readonly [provider: string, id: string] | null;

interface Launch {
	/** The store file the launch resolved. */
	file: string;
	/** What each query resolved to, as `[provider, id]`, or null for none. */
	answers: Record<string, Answer>;
	/** How many times the launch read the catalog's model ids. */
	keyReads: number;
}

const LAUNCH = `
	import { spyOn } from "bun:test";
	import { getModelReferenceCachePath } from "@veyyon/utils/dirs";
	import * as models from "./src/models";
	import { resolveBundledModelReference } from "./src/identity/bundled";

	const keyReads = spyOn(models, "readBundledModelKeys");
	const answers = {};
	for (const query of ${JSON.stringify(QUERIES)}) {
		const model = resolveBundledModelReference(query);
		answers[query] = model ? [model.provider, model.id] : null;
	}
	// The store writes once the task that put an entry ends.
	await new Promise(resolve => setTimeout(resolve, 0));
	process.stdout.write(JSON.stringify({ file: getModelReferenceCachePath(), answers, keyReads: keyReads.mock.calls.length }));
`;

let home = "";
let file = "";

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "model-references-"));
	file = "";
});

afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
});

/** Run one launch of build `build` (none when undefined) against the scratch home. */
function launch(build: string | undefined): Launch {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined || /^(VEYYON|OMP|PI|XDG)_/.test(key)) continue;
		env[key] = value;
	}
	env.HOME = home;
	if (build !== undefined) env.VEYYON_BUILD_ID = build;
	const stdout = child_process.execFileSync(process.execPath, ["-e", LAUNCH], {
		cwd: path.resolve(import.meta.dirname, ".."),
		encoding: "utf8",
		env,
		timeout: 30_000,
	});
	const result = JSON.parse(stdout) as Launch;
	expect(result.file.startsWith(home + path.sep)).toBe(true);
	file = result.file;
	return result;
}

/** The answers a fresh index computes for {@link QUERIES}. */
const COMPUTED: Record<string, Answer> = { [HIT]: ["anthropic", HIT], [MISS]: null };

function seed(body: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(body));
}

function stored(): unknown {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

describe("a stored model reference", () => {
	it("is read by a later launch of the same build without reading the catalog's ids", () => {
		const first = launch("build-a");
		expect(first.answers).toEqual(COMPUTED);
		expect(first.keyReads).toBeGreaterThan(0);
		expect(stored()).toEqual({ version: 1, build: "build-a", entries: COMPUTED });

		const later = launch("build-a");
		expect(later.answers).toEqual(COMPUTED);
		expect(later.keyReads).toBe(0);
	});

	it("serves the stored answer, not one computed again, for a hit and a miss alike", () => {
		launch("build-a");
		// Answers this build would never compute, so serving them proves they came from the store.
		seed({ version: 1, build: "build-a", entries: { [HIT]: null, [MISS]: ["anthropic", HIT] } });

		const later = launch("build-a");
		expect(later.answers).toEqual({ [HIT]: null, [MISS]: ["anthropic", HIT] });
		expect(later.keyReads).toBe(0);
	});

	it("stored by another build is recomputed and replaced", () => {
		launch("build-a");
		seed({ version: 1, build: "build-b", entries: { [HIT]: null, [MISS]: ["anthropic", HIT] } });

		const later = launch("build-a");
		expect(later.answers).toEqual(COMPUTED);
		expect(later.keyReads).toBeGreaterThan(0);
		expect(stored()).toEqual({ version: 1, build: "build-a", entries: COMPUTED });
	});

	const malformed: Record<string, unknown> = {
		"a provider with no id": ["anthropic"],
		"a provider and id that are not strings": ["anthropic", 5],
		"a bare id": HIT,
		"an object": { provider: "anthropic", id: HIT },
	};
	for (const [name, value] of Object.entries(malformed)) {
		it(`of the wrong shape (${name}) is recomputed`, () => {
			launch("build-a");
			seed({ version: 1, build: "build-a", entries: { [HIT]: value, [MISS]: ["anthropic", HIT] } });

			const later = launch("build-a");
			expect(later.answers[HIT]).toEqual(["anthropic", HIT]);
			// The well-formed entry beside it is still served.
			expect(later.answers[MISS]).toEqual(["anthropic", HIT]);
		});
	}

	it("is neither read nor written by a launch with no build id", () => {
		launch("build-a");
		const body = { version: 1, build: "build-a", entries: { [HIT]: null, [MISS]: ["anthropic", HIT] } };
		seed(body);

		const source = launch(undefined);
		expect(source.answers).toEqual(COMPUTED);
		expect(source.keyReads).toBeGreaterThan(0);
		expect(stored()).toEqual(body);
	});
});
