/**
 * Token equivalence measurement between a git base reference and the working tree.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type ParseResult, type ParserOptions, parse } from "@babel/parser";
import type { File, Statement } from "@babel/types";
import { sha256 } from "./git-baseline";
import { assertObject, validateLedgerHeader, writeJsonFixture } from "./ledger-schema";

export interface TokenRepresentation {
	readonly type: string;
	readonly value?: string | number | boolean | null;
}

export interface TokenWithRange extends TokenRepresentation {
	readonly start: number;
	readonly end: number;
}

export interface TokenizeResult {
	readonly tokens: readonly TokenWithRange[];
	readonly ast: ParseResult<File>;
}

export const TOKEN_EQUIVALENCE_SCHEMA_VERSION = 2;

export interface TokenEquivalenceLedger {
	readonly schemaVersion: number;
	readonly generatedFrom: string;
	readonly formattingOnly: Readonly<Record<string, string>>;
	readonly importReorder: Readonly<Record<string, string>>;
}

export function validateTokenEquivalenceLedger(raw: unknown, expectedCommit?: string): TokenEquivalenceLedger {
	let commit = expectedCommit;
	if (!commit && raw && typeof raw === "object" && "generatedFrom" in raw && typeof raw.generatedFrom === "string") {
		commit = raw.generatedFrom;
	}
	const ledger = validateLedgerHeader(raw, TOKEN_EQUIVALENCE_SCHEMA_VERSION, commit ?? "", "Token equivalence ledger");
	assertObject(ledger.formattingOnly, "Token equivalence ledger is missing formattingOnly map");
	assertObject(ledger.importReorder, "Token equivalence ledger is missing importReorder map");
	return raw as TokenEquivalenceLedger;
}

export interface MeasureOptions {
	readonly repoRoot?: string;
	readonly baseRef?: string;
	readonly headRef?: string;
	readonly ledgerPath?: string;
}

export const REPO_ROOT = resolve(import.meta.dirname, "..");
export const DEFAULT_LEDGER_PATH = resolve(REPO_ROOT, "scripts/fixtures/token-equivalence.json");

export function tokenize(code: string): TokenizeResult {
	const tokens: TokenWithRange[] = [];
	const parserOptions: ParserOptions = {
		sourceType: "module",
		tokens: true,
		errorRecovery: false,
		plugins: ["typescript", "jsx", "importAttributes"],
	};

	const ast = parse(code, parserOptions);
	const rawTokens = ast.tokens ?? [];

	for (const token of rawTokens) {
		const label =
			typeof token.type === "object" && token.type !== null && "label" in token.type
				? String((token.type as { label: string }).label)
				: String(token.type);

		if (label === "CommentLine" || label === "CommentBlock" || label === "eof") continue;

		tokens.push({
			type: label,
			value: token.value,
			start: token.start,
			end: token.end,
		});
	}

	return { tokens, ast };
}

export function hashTokenStream(tokens: readonly TokenRepresentation[]): string {
	const stream = tokens.map(t => `${t.type}:${t.value === undefined ? "" : JSON.stringify(t.value)}`).join(",");
	return sha256(stream);
}

export function normalizeImportTokens(
	ast: ParseResult<File>,
	tokens: readonly TokenWithRange[],
): TokenRepresentation[] {
	const importBlocks: Array<{
		readonly node: Statement;
		readonly tokens: readonly TokenRepresentation[];
		readonly key: string;
	}> = [];
	const body = ast.program.body;

	for (const node of body) {
		if (node.type === "ImportDeclaration") {
			const nodeTokens = tokens.filter(t => t.start >= (node.start ?? 0) && t.end <= (node.end ?? 0));
			const simplified = nodeTokens.map(t => ({ type: t.type, value: t.value }));
			importBlocks.push({
				node,
				tokens: simplified,
				key: JSON.stringify(simplified),
			});
		}
	}

	const sortedImports = [...importBlocks].sort((a, b) => a.key.localeCompare(b.key));
	const normalizedTokens: TokenRepresentation[] = [];
	let importIndex = 0;

	for (const node of body) {
		if (node.type === "ImportDeclaration") {
			const block = sortedImports[importIndex];
			if (block) normalizedTokens.push(...block.tokens);
			importIndex++;
		} else {
			const nodeTokens = tokens.filter(t => t.start >= (node.start ?? 0) && t.end <= (node.end ?? 0));
			normalizedTokens.push(...nodeTokens.map(t => ({ type: t.type, value: t.value })));
		}
	}

	return normalizedTokens;
}

export function hashNormalizedImportTokens(ast: ParseResult<File>, tokens: readonly TokenWithRange[]): string {
	return hashTokenStream(normalizeImportTokens(ast, tokens));
}

export function areTokenStreamsEqual(t1: readonly TokenRepresentation[], t2: readonly TokenRepresentation[]): boolean {
	if (t1.length !== t2.length) return false;
	for (let i = 0; i < t1.length; i++) {
		if (t1[i]!.type !== t2[i]!.type || t1[i]!.value !== t2[i]!.value) return false;
	}
	return true;
}

export function checkImportReorder(
	ast1: ParseResult<File>,
	tokens1: readonly TokenWithRange[],
	ast2: ParseResult<File>,
	tokens2: readonly TokenWithRange[],
): boolean {
	const nonImport1: TokenRepresentation[] = [];
	const importStmts1: string[] = [];
	const nonImport2: TokenRepresentation[] = [];
	const importStmts2: string[] = [];

	for (const node of ast1.program.body) {
		const nodeTokens = tokens1.filter(t => t.start >= (node.start ?? 0) && t.end <= (node.end ?? 0));
		const tokenSeq = nodeTokens.map(t => ({ type: t.type, value: t.value }));
		if (node.type === "ImportDeclaration") importStmts1.push(JSON.stringify(tokenSeq));
		else nonImport1.push(...tokenSeq);
	}

	for (const node of ast2.program.body) {
		const nodeTokens = tokens2.filter(t => t.start >= (node.start ?? 0) && t.end <= (node.end ?? 0));
		const tokenSeq = nodeTokens.map(t => ({ type: t.type, value: t.value }));
		if (node.type === "ImportDeclaration") importStmts2.push(JSON.stringify(tokenSeq));
		else nonImport2.push(...tokenSeq);
	}

	if (importStmts1.length === 0 || importStmts2.length === 0 || importStmts1.length !== importStmts2.length) {
		return false;
	}
	if (!areTokenStreamsEqual(nonImport1, nonImport2)) return false;

	const s1 = [...importStmts1].sort();
	const s2 = [...importStmts2].sort();
	for (let i = 0; i < s1.length; i++) {
		if (s1[i] !== s2[i]) return false;
	}

	return true;
}

export async function measureTokenEquivalence(options: MeasureOptions = {}): Promise<TokenEquivalenceLedger> {
	const repoRoot = options.repoRoot ?? REPO_ROOT;
	const baseRef = options.baseRef ?? "origin/main";
	const headRef = options.headRef;

	const baseSha = execFileSync("git", ["rev-parse", baseRef], {
		cwd: repoRoot,
		encoding: "utf-8",
	}).trim();

	const diffArgs = ["diff", "--name-status", "--diff-filter=M", baseSha];
	if (headRef && headRef !== "HEAD") diffArgs.push(headRef);
	const diffOutput = execFileSync("git", diffArgs, { cwd: repoRoot, encoding: "utf-8" });

	const candidatePaths = diffOutput
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean)
		.map(line => line.split("\t")[1])
		.filter(
			(p): p is string =>
				Boolean(p) && (p.endsWith(".ts") || p.endsWith(".tsx") || p.endsWith(".js") || p.endsWith(".jsx")),
		)
		.filter(p => !p.startsWith(".captures/"));

	const formattingOnly: Record<string, string> = {};
	const importReorder: Record<string, string> = {};

	for (const relPath of candidatePaths) {
		let baseCode: string;
		try {
			baseCode = execFileSync("git", ["show", `${baseSha}:${relPath}`], { cwd: repoRoot, encoding: "utf-8" });
		} catch {
			continue;
		}

		let headCode: string;
		if (headRef && headRef !== "HEAD") {
			try {
				headCode = execFileSync("git", ["show", `${headRef}:${relPath}`], { cwd: repoRoot, encoding: "utf-8" });
			} catch {
				continue;
			}
		} else {
			const fullPath = resolve(repoRoot, relPath);
			if (!existsSync(fullPath)) continue;
			headCode = readFileSync(fullPath, "utf-8");
		}

		let baseResult: TokenizeResult;
		let headResult: TokenizeResult;
		try {
			baseResult = tokenize(baseCode);
			headResult = tokenize(headCode);
		} catch {
			continue;
		}

		if (areTokenStreamsEqual(baseResult.tokens, headResult.tokens)) {
			formattingOnly[relPath] = hashTokenStream(baseResult.tokens);
		} else if (checkImportReorder(baseResult.ast, baseResult.tokens, headResult.ast, headResult.tokens)) {
			importReorder[relPath] = hashNormalizedImportTokens(baseResult.ast, baseResult.tokens);
		}
	}

	return {
		schemaVersion: TOKEN_EQUIVALENCE_SCHEMA_VERSION,
		generatedFrom: baseSha,
		formattingOnly,
		importReorder,
	};
}

export async function generateLedger(options: MeasureOptions = {}): Promise<TokenEquivalenceLedger> {
	const ledger = await measureTokenEquivalence(options);
	const targetPath = options.ledgerPath ?? DEFAULT_LEDGER_PATH;
	writeJsonFixture(targetPath, ledger);
	return ledger;
}

if (import.meta.main) {
	const ledger = await generateLedger({ baseRef: process.argv[2], headRef: process.argv[3] });
	process.stdout.write(
		`wrote the token ledger against ${ledger.generatedFrom}: ${Object.keys(ledger.formattingOnly).length} formatting-only, ${Object.keys(ledger.importReorder).length} import-reorder\n`,
	);
}
