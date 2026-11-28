import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFile } from "@veyyon/utils/atomic-write";
import { withFileLock } from "@veyyon/utils/file-lock";
import { isEnoent } from "@veyyon/utils/fs-error";

const maxBytes = 64 * 1024 * 1024;
const maxFiles = 256;
const retentionMs = 7 * 24 * 60 * 60 * 1000;
const dumpName = /^\d+-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/;
// atomicWriteFile stages .<basename>.<pid>.<counter>.tmp in the same directory.
const stageName = /^\.(.+)\.\d+\.\d+\.tmp$/;

/** Persist one whole dump or report why it did not fit. The legacy dumps are never scanned. */
export async function saveRejectedRequestDump(logsDir: string, payload: unknown): Promise<string> {
	const data = `${JSON.stringify(payload, null, 2)}\n`;
	const size = Buffer.byteLength(data);
	const legacy = path.join(logsDir, "http-400-requests");
	await fs.mkdir(legacy, { recursive: true, mode: 0o700 });
	if (!(await fs.lstat(legacy)).isDirectory()) throw new Error("Unsafe HTTP request dump directory");
	const dir = path.join(legacy, "retained-v1");
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	if (!(await fs.lstat(dir)).isDirectory()) throw new Error("Unsafe HTTP request retention directory");
	const canonicalDir = await fs.realpath(dir);

	// All processes using this profile share the same admission budget.
	return withFileLock(path.join(canonicalDir, "retention"), async () => {
		const now = Date.now();
		let bytes = 0;
		let count = 0;
		for (const entry of await fs.readdir(canonicalDir, { withFileTypes: true })) {
			if (!entry.isFile()) continue;
			const stage = stageName.exec(entry.name);
			if (!dumpName.test(stage?.[1] ?? entry.name)) continue;
			const file = path.join(canonicalDir, entry.name);
			const stat = await fs.lstat(file).catch(error => {
				if (!isEnoent(error)) throw error;
				return undefined;
			});
			if (!stat?.isFile()) continue;
			// An in-progress stage cannot exist while we hold the writer lock.
			if (stat.nlink === 1 && (stage || now - stat.mtimeMs >= retentionMs)) {
				try {
					await fs.unlink(file);
					continue;
				} catch (error) {
					if (isEnoent(error)) continue;
					// For example, a Windows reader can deny deletion. Charge the bytes until they are gone.
				}
			}
			bytes += stat.size;
			count++;
		}
		if (count >= maxFiles || bytes + size > maxBytes) {
			throw new Error("HTTP request dump limit reached (256 files or 64 MiB; recent dumps kept for 7 days)");
		}
		const name = `${now}-${crypto.randomUUID()}.json`;
		await atomicWriteFile(path.join(canonicalDir, name), data, { requireAtomicReplace: true });
		return path.join(dir, name);
	});
}
