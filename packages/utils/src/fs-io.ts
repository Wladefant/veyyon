/**
 * Reads and writes of a file another process may hold a lease on.
 *
 * Bun opens a file with `O_NONBLOCK` for `Bun.file().text()`, `.bytes()`, `.json()`, `.arrayBuffer()`,
 * `.slice()` reads and for `Bun.write`. An open of a file under a conflicting lease fails with `EAGAIN` at once
 * instead of waiting for the lease to break. The kernel NFS server holds a lease on every file it has delegated
 * to a client: a read lease while a client reads the file and a write lease while a client writes it. On an
 * exported tree a Bun read therefore fails while another machine writes the file, and a Bun write fails while
 * another machine reads it, both with "EAGAIN: resource temporarily unavailable, open '<path>'".
 *
 * `node:fs` opens without `O_NONBLOCK`, so the open waits until the holder releases the lease (the NFS server
 * recalls the delegation) or `/proc/sys/fs/lease-break-time` elapses. Read and write a file the user works on
 * through these, through `node:fs`, or through `atomicWriteFile`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** The file decoded as UTF-8 the way `Bun.file().text()` decodes it: a leading BOM dropped, invalid bytes replaced. */
export async function readFileText(filePath: string): Promise<string> {
	// Decoding inside `readFile` skips the intermediate Buffer a `TextDecoder` pass needs: 4 MiB reads in
	// half the time, level with `Bun.file().text()`. That decode keeps a BOM, so drop it here.
	const text = await fs.readFile(filePath, "utf8");
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** The bytes from `start` up to `end` (exclusive); fewer when the file ends first. */
export async function readFileRange(filePath: string, start: number, end: number): Promise<Uint8Array> {
	const length = end - start;
	const handle = await fs.open(filePath, "r");
	try {
		const buffer = new Uint8Array(length);
		let filled = 0;
		while (filled < length) {
			const { bytesRead } = await handle.read(buffer, filled, length - filled, start + filled);
			if (bytesRead === 0) break;
			filled += bytesRead;
		}
		return filled === length ? buffer : buffer.subarray(0, filled);
	} finally {
		await handle.close();
	}
}

/** Write `data` to `filePath`, creating its parent directories as `Bun.write` does. */
export async function writeFileCreatingParents(filePath: string, data: string | Uint8Array): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, data);
}
