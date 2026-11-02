import { randomUUID } from "node:crypto";
import { SESSION_TITLE_SLOT_BYTES } from "@veyyon/kernel/session/session-entries";
import { parseTitleSlotLine } from "@veyyon/kernel/session/session-title-slot";
import { type FileHandle, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isCheckpointNodeLabel, type SessionHandoffIdentity } from "@veyyon/session/checkpoint-ownership";

export interface SessionOwnershipMarker extends SessionHandoffIdentity {
	sessionId: string;
	epoch: number;
	claimToken?: string;
	resumeToken?: string;
}

function isSessionOwnershipMarker(value: unknown): value is SessionOwnershipMarker {
	if (
		!value ||
		typeof value !== "object" ||
		!("version" in value) ||
		value.version !== 1 ||
		!("sessionId" in value) ||
		typeof value.sessionId !== "string" ||
		!("targetNode" in value) ||
		!isCheckpointNodeLabel(value.targetNode) ||
		!("transferId" in value) ||
		typeof value.transferId !== "string" ||
		!/^[A-Za-z0-9_-]{1,128}$/.test(value.transferId) ||
		!("transferEpoch" in value) ||
		typeof value.transferEpoch !== "number" ||
		!Number.isSafeInteger(value.transferEpoch) ||
		value.transferEpoch < 1 ||
		!("epoch" in value) ||
		typeof value.epoch !== "number" ||
		!Number.isSafeInteger(value.epoch) ||
		value.epoch < value.transferEpoch ||
		("claimToken" in value && (typeof value.claimToken !== "string" || value.claimToken.length < 16 || value.claimToken.length > 128)) ||
		("resumeToken" in value && (typeof value.resumeToken !== "string" || value.resumeToken.length < 16 || value.resumeToken.length > 128)) ||
		(Boolean("claimToken" in value) === Boolean("resumeToken" in value))
	)
		return false;
	return true;
}

async function readNativeHandoffIdentity(
	sessionFile: string,
	sessionId: string,
): Promise<SessionHandoffIdentity | undefined> {
	let file: FileHandle;
	try {
		file = await open(sessionFile, "r");
	} catch (error) {
		// A lazily created session has no file until its first persisted entry, so there is no handoff identity yet.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const headerLimit = 64 * 1024;
	const bytes = Buffer.alloc(headerLimit + 1);
	let text: string;
	try {
		let bytesRead = 0;
		let headerStart = 0;
		let newline = -1;
		let reachedEof = false;
		while (bytesRead < bytes.byteLength && newline < 0) {
			const next = await file.read(bytes, bytesRead, bytes.byteLength - bytesRead, bytesRead);
			if (next.bytesRead === 0) {
				reachedEof = true;
				break;
			}
			bytesRead += next.bytesRead;
			const lineEnd = bytes.subarray(headerStart, bytesRead).indexOf(10);
			if (lineEnd < 0) continue;
			newline = headerStart + lineEnd;
			// Native SessionManager writes one canonical fixed-width title slot before
			// the identity header. Do not skip arbitrary invalid or repeated lines.
			if (
				headerStart === 0 &&
				newline + 1 === SESSION_TITLE_SLOT_BYTES &&
				parseTitleSlotLine(bytes.subarray(0, newline).toString("utf8"))
			) {
				headerStart = newline + 1;
				const nextLineEnd = bytes.subarray(headerStart, bytesRead).indexOf(10);
				newline = nextLineEnd < 0 ? -1 : headerStart + nextLineEnd;
			}
		}
		// A newline after the cap or an unterminated partial read must fail closed.
		if (newline > headerLimit || (newline < 0 && (!reachedEof || bytesRead > headerLimit)))
			throw new Error("Native session header is missing or exceeds the ownership-read limit");
		text = bytes.subarray(headerStart, newline >= 0 ? newline : bytesRead).toString("utf8");
	} finally {
		await file.close();
	}
	// Only the immediate header (or the header after the canonical title slot)
	// establishes identity. A later forged ordinary header is never considered.
	const line = text;
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		throw new Error("Native session header is missing or exceeds the ownership-read limit");
	}
	if (!value || typeof value !== "object" || !("type" in value) || value.type !== "session")
		throw new Error("Native session header is missing or exceeds the ownership-read limit");
	if (!("id" in value) || value.id !== sessionId)
		throw new Error("Native session identity does not match the active session");
	if (!("checkpointHandoff" in value)) return undefined;
	const marker: unknown = value.checkpointHandoff;
	if (
		!marker ||
		typeof marker !== "object" ||
		!("version" in marker) ||
		marker.version !== 1 ||
		!("targetNode" in marker) ||
		!isCheckpointNodeLabel(marker.targetNode) ||
		!("transferId" in marker) ||
		typeof marker.transferId !== "string" ||
		!/^[A-Za-z0-9_-]{1,128}$/.test(marker.transferId) ||
		!("transferEpoch" in marker) ||
		typeof marker.transferEpoch !== "number" ||
		!Number.isSafeInteger(marker.transferEpoch) ||
		marker.transferEpoch < 1
	)
		throw new Error("Native session handoff identity is invalid");
	return {
		version: 1,
		targetNode: marker.targetNode,
		transferId: marker.transferId,
		transferEpoch: marker.transferEpoch,
	};
}

/** Bound transferred-session sidecars before JSON parsing. A malformed or
 * growing recovery/ownership file must not allocate unbounded session-load RAM. */
async function readBoundedOwnershipJson(path: string): Promise<unknown> {
	const maxBytes = 64 * 1024;
	const buffer = Buffer.alloc(maxBytes + 1);
	const file = await open(path, "r");
	try {
		let size = 0;
		while (size < buffer.byteLength) {
			const { bytesRead } = await file.read(buffer, size, buffer.byteLength - size, size);
			if (bytesRead === 0) break;
			size += bytesRead;
		}
		if (size > maxBytes) throw new Error("Checkpoint ownership sidecar exceeds the 64 KiB read limit");
		return JSON.parse(buffer.subarray(0, size).toString("utf8"));
	} finally {
		await file.close();
	}
}

export async function readSessionOwnershipMarker(sessionFile: string, sessionId: string): Promise<{
	path: string;
	marker: SessionOwnershipMarker;
} | null> {
	const directory = dirname(sessionFile);
	const path = join(directory, "checkpoint-ownership.json");
	const identity = await readNativeHandoffIdentity(sessionFile, sessionId);
	let recoveryValue: unknown;
	try {
		recoveryValue = await readBoundedOwnershipJson(join(directory, "..", "recovery.json"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			throw new Error("Cannot verify restored checkpoint ownership", { cause: error });
	}
	let recovery: { sessionId: string; checkpointTransfer: boolean } | undefined;
	if (recoveryValue !== undefined) {
		if (
			!recoveryValue ||
			typeof recoveryValue !== "object" ||
			!("sessionId" in recoveryValue) ||
			typeof recoveryValue.sessionId !== "string" ||
			!("checkpointTransfer" in recoveryValue) ||
			typeof recoveryValue.checkpointTransfer !== "boolean"
		)
			throw new Error("Restored checkpoint recovery metadata is invalid");
		recovery = { sessionId: recoveryValue.sessionId, checkpointTransfer: recoveryValue.checkpointTransfer };
	}
	let markerValue: unknown;
	try {
		markerValue = await readBoundedOwnershipJson(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			throw new Error("Transferred session ownership marker is unreadable", { cause: error });
	}
	if (!identity && recovery?.checkpointTransfer !== true) {
		if (markerValue !== undefined)
			throw new Error("Transferred session native handoff identity is missing");
		return null;
	}
	if (!identity || !isSessionOwnershipMarker(markerValue))
		throw new Error("Transferred session ownership marker is missing or invalid; prompt admission is blocked");
	if (!recovery || recovery.sessionId !== sessionId || recovery.checkpointTransfer !== true)
		throw new Error("Recovery metadata does not match the native handoff identity");
	if (
		markerValue.sessionId !== sessionId ||
		markerValue.targetNode !== identity.targetNode ||
		markerValue.transferId !== identity.transferId ||
		markerValue.transferEpoch !== identity.transferEpoch
	)
		throw new Error("Transferred session ownership marker does not match its native journal");
	return { path, marker: markerValue };
}

export async function persistSessionResumeCapability(
	path: string,
	marker: SessionOwnershipMarker,
	resumeToken: string,
	epoch: number,
): Promise<void> {
	const consumed: SessionOwnershipMarker = { ...marker, resumeToken, epoch };
	delete consumed.claimToken;
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		// The one-time authority claim must not be finalized before its rotated
		// recovery capability has at least been flushed to the source file.
		const file = await open(temporary, "wx", 0o600);
		try {
			await file.writeFile(JSON.stringify(consumed));
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, path);
		// Flush renamed directory metadata where directory handles support sync.
		// Windows post-rename power-loss durability still requires host proof.
		if (process.platform !== "win32") {
			const directory = await open(dirname(path), "r");
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
		}
	} catch (error) {
		try {
			await rm(temporary, { force: true });
		} catch (cleanupError) {
			throw new Error("Could not persist or clean up the rotated session resume capability", {
				cause: new AggregateError([error, cleanupError]),
			});
		}
		throw new Error("Could not persist the rotated session resume capability", { cause: error });
	}
}
