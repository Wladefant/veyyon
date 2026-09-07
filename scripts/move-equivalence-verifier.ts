/**
 * Shared move-equivalence verification engine for dynamic baseline verification.
 *
 * WHY THIS MODULE EXISTS.
 * PR #927 moves 1563+ files (4804 move pairs). Verification must guarantee that every moved
 * file either preserved its content byte-for-byte (modulo path rewrites), changed only in
 * imports/comments, or matches an approved deviation with exact cryptographic fingerprints.
 *
 * A single unified verifier executes both the full repository corpus verification and
 * test-level mutation controls, eliminating divergence between test assertion loops and
 * simulation controls.
 *
 * BINARY CLASSIFICATION & UTF-8 SAFETY:
 * Standard UTF-8 string decoding (`buf.toString("utf-8")`) replaces invalid byte sequences
 * with U+FFFD (replacement character). Differing binary buffers with different invalid byte
 * sequences would decode to identical strings, causing a false-positive text equivalence.
 * Bytes-based binary classification (checking NUL bytes and strict UTF-8 decoding validity
 * alongside declared binary extensions via `isBinaryFile`) ensures any binary content or
 * corrupted bytes are compared strictly by raw bytes (`Buffer.equals()`).
 */

import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./git-baseline";
import {
	classifyMovePairContent,
	isBinaryFile,
	type MoveEquivalenceLedger,
	normalizeWithRewrites,
	sha256,
	structuralHash,
} from "./measure-move-equivalence";

/**
 * Optional filesystem abstraction boundary for testing and mutation simulation.
 */
export interface FileReaderBoundary {
	readonly readBuffer?: (relativePath: string) => Buffer;
	readonly exists?: (relativePath: string) => boolean;
}

export interface VerifyMovedFilesCounts {
	readonly total: number;
	readonly none: number;
	readonly importsAndCommentsOnly: number;
	readonly changed: number;
}

export interface VerifyMovedFilesResult {
	readonly counts: VerifyMovedFilesCounts;
	readonly unapproved: readonly string[];
	readonly drifted: readonly string[];
}

/**
 * Verifies all moved file pairs against the Git baseline blobs and approved sparse ledger.
 *
 * For each pair [oldPath, newPath]:
 * 1. Verifies target file exists on disk and reads disk buffer once.
 * 2. Reads required baseline blob from blobMap (for both approved and unapproved entries).
 * 3. If approved in ledger: verifies old path matches pair, and checks disk sha256 & structural hashes.
 * 4. If unapproved: if binary (by extension, NUL byte, or invalid UTF-8 in either buffer),
 *    asserts raw byte equality (`diskBuf.equals(baselineBuf)`). If text, normalizes rewrites and
 *    checks full text equality (bucket `none`) or structural lines equality (bucket `importsAndCommentsOnly`).
 *    Any other difference is reported in `unapproved`.
 */
export function verifyMovedFiles(
	ledger: MoveEquivalenceLedger,
	pairs: readonly (readonly [string, string])[],
	blobMap: ReadonlyMap<string, Buffer | null>,
	fileReader?: FileReaderBoundary,
	repoRoot: string = REPO_ROOT,
): VerifyMovedFilesResult {
	const rewrites = ledger.rewrites;

	const exists = fileReader?.exists ?? ((rel: string) => fs.existsSync(path.resolve(repoRoot, rel)));
	const readBuf = fileReader?.readBuffer ?? ((rel: string) => fs.readFileSync(path.resolve(repoRoot, rel)));

	let noneCount = 0;
	let importCount = 0;
	let changedCount = 0;
	const unapproved: string[] = [];
	const drifted: string[] = [];

	for (const [oldPath, newPath] of pairs) {
		if (!exists(newPath)) {
			unapproved.push(`${newPath}: missing on disk`);
			continue;
		}

		const diskBuf = readBuf(newPath);

		const spec = `${ledger.generatedFrom}:${oldPath}`;
		const baselineBuf = blobMap.get(spec);
		if (!baselineBuf) {
			unapproved.push(`${newPath}: baseline blob missing for ${oldPath}`);
			continue;
		}

		const approved = ledger.changed[newPath];

		if (approved !== undefined) {
			changedCount++;
			if (approved.old !== oldPath) {
				unapproved.push(`${newPath}: approved old path "${approved.old}" does not match rename pair "${oldPath}"`);
				continue;
			}

			const isBinary = approved.kind === "binary" || isBinaryFile(newPath, baselineBuf, diskBuf);

			if (isBinary) {
				const diskHash = sha256(diskBuf);
				if (diskHash !== approved.hash) {
					drifted.push(`${newPath}: approved binary hash drifted (expected ${approved.hash}, got ${diskHash})`);
				}
			} else {
				const diskNormalized = normalizeWithRewrites(diskBuf.toString("utf-8"), rewrites);
				const diskHash = sha256(diskNormalized);
				const diskStruct = structuralHash(diskNormalized, newPath);
				if (diskHash !== approved.hash || diskStruct !== approved.structuralHash) {
					drifted.push(`${newPath}: approved changed fingerprint drifted`);
				}
			}
			continue;
		}

		const classification = classifyMovePairContent(oldPath, newPath, baselineBuf, diskBuf, rewrites);

		if (classification.category === "none") {
			noneCount++;
		} else if (classification.category === "importsAndCommentsOnly") {
			importCount++;
		} else if (classification.isBinary) {
			unapproved.push(`${newPath}: binary mismatch against baseline ${oldPath}`);
		} else {
			unapproved.push(`${newPath}: unexpected deviation from baseline ${oldPath}`);
		}
	}

	const counts: VerifyMovedFilesCounts = {
		total: pairs.length,
		none: noneCount,
		importsAndCommentsOnly: importCount,
		changed: changedCount,
	};

	return {
		counts,
		unapproved,
		drifted,
	};
}
