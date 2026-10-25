import type * as fs from "node:fs";

/** How a refusal describes an entry that is not a regular file, e.g. "a named pipe (FIFO)". */
export function nonRegularKind(stats: fs.Stats): string {
	if (stats.isDirectory()) return "a directory";
	if (stats.isSymbolicLink()) return "a symbolic link";
	if (stats.isFIFO()) return "a named pipe (FIFO)";
	if (stats.isSocket()) return "a socket";
	if (stats.isBlockDevice() || stats.isCharacterDevice()) return "a device node";
	return "not a regular file";
}
