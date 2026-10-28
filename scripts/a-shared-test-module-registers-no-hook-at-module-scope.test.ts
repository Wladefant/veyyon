/**
 * A module that test files import registers no `bun:test` hook, suite or test at module scope.
 *
 * WHY. Bun evaluates a module once per process. A module-scope `afterEach` in a shared helper runs while
 * the first test file that imports the helper is loading, so it binds to that file alone, and every later
 * file in the same `bun test` process imports the cached module and gets no hook. CI runs several files
 * per process, so the cleanup ran for one file in each chunk: `helpers/tool-execution.ts` stopped the
 * spinner and rail intervals of the first suite that built a tool block and leaked them for the rest.
 * A leaked interval that fires under a later suite's fake clock moves onto that clock, which turned a
 * timer-count assertion in an unrelated suite red at random.
 *
 * CLASS. Any `describe`, `test`, `it` or lifecycle hook called outside a function body in a module that
 * Bun does not load as its own test file. Per-test cleanup from a shared module goes through
 * `onTestFinished` inside the function that builds the resource, or through an exported function each
 * file calls in its own scope.
 *
 * ALLOWED. A preload is loaded once for the whole process and its hooks are global, which is the
 * intent; a fixture spawned as its own `bun test` entry is a test file in all but name. Both are pinned
 * by exact equality, so a new one turns this suite red until it is recorded here.
 *
 * GAP. A registration reached through a function the module calls at its own top level (`setup()`
 * defined and invoked in the helper) is not traced, and neither is a re-export of a registrar under a
 * computed name.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type CallExpression, Node, Project, type SourceFile } from "ts-morph";
import { listTrackedFiles } from "./git-baseline";
import { typeScriptMemberTopLevels } from "./workspace-layout";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

/** Every `bun:test` export that registers something with the file being loaded. */
const REGISTRARS = new Set(["describe", "test", "it", "beforeAll", "beforeEach", "afterAll", "afterEach"]);

/** The file names Bun discovers as test entries. */
const TEST_ENTRY = /(\.test|_test|\.spec|_spec)\.(ts|tsx)$/;

/** Modules allowed a module-scope registration, each a preload or a spawned `bun test` entry. */
const ALLOWED = [
	"packages/ai/test/helpers/provider-override-tripwire.ts",
	"packages/utils/test/fixtures/leaky-suite.fixture.ts",
	"packages/utils/test/fixtures/profile-leak.fixture.ts",
	"packages/utils/test/fixtures/restoring-in-afterall.fixture.ts",
	"packages/utils/test/helpers/global-state-leak-preload.ts",
	"packages/utils/test/helpers/rss-after-each-file.ts",
];

interface Registration {
	readonly name: string;
	readonly line: number;
}

/** The registrar a call resolves to through this file's `bun:test` imports, or `undefined`. */
function registrarOf(call: CallExpression, named: ReadonlyMap<string, string>, namespaces: ReadonlySet<string>) {
	let callee = call.getExpression();
	// `it.each(rows)(name, fn)` and `describe.skip(name, fn)` register through the registrar they start from.
	for (;;) {
		if (Node.isCallExpression(callee)) {
			callee = callee.getExpression();
			continue;
		}
		if (Node.isPropertyAccessExpression(callee)) {
			const target = callee.getExpression();
			if (Node.isIdentifier(target) && namespaces.has(target.getText())) {
				const name = callee.getName();
				return REGISTRARS.has(name) ? name : undefined;
			}
			callee = target;
			continue;
		}
		break;
	}
	return Node.isIdentifier(callee) ? named.get(callee.getText()) : undefined;
}

function isInsideFunction(node: Node): boolean {
	return node
		.getAncestors()
		.some(
			ancestor =>
				Node.isFunctionDeclaration(ancestor) ||
				Node.isFunctionExpression(ancestor) ||
				Node.isArrowFunction(ancestor) ||
				Node.isMethodDeclaration(ancestor) ||
				Node.isConstructorDeclaration(ancestor) ||
				Node.isGetAccessorDeclaration(ancestor) ||
				Node.isSetAccessorDeclaration(ancestor) ||
				Node.isClassStaticBlockDeclaration(ancestor),
		);
}

/** Registrations a module makes while it is being evaluated. */
function moduleScopeRegistrations(source: SourceFile): Registration[] {
	const named = new Map<string, string>();
	const namespaces = new Set<string>();
	for (const declaration of source.getImportDeclarations()) {
		if (declaration.getModuleSpecifierValue() !== "bun:test") continue;
		const namespace = declaration.getNamespaceImport();
		if (namespace) namespaces.add(namespace.getText());
		for (const specifier of declaration.getNamedImports()) {
			if (specifier.isTypeOnly()) continue;
			const imported = specifier.getName();
			if (REGISTRARS.has(imported)) named.set(specifier.getAliasNode()?.getText() ?? imported, imported);
		}
	}
	if (named.size === 0 && namespaces.size === 0) return [];

	const found: Registration[] = [];
	source.forEachDescendant(node => {
		if (!Node.isCallExpression(node)) return;
		// An inner call of a chain (`it.each(rows)` in `it.each(rows)(name, fn)`) is reported by the outer one.
		const parent = node.getParent();
		if (Node.isCallExpression(parent) && parent.getExpression() === node) return;
		const name = registrarOf(node, named, namespaces);
		if (name && !isInsideFunction(node)) found.push({ name, line: node.getStartLineNumber() });
	});
	return found;
}

function parse(project: Project, fileName: string, text: string): SourceFile {
	return project.createSourceFile(fileName, text, { overwrite: true });
}

describe("a module test files import registers nothing at module scope", () => {
	describe("the detector", () => {
		const project = new Project({ useInMemoryFileSystem: true });
		const scan = (text: string) => moduleScopeRegistrations(parse(project, "probe.ts", text)).map(r => r.name);

		it("finds a hook, a suite and a test called at the top of the module", () => {
			expect(
				scan(`import { afterEach, describe, test } from "bun:test";
afterEach(() => {});
describe("d", () => {});
test("t", () => {});`),
			).toEqual(["afterEach", "describe", "test"]);
		});

		it("finds a registrar imported under another name or through a namespace", () => {
			expect(
				scan(`import { afterEach as cleanup } from "bun:test";
import * as bt from "bun:test";
cleanup(() => {});
bt.beforeEach(() => {});`),
			).toEqual(["afterEach", "beforeEach"]);
		});

		it("finds a registration inside a top-level block or condition, which still runs at load", () => {
			expect(
				scan(`import { afterAll, beforeAll } from "bun:test";
if (process.env.X) afterAll(() => {});
{ beforeAll(() => {}); }`),
			).toEqual(["afterAll", "beforeAll"]);
		});

		it("finds a chained registration once", () => {
			expect(
				scan(`import { describe, it } from "bun:test";
it.each([1, 2])("n %d", () => {});
describe.skip("d", () => {});`),
			).toEqual(["it", "describe"]);
		});

		it("passes a registration made inside a function, which runs in its caller's scope", () => {
			expect(
				scan(`import { afterEach, onTestFinished } from "bun:test";
export function useCleanup() { afterEach(() => {}); }
export const build = () => { onTestFinished(() => {}); };
class Harness { constructor() { afterEach(() => {}); } }`),
			).toEqual([]);
		});

		it("passes a same-named function that does not come from bun:test", () => {
			expect(scan(`import { afterEach } from "./local";\nafterEach(() => {});`)).toEqual([]);
		});
	});

	it("holds for every module that is not a Bun test entry", () => {
		const roots = Array.from(new Set([...typeScriptMemberTopLevels(), "scripts"])).sort();
		const files = listTrackedFiles(REPO_ROOT, roots).filter(
			file => /\.(ts|tsx)$/.test(file) && !file.endsWith(".d.ts") && !TEST_ENTRY.test(file),
		);
		const project = new Project({ useInMemoryFileSystem: true });
		const offenders: string[] = [];
		const scanned: string[] = [];
		for (const file of files) {
			const text = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
			if (!text.includes("bun:test")) continue;
			scanned.push(file);
			if (moduleScopeRegistrations(parse(project, file, text)).length > 0) offenders.push(file);
		}

		// The sweep reached the shared helper it exists for, not an empty or misrooted file list.
		expect(scanned).toContain("packages/coding-agent/test/helpers/tool-execution.ts");
		expect(offenders.sort()).toEqual(ALLOWED);
	}, 60_000);
});
