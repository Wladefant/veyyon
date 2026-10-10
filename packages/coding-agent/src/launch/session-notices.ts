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
 * - `delivered/<id>.json`  consumed by the recipient; the sender reads this as the receipt
 *
 * Consuming is a rename into `delivered/`. Rename is atomic, so two readers of one queue cannot both
 * win: a notice is delivered once.
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

export type NoticeState = "queued" | "delivered" | "unknown";

/** A notice older than this is dropped unread: a warning about a freeze is wrong a day later. */
export const NOTICE_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_NOTICE_BODY = 8 * 1024;
const MAX_PENDING_PER_SESSION = 100;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

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
 * Queue one notice for `to`, a session id or `"all"` (every other live session). Returns one receipt
 * per queued notice. A session with no live owner still gets the notice: it reads it when it next runs.
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
	const live = new Set(listLiveSessionIds(root));
	const targets = args.to === "all" ? [...live].filter(id => id !== args.from) : [args.to];
	if (args.to !== "all" && args.to === args.from) throw new Error("Cannot send a notice to your own session");
	const receipts: SessionNoticeReceipt[] = [];
	for (const to of targets) {
		const directory = queueDir(root, to);
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
		if (pendingNames(directory).length >= MAX_PENDING_PER_SESSION) {
			throw new Error(`Session ${to} has ${MAX_PENDING_PER_SESSION} unread notices; not queuing more`);
		}
		const id = `${Date.now().toString().padStart(15, "0")}-${(noticeSequence++).toString().padStart(6, "0")}-${crypto.randomUUID()}`;
		const notice: SessionNotice = { version: 1, id, from: args.from, to, body, ts: Date.now() };
		// Written under a dot name, then renamed: a reader never sees half a notice.
		const temporary = path.join(directory, `.${id}.tmp`);
		fs.writeFileSync(temporary, JSON.stringify(notice), { mode: 0o600 });
		fs.renameSync(temporary, path.join(directory, `${id}.json`));
		receipts.push({ to, id, route: live.has(to) ? "live" : "offline" });
	}
	return receipts;
}

function pendingNames(directory: string): string[] {
	try {
		return fs.readdirSync(directory).filter(name => name.endsWith(".json") && !name.startsWith("."));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

/**
 * Take every notice waiting for `sessionId`, oldest first. Each one is moved to `delivered/` before it
 * is read, so a second reader of the same queue gets none of the ones this call took. Expired and
 * unreadable notices are discarded and not returned.
 */
export function consumeSessionNotices(sessionId: string, root = getConfigRootDir(), now = Date.now()): SessionNotice[] {
	const directory = queueDir(root, sessionId);
	const names = pendingNames(directory).sort(); // ids start with a zero-padded timestamp and a sequence
	if (!names.length) return [];
	const delivered = path.join(directory, "delivered");
	fs.mkdirSync(delivered, { recursive: true, mode: 0o700 });
	const taken: SessionNotice[] = [];
	for (const name of names) {
		const target = path.join(delivered, name);
		try {
			fs.renameSync(path.join(directory, name), target);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // another reader won it
			throw error;
		}
		try {
			const notice = JSON.parse(fs.readFileSync(target, "utf8")) as SessionNotice;
			const valid =
				notice.version === 1 &&
				typeof notice.id === "string" &&
				typeof notice.from === "string" &&
				typeof notice.body === "string" &&
				typeof notice.ts === "number" &&
				notice.to === sessionId;
			if (valid && now - notice.ts <= NOTICE_TTL_MS) {
				taken.push(notice);
				continue;
			}
		} catch {}
		fs.rmSync(target, { force: true });
	}
	pruneDelivered(delivered, now);
	return taken;
}

function pruneDelivered(directory: string, now: number): void {
	try {
		for (const name of fs.readdirSync(directory)) {
			const file = path.join(directory, name);
			if (now - fs.statSync(file).mtimeMs > NOTICE_TTL_MS) fs.rmSync(file, { force: true });
		}
	} catch {}
}

/** The sender's receipt: `delivered` once the recipient took it, `queued` while it waits, `unknown` if it was never queued or has expired. */
export function noticeState(to: string, id: string, root = getConfigRootDir()): NoticeState {
	const directory = queueDir(root, to);
	if (!SESSION_ID_PATTERN.test(id)) return "unknown";
	if (fs.existsSync(path.join(directory, "delivered", `${id}.json`))) return "delivered";
	if (fs.existsSync(path.join(directory, `${id}.json`))) return "queued";
	return "unknown";
}
