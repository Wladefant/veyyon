import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isForbiddenDatabaseFile, isForbiddenSecretFile } from "./allowlist";

/** Inspect every existing component, including ancestors above the managed root. */
export async function assertSafePath(root: string, target: string): Promise<void> {
 const resolvedRoot = path.resolve(root);
 const resolved = path.resolve(target);
 const components = resolved.slice(path.parse(resolved).root.length).split(path.sep);
 if (components.some(part => /[:\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error("Unsafe filesystem alias");
 const relative = path.relative(resolvedRoot, resolved);
 if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Path outside managed root");
 if (isForbiddenDatabaseFile(resolved) || isForbiddenSecretFile(resolved)) throw new Error("Forbidden database or credential destination");
 const parts = resolved.slice(path.parse(resolved).root.length).split(path.sep);
 let current = path.parse(resolved).root;
 let missing = false;
 for (const part of parts) {
  current = path.join(current, part);
  if (missing) continue;
  try {
   const stat = await fs.lstat(current);
   if (stat.isSymbolicLink()) throw new Error("Symlink or junction destination refused");
   const canonical = await fs.realpath(current);
   if (path.normalize(canonical).toLowerCase() !== path.normalize(current).toLowerCase()) throw new Error("Reparse or aliased destination refused");
   if (current === resolved && ((!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink > 1))) throw new Error("Non-regular or hard-linked destination refused");
   if (current === resolved && stat.isFile()) {
    const handle = await fs.open(current, "r");
    try {
     const header = Buffer.alloc(16);
     await handle.read(header, 0, 16, 0);
     if (header.toString() === "SQLite format 3\0") throw new Error("Live database content refused");
    } finally { await handle.close(); }
   }
  } catch (error) {
   if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
   missing = true;
  }
 }
}

export interface FileChange { root: string; target: string; content?: string; expectedHash?: string | null; }
interface JournalEntry extends FileChange { stage: string; backup?: string; before?: string; }
interface Journal { entries: JournalEntry[]; }
async function optionalRead(target: string): Promise<Buffer | undefined> {
 try { return await fs.readFile(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function writeDurableExclusive(target: string, bytes: string | Buffer): Promise<void> {
 const handle = await fs.open(target, "wx", 0o600);
 try {
  await handle.writeFile(bytes);
  await handle.sync();
 } finally { await handle.close(); }
}
/** A journal is retained until every replacement, including the baseline, commits. */
export async function recoverTransaction(root: string, allowedRoots: string[] = [root], restoreTargets?: ReadonlySet<string>): Promise<void> {
 const journalPath = path.join(root, ".knowledge-transaction.json");
 await assertSafePath(root, journalPath);
 const raw = await optionalRead(journalPath);
 if (!raw) return;
 const journal = JSON.parse(raw.toString()) as Journal;
 if (!Array.isArray(journal.entries)) throw new Error("Invalid apply recovery journal");
 for (const entry of journal.entries) {
  if (!entry || typeof entry.root !== "string" || typeof entry.target !== "string" || typeof entry.stage !== "string" ||
   !allowedRoots.includes(entry.root) || !entry.stage.startsWith(`${entry.target}.stage-`) ||
   path.dirname(entry.stage) !== path.dirname(entry.target) ||
   (entry.backup !== undefined && (typeof entry.backup !== "string" || !entry.backup.startsWith(`${entry.target}.backup-`) || path.dirname(entry.backup) !== path.dirname(entry.target)))) throw new Error("Unsafe recovery journal");
  await assertSafePath(entry.root, entry.target);
  await assertSafePath(entry.root, entry.stage);
  if (entry.backup) {
   await assertSafePath(entry.root, entry.backup);
   if (!(await optionalRead(entry.backup))) throw new Error("Missing apply recovery backup");
  }
 }
 for (const entry of [...journal.entries].reverse()) {
  if (restoreTargets && !restoreTargets.has(entry.target)) continue;
  await assertSafePath(entry.root, entry.target);
  if (entry.backup) {
   await assertSafePath(entry.root, entry.backup);
   const bytes = await optionalRead(entry.backup);
   if (!bytes) throw new Error("Missing apply recovery backup");
   const restore = `${entry.target}.restore-${randomUUID()}`;
   await fs.writeFile(restore, bytes, { flag: "wx", mode: 0o600 });
   await fs.rename(restore, entry.target);
  } else {
   await fs.rm(entry.target, { force: true });
  }
 }
 await fs.unlink(journalPath);
 for (const entry of journal.entries) {
  await fs.rm(entry.stage, { force: true });
  if (entry.backup) await fs.rm(entry.backup, { force: true });
 }
}

export async function commitTransaction(root: string, changes: FileChange[], options: { rename?: typeof fs.rename } = {}): Promise<void> {
 const journalPath = path.join(root, ".knowledge-transaction.json");
 const entries: JournalEntry[] = [];
 const installedTargets = new Set<string>();
 const seen = new Set<string>();
 for (const change of changes) {
  await assertSafePath(change.root, change.target);
  const key = path.resolve(change.target).toLowerCase();
  if (seen.has(key)) throw new Error("Duplicate transaction destination");
  seen.add(key);
 }
 try {
  for (const change of changes) {
   await fs.mkdir(path.dirname(change.target), { recursive: true });
   await assertSafePath(change.root, change.target);
   const before = await optionalRead(change.target);
   if (change.expectedHash !== undefined && (before === undefined ? null : createHash("sha256").update(before).digest("hex")) !== change.expectedHash) throw new Error("Local edit after comparison");
   const suffix = randomUUID();
   const entry: JournalEntry = { ...change, stage: `${change.target}.stage-${suffix}`, before: before?.toString("base64") };
   if (before !== undefined) {
    entry.backup = `${change.target}.backup-${suffix}`;
    await writeDurableExclusive(entry.backup, before);
   }
   entries.push(entry);
   if (change.content !== undefined) await writeDurableExclusive(entry.stage, change.content);
  }
  await assertSafePath(root, journalPath);
  await writeDurableExclusive(journalPath, JSON.stringify({ entries: entries.map(({ content, before, ...entry }) => entry) }));
  for (const entry of entries) {
   await assertSafePath(entry.root, entry.target);
   const now = await optionalRead(entry.target);
   if (now?.toString("base64") !== entry.before) throw new Error("Local edit during apply");
   if (entry.content === undefined) await fs.rm(entry.target, { force: true });
   else await (options.rename ?? fs.rename)(entry.stage, entry.target);
   installedTargets.add(entry.target);
  }
  await fs.unlink(journalPath);
 } catch (error) {
  if (await optionalRead(journalPath)) await recoverTransaction(root, [...new Set(changes.map(change => change.root))], installedTargets);
  throw error;
 } finally {
  for (const entry of entries) {
   await fs.rm(entry.stage, { force: true });
   if (entry.backup && !(await optionalRead(journalPath))) await fs.rm(entry.backup, { force: true });
  }
 }
}
