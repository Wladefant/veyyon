import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@veyyon/utils/dirs";
import { isMissingPath } from "@veyyon/utils/fs-error";

type ListedEntry = { name: string; kind: "d" | "f" | "o" };
type DirectoryRow = { stamp: string; entries: ListedEntry[] };
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 100_000;

/** Cache directory names, never transcript contents or authority to read another root. */
export class HistoryDirectoryIndex {
	readonly #rows = new Map<string, DirectoryRow>();
	readonly #visited = new Map<string, DirectoryRow>();
	readonly #roots: string[];
	readonly #cachePath: string;
	readonly #signal?: AbortSignal;

	constructor(roots: readonly string[], signal?: AbortSignal) {
		this.#roots = [...new Set(roots.map(root => path.resolve(root)))].sort();
		const key = createHash("sha256").update(JSON.stringify(this.#roots)).digest("hex");
		this.#cachePath = path.join(getAgentDir(), "cache", "history-directories", `${key}.json`);
		this.#signal = signal;
	}

	async load(): Promise<void> {
		this.#signal?.throwIfAborted();
		try {
			const stat = await fs.stat(this.#cachePath);
			if (stat.size > MAX_CACHE_BYTES) return;
			const data: unknown = JSON.parse(
				await fs.readFile(this.#cachePath, { encoding: "utf8", signal: this.#signal }),
			);
			if (
				!data ||
				typeof data !== "object" ||
				!("version" in data) ||
				data.version !== 1 ||
				!("rows" in data) ||
				!Array.isArray(data.rows)
			)
				return;
			let count = 0;
			for (const item of data.rows) {
				this.#signal?.throwIfAborted();
				if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string")
					throw new Error("Invalid history directory index");
				const [dir, row] = item;
				const inside = this.#roots.some(root => {
					const relative = path.relative(root, dir);
					return (
						relative === "" ||
						(!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
					);
				});
				if (!inside || !row || typeof row.stamp !== "string" || !Array.isArray(row.entries))
					throw new Error("Invalid history directory index");
				count += row.entries.length + 1;
				if (count > MAX_CACHE_ENTRIES) throw new Error("History directory index is too large");
				for (const entry of row.entries) {
					if (
						!entry ||
						typeof entry.name !== "string" ||
						!entry.name ||
						entry.name === "." ||
						entry.name === ".." ||
						/[/\\\0]/.test(entry.name) ||
						!["d", "f", "o"].includes(entry.kind)
					)
						throw new Error("Invalid history directory entry");
				}
				this.#rows.set(dir, row);
			}
		} catch {
			this.#signal?.throwIfAborted();
			this.#rows.clear();
		}
	}

	async entries(dir: string): Promise<ListedEntry[]> {
		this.#signal?.throwIfAborted();
		try {
			const before = await fs.lstat(dir);
			if (!before.isDirectory()) return [];
			const stamp = `${before.dev}:${before.ino}:${before.mtimeMs}:${before.ctimeMs}`;
			const cached = this.#rows.get(dir);
			if (cached?.stamp === stamp) {
				this.#visited.set(dir, cached);
				return cached.entries;
			}
			const entries = (await fs.readdir(dir, { withFileTypes: true })).map(entry => ({
				name: entry.name,
				kind: entry.isDirectory() ? ("d" as const) : entry.isFile() ? ("f" as const) : ("o" as const),
			}));
			this.#signal?.throwIfAborted();
			const after = await fs.lstat(dir);
			if (stamp === `${after.dev}:${after.ino}:${after.mtimeMs}:${after.ctimeMs}`)
				this.#visited.set(dir, { stamp, entries });
			return entries;
		} catch (error) {
			this.#signal?.throwIfAborted();
			if (isMissingPath(error)) return [];
			throw error;
		}
	}

	async save(): Promise<void> {
		this.#signal?.throwIfAborted();
		let count = 0;
		for (const row of this.#visited.values()) count += row.entries.length + 1;
		if (count > MAX_CACHE_ENTRIES) return;
		const content = JSON.stringify({ version: 1, rows: [...this.#visited] });
		if (Buffer.byteLength(content, "utf8") > MAX_CACHE_BYTES) return;
		const temporary = `${this.#cachePath}.${randomUUID()}.tmp`;
		try {
			await fs.mkdir(path.dirname(this.#cachePath), { recursive: true });
			await fs.writeFile(temporary, content, { signal: this.#signal });
			this.#signal?.throwIfAborted();
			await fs.rename(temporary, this.#cachePath);
		} catch {
			// A cache is optional; an unwritable cache never hides a readable transcript.
			this.#signal?.throwIfAborted();
		} finally {
			await fs.unlink(temporary).catch(() => undefined);
		}
	}
}
