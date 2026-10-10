import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getConfigRootDir } from "@veyyon/utils";
import type { TerminalOwner } from "./terminal-control";

/**
 * Durable notices between Veyyon sessions on one machine.
 *
 * The terminal pipe in `terminal-control.ts` reaches the main agent of one live terminal and
 * nothing else: it drops with the owner's socket and never reaches that session's lanes. A notice is
 * a file, so it outlives a dropped socket, a restart or a session that is busy.
 *
 * Layout under `<root>/run/notices/<sessionId>/`:
 * - `<id>.json`            pending, written atomically by the sender
 * - `claimed/<id>.json`    taken by the recipient, not yet in its turn
 * - `delivered/<id>.json`  in the recipient's turn; the sender reads this as the receipt
 *
 * Delivery is at least once. The recipient claims a notice (a rename, so two readers cannot both win),
 * puts it into its turn, then acknowledges it. A claim that is never acknowledged comes back after
 * {@link CLAIM_STALE_MS}; the recipient drops a repeat by id.
 */

export interface SessionNotice {
	version: 1;
	id: string;
	/** Session id of the sender, or a free label when the sender has no session. */
	from: string;
	/** Session id of the recipient. */
	to: string;
	body: string;
	ts: number;
}

export interface SessionNoticeReceipt {
	to: string;
	id: string;
	/** `live` when a terminal owner for the session is registered, else `offline`: delivered at its next turn. */
	route: "live" | "offline";
}

export type NoticeState = "queued" | "claimed" | "delivered" | "unknown";

/** A notice older than this is dropped unread: a warning about a freeze is wrong a day later. */
export const NOTICE_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_NOTICE_BODY = 8 * 1024;
const MAX_PENDING_PER_SESSION = 100;
/** A claim not acknowledged within this long is offered again. */
export const CLAIM_STALE_MS = 60_000;
const TIMESTAMP_DIGITS = 15;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ID_PATTERN = /^[0-9]{15}-[0-9]{6}-[0-9a-f-]{36}$/;

export function isValidSessionId(sessionId: string): boolean {
	return SESSION_ID_PATTERN.test(sessionId);
}

let noticeSequence = 0;

function queueDir(root: string, sessionId: string): string {
	if (!isValidSessionId(sessionId)) throw new Error(`Invalid session id: ${JSON.stringify(sessionId)}`);
	return path.join(root, "run", "notices", sessionId);
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Session ids of the terminals that are registered and whose process runs, ignoring this process's own session. */
export function listLiveSessionIds(root = getConfigRootDir(), exceptSessionId?: string): string[] {
	const directory = path.join(root, "run", "terminals");
	let files: string[];
	try {
		files = fs.readdirSync(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const ids = new Set<string>();
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		let owner: Partial<TerminalOwner>;
		try {
			owner = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
		} catch {
			continue;
		}
		if (owner.version !== 1 || typeof owner.sessionId !== "string" || !isValidSessionId(owner.sessionId)) continue;
		if (typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) continue;
		if (owner.sessionId === exceptSessionId || !isPidAlive(owner.pid)) continue;
		ids.add(owner.sessionId);
	}
	return [...ids];
}

/**
 * A session announces that it takes notices by creating its queue directory. A session with a live
 * terminal owner needs no announcement; one whose pipe dropped, or whose terminal is gone, has made it
 * once already, so a notice for it still queues.
 */
export function registerSessionNoticeQueue(sessionId: string, root = getConfigRootDir()): void {
	fs.mkdirSync(queueDir(root, sessionId), { recursive: true, mode: 0o700 });
}

function safeList(directory: string): string[] {
	try {
		return fs.readdirSync(directory);
	} catch {
		return [];
	}
}

/** Millisecond timestamp every notice id starts with, or 0 for a file this module did not name. */
function idTimestamp(name: string): number {
	const stamp = Number(name.slice(0, TIMESTAMP_DIGITS));
	return Number.isFinite(stamp) ? stamp : 0;
}

function isNoticeFile(name: string): boolean {
	return name.endsWith(".json") && !name.startsWith(".");
}

/** Delete the notice files of `directory` older than the TTL. A file in use is left for the next pass. */
function purgeExpired(directory: string, now: number): void {
	for (const name of safeList(directory)) {
		if (!isNoticeFile(name) || now - idTimestamp(name) <= NOTICE_TTL_MS) continue;
		try {
			fs.rmSync(path.join(directory, name), { force: true });
		} catch {}
	}
}

/** Delete every file of `directory` whose last change is older than the TTL. */
function pruneByAge(directory: string, now: number): void {
	for (const name of safeList(directory)) {
		const file = path.join(directory, name);
		try {
			if (now - fs.statSync(file).mtimeMs > NOTICE_TTL_MS) fs.rmSync(file, { force: true });
		} catch {}
	}
}

/** Pending notice file names, oldest first. Expired ones are purged first, so they never count. */
function pendingNames(directory: string, now: number): string[] {
	purgeExpired(directory, now);
	// Ids start with a zero-padded timestamp and a sequence, so name order is send order.
	return safeList(directory).filter(isNoticeFile).sort();
}

/**
 * Queue one notice for `to`, a session id or `"all"` (every other live session). Returns one receipt
 * per queued notice. A session with no live owner still gets the notice if it ever announced its queue:
 * it reads it when it next runs. An id that is neither live nor announced is refused, so a typo does
 * not create a queue nobody reads. The body is stored as written, like an `irc` message, with no
 * secret scrubbing; the queue directory is mode 0700 and files are kept for at most 24 hours.
 */
export function sendSessionNotice(args: {
	from: string;
	to: string;
	body: string;
	root?: string;
}): SessionNoticeReceipt[] {
	const root = args.root ?? getConfigRootDir();
	const body = args.body.trim();
	if (!body) throw new Error("Notice body is empty");
	if (Buffer.byteLength(body) > MAX_NOTICE_BODY) throw new Error(`Notice body exceeds ${MAX_NOTICE_BODY} bytes`);
	if (args.to !== "all" && args.to === args.from) throw new Error("Cannot send a notice to your own session");
	const live = new Set(listLiveSessionIds(root));
	const targets = args.to === "all" ? [...live].filter(id => id !== args.from) : [args.to];
	const receipts: SessionNoticeReceipt[] = [];
	for (const to of targets) {
		const directory = queueDir(root, to);
		if (!live.has(to) && !fs.existsSync(directory)) {
			throw new Error(`Unknown session ${to}: no live terminal and no notice queue`);
		}
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
		const now = Date.now();
		if (pendingNames(directory, now).length >= MAX_PENDING_PER_SESSION) {
			throw new Error(`Session ${to} has ${MAX_PENDING_PER_SESSION} unread notices; not queuing more`);
		}
		const id = `${now.toString().padStart(TIMESTAMP_DIGITS, "0")}-${(noticeSequence++).toString().padStart(6, "0")}-${crypto.randomUUID()}`;
		const notice: SessionNotice = { version: 1, id, from: args.from, to, body, ts: now };
		// Written under a dot name, then renamed: a reader never sees half a notice.
		const temporary = path.join(directory, `.${id}.tmp`);
		fs.writeFileSync(temporary, JSON.stringify(notice), { mode: 0o600 });
		fs.renameSync(temporary, path.join(directory, `${id}.json`));
		receipts.push({ to, id, route: live.has(to) ? "live" : "offline" });
	}
	return receipts;
}

/**
 * Claim every notice waiting for `sessionId`, oldest first, for the caller to deliver. A claimed notice
 * moves to `claimed/`, so a second reader of the queue does not get it, but it is not delivered yet: the
 * caller calls {@link ackSessionNotices} once the notice is in the turn. A claim that is never
 * acknowledged (a crash in between) is offered again after {@link CLAIM_STALE_MS}, so delivery is
 * at least once. The caller drops a repeat by notice id.
 *
 * A file that cannot be moved stays in the queue for the next call and never stops the others. Expired
 * and unreadable notices are discarded. Old files in `claimed/` and `delivered/` are pruned on every
 * call, also when nothing is pending.
 */
export function claimSessionNotices(sessionId: string, root = getConfigRootDir(), now = Date.now()): SessionNotice[] {
	const directory = queueDir(root, sessionId);
	const claimed = path.join(directory, "claimed");
	purgeExpired(claimed, now);
	pruneByAge(path.join(directory, "delivered"), now);
	const read = (file: string): SessionNotice | undefined => {
		try {
			const notice = JSON.parse(fs.readFileSync(file, "utf8")) as SessionNotice;
			const valid =
				notice.version === 1 &&
				typeof notice.id === "string" &&
				typeof notice.from === "string" &&
				typeof notice.body === "string" &&
				typeof notice.ts === "number" &&
				notice.to === sessionId;
			return valid && now - notice.ts <= NOTICE_TTL_MS ? notice : undefined;
		} catch {
			return undefined;
		}
	};
	const taken: SessionNotice[] = [];
	// Claims the previous owner never acknowledged come first: they are older than anything pending.
	for (const name of safeList(claimed).filter(isNoticeFile).sort()) {
		const file = path.join(claimed, name);
		try {
			if (now - fs.statSync(file).mtimeMs < CLAIM_STALE_MS) continue;
			const notice = read(file);
			if (!notice) {
				fs.rmSync(file, { force: true });
				continue;
			}
			fs.utimesSync(file, new Date(now), new Date(now));
			taken.push(notice);
		} catch {}
	}
	const names = pendingNames(directory, now);
	if (names.length) fs.mkdirSync(claimed, { recursive: true, mode: 0o700 });
	for (const name of names) {
		const target = path.join(claimed, name);
		try {
			fs.renameSync(path.join(directory, name), target);
		} catch {
			continue; // another reader won it (ENOENT) or the move failed: it stays queued and the rest go on
		}
		const notice = read(target);
		if (notice) taken.push(notice);
		else fs.rmSync(target, { force: true });
	}
	return taken;
}

/** Mark claimed notices as delivered. A notice that is no longer claimed (acknowledged already) is skipped. */
export function ackSessionNotices(sessionId: string, ids: Iterable<string>, root = getConfigRootDir()): void {
	const directory = queueDir(root, sessionId);
	const delivered = path.join(directory, "delivered");
	try {
		fs.mkdirSync(delivered, { recursive: true, mode: 0o700 });
	} catch {
		return; // the claim stays and is offered again
	}
	for (const id of ids) {
		if (!ID_PATTERN.test(id)) continue;
		try {
			fs.renameSync(path.join(directory, "claimed", `${id}.json`), path.join(delivered, `${id}.json`));
		} catch {}
	}
}

/**
 * The sender's receipt: `delivered` once the notice is in the recipient's turn, `claimed` while the
 * recipient holds it, `queued` while it waits, `unknown` if it never existed or has expired.
 */
export function noticeState(to: string, id: string, root = getConfigRootDir()): NoticeState {
	const directory = queueDir(root, to);
	if (!ID_PATTERN.test(id)) return "unknown";
	if (fs.existsSync(path.join(directory, "delivered", `${id}.json`))) return "delivered";
	if (fs.existsSync(path.join(directory, "claimed", `${id}.json`))) return "claimed";
	if (fs.existsSync(path.join(directory, `${id}.json`))) return "queued";
	return "unknown";
}
