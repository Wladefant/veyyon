import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { dynamicImportSpecifiersIn, moduleSpecifiersIn } from "../src/module-reach";
import { MEMBER_ROOTS, MEMBERS, memberRelative, REPO_ROOT } from "./support/package-sources";

/**
 * Every workspace package a package imports at runtime is a package it declares.
 *
 * WHY THIS SUITE EXISTS. Resolution inside this repo works because the workspace flattens every
 * package into one `node_modules`, so an import of `@veyyon/coding-agent` from a package whose
 * manifest never mentions it resolves anyway. Nothing reports it. The manifests then describe a
 * graph that is not the real one, and the difference is only visible where the flattening stops:
 * build ordering, a pruned install, or a checkout of one package on its own. Five such edges had
 * accumulated, all through test and bench files, which are exactly the files nobody reads a
 * manifest for.
 *
 * It lives in `@veyyon/utils` because this package owns `module-reach`, the reader these
 * assertions parse imports with, and because the invariant is about the whole workspace rather
 * than about any one package in it.
 *
 * Type-only imports are deliberately out of scope: they are erased before the code runs, so they
 * cannot fail to resolve at runtime. This gate is about the edges that survive compilation.
 */

const SKIP_DIRS: Record<string, true> = {
	".turbo": true,
	build: true,
	coverage: true,
	dist: true,
	node_modules: true,
	target: true,
};

interface WorkspacePackage {
	name: string;
	dir: string;
	declared: Record<string, string>;
}

function readWorkspacePackages(): WorkspacePackage[] {
	const packages: WorkspacePackage[] = [];
	// Every workspace member, not `packages/` alone: a member elsewhere or at depth could import a
	// workspace package its manifest never mentions and the graph this gate describes would stay wrong.
	for (const member of MEMBERS) {
		const memberDir = path.join(REPO_ROOT, member);
		const manifestPath = path.join(memberDir, "package.json");
		if (!fs.existsSync(manifestPath)) continue;
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
			name?: string;
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
			peerDependencies?: Record<string, string>;
			optionalDependencies?: Record<string, string>;
		};
		if (!manifest.name) continue;
		packages.push({
			name: manifest.name,
			dir: memberDir,
			declared: {
				...manifest.dependencies,
				...manifest.devDependencies,
				...manifest.peerDependencies,
				...manifest.optionalDependencies,
			},
		});
	}
	return packages;
}

/**
 * Every source file in the repository that git would carry, memoized.
 *
 * THE WALK THIS REPLACED read the filesystem, so anything git ignores was parsed as if it were a
 * member's source: a local scratch directory, a vendored checkout, a profile dump, build output
 * under any name `SKIP_DIRS` does not list. A second copy of a package sitting untracked under a
 * member reported every import in it as an undeclared edge, and the gate went red over files that
 * can never reach the graph it describes.
 *
 * The domain is what a contributor could commit: tracked files, plus untracked ones git does not
 * ignore, so a brand-new file carrying a bad import is still caught before it lands.
 * `SKIP_DIRS` still applies, so a committed build artifact is read no more than it was before.
 */
let repoSourceFiles: string[] | undefined;

function allRepoSourceFiles(): string[] {
	if (repoSourceFiles) return repoSourceFiles;
	const listing = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
	});
	const files: string[] = [];
	for (const relative of listing.split("\0")) {
		if (!relative || !/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(relative)) continue;
		if (relative.split("/").some(segment => SKIP_DIRS[segment])) continue;
		files.push(path.join(REPO_ROOT, relative));
	}
	repoSourceFiles = files;
	return files;
}

/** Drop the memo, for a case that changes what is on disk. */
function resetRepoSourceFiles(): void {
	repoSourceFiles = undefined;
}

function sourceFilesUnder(dir: string): string[] {
	const prefix = dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`;
	return allRepoSourceFiles().filter(file => file.startsWith(prefix));
}

/** The workspace package a specifier names, or `undefined` for anything outside the workspace. */
function workspaceTargetOf(specifier: string, names: Record<string, true>): string | undefined {
	const target = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
	return names[target] ? target : undefined;
}

/** Every runtime workspace edge out of one package, as `<target> <file>` lines. */
function runtimeEdgesOf(pkg: WorkspacePackage, names: Record<string, true>): { target: string; file: string }[] {
	const edges: { target: string; file: string }[] = [];
	for (const file of sourceFilesUnder(pkg.dir)) {
		const source = fs.readFileSync(file, "utf8");
		// Nothing here can name a workspace package without naming its scope first, and skipping the
		// parse for the files that do not keeps this a whole-workspace walk rather than a slow gate.
		if (!source.includes("@veyyon/") && !source.includes('"argot') && !source.includes("'argot")) continue;
		for (const specifier of [...moduleSpecifiersIn(source), ...dynamicImportSpecifiersIn(source)]) {
			const target = workspaceTargetOf(specifier, names);
			if (!target || target === pkg.name) continue;
			edges.push({ target, file: memberRelative(file) });
		}
	}
	return edges;
}

const workspacePackages = readWorkspacePackages();
const workspaceNames: Record<string, true> = {};
for (const pkg of workspacePackages) workspaceNames[pkg.name] = true;

describe("workspace manifests describe the graph the code actually has", () => {
	// Non-vacuity, and the root check with it: a walk that missed a root reports no undeclared edge
	// under it, which reads the same as a root with none.
	it("reads a member under every root the workspace declares", () => {
		const roots = new Set(workspacePackages.map(pkg => path.relative(REPO_ROOT, pkg.dir).split(path.sep)[0]));

		expect(workspacePackages.length).toBeGreaterThan(10);
		expect(workspacePackages.map(pkg => pkg.name)).toContain("@veyyon/wire");
		expect([...roots].sort()).toEqual([...MEMBER_ROOTS].sort());
	});

	// Non-vacuity for the listing itself: a `git ls-files` that returned nothing would report no
	// undeclared edge anywhere, which reads exactly like a workspace with none.
	it("lists the source a member actually holds", () => {
		const utilsDir = path.join(REPO_ROOT, "packages", "utils");
		const files = sourceFilesUnder(utilsDir);

		expect(files.length).toBeGreaterThan(100);
		expect(files).toContain(path.join(utilsDir, "src", "loop-watchdog.ts"));
	});

	/**
	 * THE DEFECT: the enumerator read the filesystem, so a directory git ignores was parsed as a
	 * member's source. A scratch copy of another package under a member turned this gate red with
	 * dozens of undeclared edges from files that are not in the repository at all.
	 *
	 * THE CLASS: a repo gate whose domain is "what is on disk" rather than "what is committable".
	 * The probe is written under an ignored path INSIDE a member, which is the shape that broke it,
	 * and it carries an import that would be reported if the file were read.
	 */
	it("reads nothing git ignores, so a scratch copy under a member cannot fail the gate", () => {
		const utilsDir = path.join(REPO_ROOT, "packages", "utils");
		// `.scratch/` is ignored repo-wide, so this is a real ignored path and not a contrived one.
		const scratchDir = path.join(utilsDir, ".scratch", `gate-probe-${process.pid}`);
		const probe = path.join(scratchDir, "undeclared-import.ts");
		try {
			fs.mkdirSync(scratchDir, { recursive: true });
			fs.writeFileSync(probe, 'import { runRootCommand } from "@veyyon/coding-agent";\nrunRootCommand();\n');
			resetRepoSourceFiles();

			expect(sourceFilesUnder(utilsDir)).not.toContain(probe);
			const targets = runtimeEdgesOf(
				workspacePackages.find(pkg => pkg.name === "@veyyon/utils")!,
				workspaceNames,
			).map(edge => edge.target);
			expect(targets).not.toContain("@veyyon/coding-agent");
		} finally {
			fs.rmSync(path.join(utilsDir, ".scratch"), { recursive: true, force: true });
			resetRepoSourceFiles();
		}
	}, 30_000);

	it("declares every workspace package it imports at runtime", () => {
		const undeclared: string[] = [];
		for (const pkg of workspacePackages) {
			for (const edge of runtimeEdgesOf(pkg, workspaceNames)) {
				if (edge.target in pkg.declared) continue;
				undeclared.push(`${pkg.name} imports ${edge.target} at ${edge.file} without declaring it`);
			}
		}
		expect([...new Set(undeclared)].sort()).toEqual([]);
	}, 30_000);

	/**
	 * `@veyyon/natives` is the bottom of the workspace: utils depends on it, and everything else
	 * depends on utils. It declares no workspace dependency at all, and a single import of one
	 * would put the addon inside a cycle with the logger, handlebars and yaml that utils carries.
	 * Its bench had exactly that import.
	 */
	it("keeps the native addon a leaf, importing no other workspace package", () => {
		const natives = workspacePackages.find(pkg => pkg.name === "@veyyon/natives");
		if (!natives) throw new Error("no @veyyon/natives package in the workspace");
		const reached = runtimeEdgesOf(natives, workspaceNames).map(edge => `${edge.target} at ${edge.file}`);
		expect([...new Set(reached)].sort()).toEqual([]);
	});
});
