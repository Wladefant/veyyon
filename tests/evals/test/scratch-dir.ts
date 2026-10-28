import * as fs from "node:fs";
import * as path from "node:path";
import { internalScratchDir } from "../engine/package-paths";

/** A fresh directory named `<prefix>XXXXXX` under the repository's `.internal`; the caller removes it. */
export function createScratchDir(prefix: string): string {
	const base = internalScratchDir();
	fs.mkdirSync(base, { recursive: true });
	return fs.mkdtempSync(path.join(base, prefix));
}
