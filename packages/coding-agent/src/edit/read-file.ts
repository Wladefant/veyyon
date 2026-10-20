/**
 * Shared file-read helper for edit-mode utilities.
 *
 * Reads a file through `node:fs`, which waits out a lease another process holds on it, and rethrows ENOENT
 * as a user-facing "File not found" error referencing the display path.
 */
import * as fs from "node:fs/promises";
import { hasUtf8Bom } from "@veyyon/hashline";
import { isEnoent } from "@veyyon/utils";
import { readFileText } from "@veyyon/utils/fs-io";
import { isNotebookPath, readEditableNotebookText, serializeEditedNotebookText } from "./notebook";

export async function readEditFileText(absolutePath: string, path: string): Promise<string> {
	try {
		if (isNotebookPath(absolutePath)) return await readEditableNotebookText(absolutePath, path);
		return await readFileText(absolutePath);
	} catch (error) {
		if (isEnoent(error)) {
			throw new Error(`File not found: ${path}`);
		}
		throw error;
	}
}

/**
 * Read an editable file, separating any leading UTF-8 BOM from the content.
 *
 * `readEditFileText` decodes through a text reader (`readFileText`), which
 * silently drops a leading UTF-8 BOM, so a plain `stripBom` on its result never
 * sees the BOM and an edit would rewrite the file without it. This reads the raw
 * bytes, detects the BOM there, and returns the BOM plus BOM-free content so an
 * edit can restore it on write-back — the same recovery the hashline patcher and
 * apply-patch mode already do, factored into one place. Notebooks carry no
 * editable-text BOM and are read as before.
 */
export async function readEditFileTextWithBom(
	absolutePath: string,
	path: string,
): Promise<{ bom: string; content: string }> {
	if (isNotebookPath(absolutePath)) {
		return { bom: "", content: await readEditFileText(absolutePath, path) };
	}
	try {
		const bytes = await fs.readFile(absolutePath);
		// TextDecoder (default) consumes a leading BOM, matching readFileText;
		// hasUtf8Bom sniffs the raw bytes so the dropped BOM is recovered.
		return { bom: hasUtf8Bom(bytes) ? "﻿" : "", content: new TextDecoder("utf-8").decode(bytes) };
	} catch (error) {
		if (isEnoent(error)) {
			throw new Error(`File not found: ${path}`);
		}
		throw error;
	}
}

export async function serializeEditFileText(absolutePath: string, path: string, content: string): Promise<string> {
	if (isNotebookPath(absolutePath)) return serializeEditedNotebookText(absolutePath, path, content);
	return content;
}
