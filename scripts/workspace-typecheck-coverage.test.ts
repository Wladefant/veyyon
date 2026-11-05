/**
 * Every workspace package is actually covered by the workspace typecheck.
 *
 * WHY THIS SUITE EXISTS. The root gate is
 * `check:ts` = `bun run --workspaces --if-present check:types`, and `--if-present`
 * means a package with no `check:types` script is skipped in silence. So a
 * package opts out of type checking by omission, and the gate still reports
 * success: the run prints a green line per package that HAS the script and says
 * nothing at all about the ones that do not. Absence reads as coverage.
 *
 * That is not hypothetical. The DeepSWE bench had no `check:types` while it was its
 * own package, and a
 * full `bun run check:ts` listed 17 green workspaces without it. When the script
 * was finally added (2026-07-24) it immediately surfaced two real errors in
 * `run.ts`: three hand-written copies of the blank `ArmResult` had drifted, and
 * the reaggregate error path was dropping `argotHandlesLoaded` and
 * `encodeHeadroom`, the two fields that make a zero-encode bench run
 * interpretable. Those had been shipping unnoticed.
 *
 * This is the same class of defect the codebase bans elsewhere: a mechanism that
 * quietly does nothing when its input is missing, instead of failing loudly.
 * Locking it here means a new package cannot join the tree already exempt from
 * the typecheck.
 *
 * THE MEMBERS ARE DERIVED, NOT NAMED. This suite enumerated `packages/` literally, which reproduced the
 * very defect it exists to prevent as soon as a second root appeared. `contracts/*` is in the
 * workspace glob, so `--if-present` fans out to it, but nothing here required a contract to declare
 * `check:types` at all -- so a contract could opt out of type checking by omission with this suite
 * green. Literal members like `natives/bridge/bindings` and `clients/python/veybot/web` were likewise
 * invisible to root globs. The members now come from `scripts/workspace-layout.ts`.
 */
import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
// `Glob` and `JSONC`: Node 22 has no stable glob matcher (`path.matchesGlob` is experimental) and no
// JSON-with-comments parser, and a tsconfig is JSON with comments.
import { Glob, JSONC } from "bun";

import { runnerSources } from "./runner-references";
import { existingOnly, REPO_ROOT, type WorkspacePackage, workspacePackages } from "./workspace-layout";

describe("the workspace typecheck covers every package", () => {
	/** The suite is only meaningful if it found the packages at all; an empty
	 * listing would make every assertion below vacuously true. */
	it("finds the workspace packages under every declared root", () => {
		const packages = workspacePackages();
		expect(packages.length).toBeGreaterThan(10);
		// A member outside `packages/`. The literal enumeration could not see one, so a contract was
		// free to ship with no `check:types` while this suite reported full coverage.
		expect(packages.map(pkg => pkg.dir)).toContain("contracts/wire");
		expect(packages.map(pkg => pkg.dir)).toContain("contracts/view");
	});

	/**
	 * THE contract. `--if-present` skips a package with no `check:types` and says
	 * nothing, so the only way to know a package is checked is to require the
	 * script exists.
	 */
	it("gives every package a check:types script", () => {
		const missing = workspacePackages()
			.filter(pkg => !pkg.scripts["check:types"])
			.map(pkg => `${pkg.dir} (${pkg.name})`);
		expect(
			missing,
			"these declare no check:types, so `bun run check:ts` skips them with --if-present and " +
				"still reports success; add check:types (tsgo -p tsconfig.json --noEmit) and a tsconfig",
		).toEqual([]);
	});

	/**
	 * A `check:types` that does not invoke the type checker would satisfy the test
	 * above while checking nothing, which is the same silent-skip defect wearing
	 * the script name.
	 */
	it("points every check:types at the type checker", () => {
		const bogus = workspacePackages()
			.filter(pkg => {
				const script = pkg.scripts["check:types"];
				return script !== undefined && !script.includes("tsgo") && !script.includes("tsc");
			})
			.map(pkg => `${pkg.dir}: ${pkg.scripts["check:types"]}`);
		expect(bogus, "these name a check:types script that never runs a type checker").toEqual([]);
	});

	/**
	 * The root gate must keep fanning out to the workspaces. Rewriting `check:ts`
	 * to check one package, or to run nothing, would leave every assertion above
	 * true while the gate stopped covering the tree.
	 */
	it("keeps check:ts fanning out across the workspaces", () => {
		const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
		const checkTs: string = root.scripts["check:ts"];
		expect(checkTs).toContain("--workspaces");
		expect(checkTs).toContain("check:types");
	});
});

/**
 * Declaring check:types does not cover a member. The projects it runs list their roots in
 * `include`, and a file outside every one of them is checked by nothing while `check:ts` passes.
 *
 * What that cost (2026-10-27): the benches under `packages/coding-agent/bench`,
 * `hosts/terminal/engine/bench` and `plugins/hashline/bench` were in no project and held seven type
 * errors against the code they measure; the code-review bench threw before it timed anything.
 * `apps/stats/test`, `plugins/mode-swarm/test`, `natives/bridge/bindings/src` and
 * `clients/python/veybot/web/scripts` were in no project either, and the eval dashboard's project
 * listed its component tests one directory too high, so four `.test.tsx` files matched nothing.
 *
 * Each project's `include`, `files` and `exclude` resolve as tsc resolves them, an unset one is read
 * from the config it `extends`, and a `bun run` in check:types is followed into the member's own
 * scripts. Every tracked TypeScript file of a member must fall in a project its check:types runs.
 * A file a project includes and tsc then skips, such as one under a dot directory reached by a
 * wildcard, reads as covered here.
 */
describe("the projects check:types runs cover every TypeScript file of the member", () => {
	/**
	 * Files no project checks, each with the reason. Exact equality, so a new entry is a decision
	 * written here rather than a file that slipped out of an `include`.
	 */
	const UNCHECKED_BY_DESIGN = [
		// Its own package: it proves jiti resolves an extension's own `node_modules`, so its `ms`
		// import does not resolve from the workspace. `tsconfig.examples.json` excludes it.
		"packages/coding-agent/examples/extensions/with-deps/index.ts",
	];

	it("leaves no tracked TypeScript file outside every project check:types runs", () => {
		const members = workspacePackages().sort((a, b) => b.dir.length - a.dir.length);
		const scopes = new Map(members.map(pkg => [pkg.dir, checkedScopes(pkg)]));
		const unchecked: string[] = [];
		let assigned = 0;
		for (const file of trackedTypeScript()) {
			// The deepest member holding the file owns it, so a member nested in another is judged by its own projects.
			const member = members.find(pkg => file.startsWith(`${pkg.dir}/`));
			if (member === undefined) continue;
			assigned++;
			const inMember = file.slice(member.dir.length + 1);
			if (!(scopes.get(member.dir) ?? []).some(scope => scope.covers(inMember))) unchecked.push(file);
		}
		// The walk found the members' sources at all; an empty listing would pass vacuously.
		expect(assigned).toBeGreaterThan(5000);
		expect(
			unchecked,
			"these tracked files are in no project the member's check:types runs, so no type error in them " +
				"fails `bun run check:ts`; add their directory to the member's tsconfig `include`",
		).toEqual(UNCHECKED_BY_DESIGN);
	});
});

/** Tracked TypeScript sources, relative to the repository root. Declarations are not sources. */
function trackedTypeScript(): string[] {
	const listed = execFileSync("git", ["ls-files", "-z", "--", "*.ts", "*.tsx", "*.mts", "*.cts"], {
		cwd: REPO_ROOT,
		maxBuffer: 64 * 1024 * 1024,
	})
		.toString("utf8")
		.split("\0")
		.filter(file => file !== "" && !/\.d\.[cm]?ts$/.test(file));
	// The index also lists a file an uncommitted deletion removed from the working tree.
	return existingOnly(REPO_ROOT, listed);
}

/** Which member-relative files one tsc project reads. */
interface ProjectScope {
	covers(file: string): boolean;
}

/** The scope of every project the member's check:types runs, following `bun run` into its own scripts. */
function checkedScopes(pkg: WorkspacePackage): ProjectScope[] {
	const memberDir = join(REPO_ROOT, pkg.dir);
	const scopes: ProjectScope[] = [];
	const visited = new Set<string>();
	const visit = (name: string): void => {
		const script = pkg.scripts[name];
		if (script === undefined || visited.has(name)) return;
		visited.add(name);
		for (const command of script.split("&&").map(part => part.trim())) {
			const nested = /^bun run (\S+)$/.exec(command)?.[1];
			if (nested !== undefined) visit(nested);
			else if (/\b(?:tsgo|tsc)\b/.test(command)) {
				const project = /(?:-p|--project)\s+(\S+)/.exec(command)?.[1] ?? "tsconfig.json";
				scopes.push(projectScope(memberDir, resolve(memberDir, project)));
			}
		}
	};
	visit("check:types");
	return scopes;
}

function projectScope(memberDir: string, projectFile: string): ProjectScope {
	let include: Glob[] | undefined;
	let files: Set<string> | undefined;
	let exclude: Glob[] | undefined;
	let configFile: string | undefined = projectFile;
	while (configFile !== undefined) {
		const config = JSONC.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
		const configDir = dirname(configFile);
		const ownInclude = strings(config.include);
		const ownFiles = strings(config.files);
		// tsc reads `include` and `files` together from the nearest config that sets either.
		if (include === undefined && files === undefined && (ownInclude !== undefined || ownFiles !== undefined)) {
			include = (ownInclude ?? []).map(entry => tscPattern(memberDir, configDir, entry));
			files = new Set((ownFiles ?? []).map(entry => memberRelative(memberDir, configDir, entry)));
		}
		const ownExclude = strings(config.exclude);
		if (exclude === undefined && ownExclude !== undefined) {
			exclude = ownExclude.map(entry => tscPattern(memberDir, configDir, entry));
		}
		configFile =
			typeof config.extends === "string" && config.extends.startsWith(".")
				? resolve(configDir, config.extends)
				: undefined;
	}
	// With neither set anywhere, tsc includes everything under the project's own directory.
	const included = include ?? (files === undefined ? [tscPattern(memberDir, dirname(projectFile), ".")] : []);
	const listed = files ?? new Set<string>();
	const excluded = exclude ?? [];
	return {
		covers: file =>
			listed.has(file) || (included.some(glob => glob.match(file)) && !excluded.some(glob => glob.match(file))),
	};
}

function strings(value: unknown): string[] | undefined {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function memberRelative(memberDir: string, configDir: string, entry: string): string {
	return relative(memberDir, resolve(configDir, entry)).replaceAll("\\", "/");
}

/** tsc reads an entry whose last segment has no wildcard and no extension as a directory and all beneath it. */
function tscPattern(memberDir: string, configDir: string, entry: string): Glob {
	const path = memberRelative(memberDir, configDir, entry);
	if (path === "") return new Glob("**/*");
	const last = path.slice(path.lastIndexOf("/") + 1);
	return new Glob(/[*?]/.test(last) || last.includes(".") ? path : `${path}/**/*`);
}

/**
 * `scripts/` is checked too, and it is the blind spot the suite above cannot see.
 *
 * The workspace fan-out covers the declared member globs and nothing else, so every generator,
 * CI driver, and repo-level test under `scripts/` — thousands of lines that
 * import package sources directly — was typechecked by NOTHING. `tsconfig.tools.json`
 * existed and included them, and no command ever ran it.
 *
 * What that cost (2026-07-25): `gen-settings-reference.ts` declared its tab
 * titles as `Record<SettingTab, string>` with three tabs that do not exist and
 * six real ones missing. That is a compile error the moment anything checks it.
 * Unchecked, the lookup returned `undefined` and the shipped settings reference
 * carried six headings reading `## undefined`. Running the check then found five
 * more, including a since-removed port manager fingerprinting a `{name, key}`
 * object as if it were the API key and passing that object as the credential,
 * a lane path that could never have authenticated.
 */
describe("the typecheck covers scripts/ as well as the workspaces", () => {
	const rootScripts = (): Record<string, string> =>
		JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).scripts ?? {};

	/** The root's own check:types is what points at tsconfig.tools.json. */
	it("declares a root check:types that runs the type checker on the tools project", () => {
		const script = rootScripts()["check:types"];
		expect(script, "the root package must declare check:types for scripts/").toBeDefined();
		expect(script).toContain("tsconfig.tools.json");
		expect(script?.includes("tsgo") || script?.includes("tsc")).toBe(true);
	});

	/** Declaring it is not running it: the gate has to invoke it. */
	it("runs it from check:ts, so the gate covers scripts/", () => {
		expect(
			rootScripts()["check:ts"],
			"check:ts must run the root check:types; --workspaces alone never reaches scripts/",
		).toContain("check:types");
		expect(rootScripts()["check:ts"]).toContain("bun run check:types");
	});

	/**
	 * The tools project must stay non-composite. Composite requires every file in
	 * the program to be listed, and these scripts import package sources by
	 * relative path, so composite turns five legitimate imports into TS6307 and the
	 * check becomes unrunnable — which is how it came to be skipped in the first
	 * place.
	 */
	it("keeps the tools project non-composite so the check can actually run", () => {
		const config = readFileSync(join(REPO_ROOT, "tsconfig.tools.json"), "utf8");
		expect(config).not.toContain('"composite": true');
		expect(config).toContain('"noEmit": true');
	});
});

/**
 * Repo-level test suites are only coverage if some runner runs them.
 *
 * `repoScriptTests` in `ci-test-ts.ts` is a hand-maintained list, and drift
 * showed up in both directions. Outward: 13 suites existed on disk that NO
 * runner referenced, including all seven installer-parity checks, so 155
 * passing assertions about the install flow, the product surface the dogfooding
 * doctrine says to judge, never ran in CI. Inward: the file's own comment
 * records a listed `ci-test-ts.test.ts` that never existed, which bun ignores in
 * silence whenever at least one other filter matches.
 *
 * Both directions fail loudly now.
 */
const REPO_SCRIPT_TESTS = (() => {
	const source = readFileSync(join(REPO_ROOT, "scripts/ci-test-ts.ts"), "utf8");
	const block = /const repoScriptTests = \[(.*?)\];/s.exec(source);
	return block ? [...block[1].matchAll(/"([^"]+)"/g)].map(match => match[1] as string) : [];
})();

/** Every place a repo-level suite can legitimately be run from, as one text to
 * search. `runner-references.ts` owns which files those are, so this lock and
 * `script-tests-coverage.test.ts` cannot disagree about whether a workflow
 * exists. */
function otherRunnerSources(): string {
	return runnerSources().join("\n");
}

describe("every repo-level test suite is actually run by something", () => {
	/** Guards the parse above: an empty list would make the checks vacuous. */
	it("parses the repoScriptTests list", () => {
		expect(REPO_SCRIPT_TESTS.length).toBeGreaterThan(10);
	});

	/** Inward drift. bun silently ignores an unmatched filter when another filter
	 * matches, so a listed-but-deleted file looks exactly like a passing suite. */
	it("lists no suite that has been deleted", () => {
		const missing = REPO_SCRIPT_TESTS.filter(rel => {
			try {
				return !statSync(join(REPO_ROOT, rel)).isFile();
			} catch {
				return true;
			}
		});
		expect(missing, "these are listed in repoScriptTests but do not exist; bun ignores them silently").toEqual([]);
	});

	/**
	 * Suites deliberately not wired yet, each with the reason it is not.
	 *
	 * An exception belongs here, in the open, rather than as an absence nobody can
	 * see. That is the whole point of the check: silence was the defect.
	 */
	// Empty, and that is the intended resting state. The one entry that lived here
	// was `scripts/sync-root-changelog.test.ts`, held back while the root sync's
	// scope was an open question: the generator read only
	// `packages/coding-agent/CHANGELOG.md`, so entries recorded in any other
	// package vanished on regeneration. The generator now aggregates every package
	// and cuts inherited history at the fork point, so the suite is wired into
	// `repoScriptTests` like any other.
	const KNOWN_UNRUN = new Map<string, string>([]);

	/** Outward drift. A suite referenced by nothing runs nowhere, and its green
	 * assertions are decoration. */
	it("leaves no scripts/*.test.ts unreferenced by any runner", () => {
		const others = otherRunnerSources();
		const unreferenced = readdirSync(join(REPO_ROOT, "scripts"))
			.filter(name => name.endsWith(".test.ts"))
			.map(name => `scripts/${name}`)
			.filter(rel => !REPO_SCRIPT_TESTS.includes(rel) && !others.includes(rel) && !KNOWN_UNRUN.has(rel));
		expect(
			unreferenced,
			"these suites are run by nothing: not repoScriptTests, not a workflow, not a root script. " +
				"Add each to repoScriptTests or a workflow, or delete it; a suite nobody runs is not coverage",
		).toEqual([]);
	});
});
