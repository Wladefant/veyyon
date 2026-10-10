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
	/** Delivery limit in ms; absent means {@link DEFAULT_DELIVERY_TTL_MS}. */
	ttlMs?: number;
	/** `status` marks a delivery report from the system; it never produces a report itself. */
	kind?: "status";
}

export interface SessionNoticeReceipt {
	to: string;
	id: string;
	/** `live` when a terminal owner for the session is registered, else `offline`: delivered at its next turn. */
	route: "live" | "offline";
}

export type NoticeState = "queued" | "claimed" | "delivered" | "expired" | "unknown";

/** A notice older than this is dropped unread: a warning about a freeze is wrong a day later. Also the cap on `ttlMs`. */
export const NOTICE_TTL_MS = 24 * 60 * 60 * 1000;
/** A notice older than this when its recipient reads it is not injected, unless the sender set `ttlMs`. */
export const DEFAULT_DELIVERY_TTL_MS = 2 * 60 * 60 * 1000;
/** Delivery that lags the send by at least this long is reported as late. */
const LATE_AFTER_MS = 60_000;
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
	/** Delivery limit in ms; a notice older than this when its recipient reads it is not injected. Default 2 h, at most 24 h. */
	ttlMs?: number;
	root?: string;
}): SessionNoticeReceipt[] {
	const root = args.root ?? getConfigRootDir();
	const body = args.body.trim();
	if (!body) throw new Error("Notice body is empty");
	if (Buffer.byteLength(body) > MAX_NOTICE_BODY) throw new Error(`Notice body exceeds ${MAX_NOTICE_BODY} bytes`);
	if (args.ttlMs !== undefined && !(args.ttlMs > 0)) throw new Error("Notice ttl must be positive");
	const ttlMs = args.ttlMs === undefined ? undefined : Math.min(args.ttlMs, NOTICE_TTL_MS);
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
		const id = writeNotice(directory, { from: args.from, to, body, ts: now, ttlMs });
		receipts.push({ to, id, route: live.has(to) ? "live" : "offline" });
	}
	return receipts;
}

/** Write one notice file into a queue directory and return its id. */
function writeNotice(
	directory: string,
	fields: { from: string; to: string; body: string; ts: number; ttlMs?: number; kind?: "status" },
): string {
	const id = `${fields.ts.toString().padStart(TIMESTAMP_DIGITS, "0")}-${(noticeSequence++).toString().padStart(6, "0")}-${crypto.randomUUID()}`;
	const notice: SessionNotice = { version: 1, id, ...fields };
	if (notice.ttlMs === undefined) delete notice.ttlMs;
	if (notice.kind === undefined) delete notice.kind;
	// Written under a dot name, then renamed: a reader never sees half a notice.
	const temporary = path.join(directory, `.${id}.tmp`);
	fs.writeFileSync(temporary, JSON.stringify(notice), { mode: 0o600 });
	fs.renameSync(temporary, path.join(directory, `${id}.json`));
	return id;
}

function deliveryTtlMs(notice: SessionNotice): number {
	return typeof notice.ttlMs === "number" && notice.ttlMs > 0
		? Math.min(notice.ttlMs, NOTICE_TTL_MS)
		: DEFAULT_DELIVERY_TTL_MS;
}

/**
 * Move a notice past its delivery limit to `expired/` (the sender's receipt reads `expired`) and queue a
 * status notice for the sender, so it learns on its next turn that the message never reached the model.
 * A status notice is never reported on in turn.
 */
function expireNotice(file: string, notice: SessionNotice, directory: string, root: string, now: number): void {
	try {
		const expired = path.join(directory, "expired");
		fs.mkdirSync(expired, { recursive: true, mode: 0o700 });
		fs.renameSync(file, path.join(expired, path.basename(file)));
	} catch {
		fs.rmSync(file, { force: true });
	}
	if (notice.kind === "status" || !isValidSessionId(notice.from) || notice.from === notice.to) return;
	try {
		const senderQueue = queueDir(root, notice.from);
		if (!fs.existsSync(senderQueue)) return;
		const limit = Math.round(deliveryTtlMs(notice) / 60_000);
		writeNotice(senderQueue, {
			from: "delivery-status",
			to: notice.from,
			ts: now,
			kind: "status",
			body:
				`Not delivered: your notice ${notice.id} to session ${notice.to} expired. ` +
				`It was sent ${formatTimes(notice.ts)} and read ${formatTimes(now)}, past its ${limit} min limit, ` +
				"so the recipient never saw it. Send it again if it still matters.",
		});
	} catch {}
}

/**
 * Claim every notice waiting for `sessionId`, oldest first, for the caller to deliver. A claimed notice
 * moves to `claimed/`, so a second reader of the queue does not get it, but it is not delivered yet: the
 * caller calls {@link ackSessionNotices} once the notice is in the turn. A claim that is never
 * acknowledged (a crash in between) is offered again after {@link CLAIM_STALE_MS}, so delivery is
 * at least once. The caller drops a repeat by notice id.
 *
 * A notice older than its delivery limit (`ttlMs`, default {@link DEFAULT_DELIVERY_TTL_MS}) is not
 * returned: it moves to `expired/` and the sender gets a status notice. A late notice would mislead.
 * A file that cannot be moved stays in the queue for the next call and never stops the others. Unreadable
 * notices are discarded. Old files in `claimed/`, `delivered/` and `expired/` are pruned on every
 * call, also when nothing is pending.
 */
export function claimSessionNotices(sessionId: string, root = getConfigRootDir(), now = Date.now()): SessionNotice[] {
	const directory = queueDir(root, sessionId);
	const claimed = path.join(directory, "claimed");
	purgeExpired(claimed, now);
	pruneByAge(path.join(directory, "delivered"), now);
	pruneByAge(path.join(directory, "expired"), now);
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
		try {
			fs.utimesSync(target, new Date(now), new Date(now)); // rename keeps the old mtime; staleness counts from the claim
		} catch {}
		const notice = read(target);
		if (!notice) {
			fs.rmSync(target, { force: true });
		} else if (now - notice.ts > deliveryTtlMs(notice)) {
			expireNotice(target, notice, directory, root, now);
		} else {
			taken.push(notice);
		}
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
 * recipient holds it, `queued` while it waits, `expired` when it outlived its delivery limit and was
 * not injected, `unknown` if it never existed or was purged.
 */
export function noticeState(to: string, id: string, root = getConfigRootDir()): NoticeState {
	const directory = queueDir(root, to);
	if (!ID_PATTERN.test(id)) return "unknown";
	if (fs.existsSync(path.join(directory, "delivered", `${id}.json`))) return "delivered";
	if (fs.existsSync(path.join(directory, "claimed", `${id}.json`))) return "claimed";
	if (fs.existsSync(path.join(directory, `${id}.json`))) return "queued";
	if (fs.existsSync(path.join(directory, "expired", `${id}.json`))) return "expired";
	return "unknown";
}

const NOTICE_ZONE = "Europe/Berlin";

function formatClock(ms: number, timeZone: string): string {
	const parts = new Intl.DateTimeFormat("sv-SE", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).format(new Date(ms));
	return parts.replace(/\u00a0/g, " ");
}

function formatTimes(ms: number): string {
	const berlin = formatClock(ms, NOTICE_ZONE);
	const utc = formatClock(ms, "UTC");
	return `${berlin} ${NOTICE_ZONE} (${utc.slice(11)} UTC)`;
}

function formatLate(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	const hours = Math.floor(minutes / 60);
	return hours > 0 ? `${hours}h${String(minutes % 60).padStart(2, "0")} late` : `${minutes} min late`;
}

/**
 * The text a recipient reads for a delivered notice: who sent it, when it was sent and when it was
 * delivered (Europe/Berlin and UTC), and how late it is when delivery lagged the send by a minute or more.
 */
export function formatNoticeMessage(notice: SessionNotice, deliveredAt: number): string {
	const delay = deliveredAt - notice.ts;
	const late = delay >= LATE_AFTER_MS ? `, ${formatLate(delay)}` : "";
	return [
		`[Notice from session \`${notice.from}\`]`,
		`Sent: ${formatTimes(notice.ts)}`,
		`Delivered: ${formatTimes(deliveredAt)}${late}`,
		"",
		notice.body,
	].join("\n");
}
