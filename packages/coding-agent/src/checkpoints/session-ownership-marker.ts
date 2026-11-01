import { randomUUID } from "node:crypto";
import { type FileHandle, open, readFile, rename, rm, writeFile } from "node:fs/promises";
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
		("claimToken" in value && (typeof value.claimToken !== "string" || value.claimToken.length < 16)) ||
		("resumeToken" in value && (typeof value.resumeToken !== "string" || value.resumeToken.length < 16)) ||
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
	const bytes = Buffer.alloc(64 * 1024);
	let text: string;
	try {
		const { bytesRead } = await file.read(bytes, 0, bytes.byteLength, 0);
		text = bytes.subarray(0, bytesRead).toString("utf8");
	} finally {
		await file.close();
	}
	// The first physical line alone establishes native session identity.
	// Never skip a corrupt transfer header for a later forged ordinary header.
	const line = text.split(/\r?\n/, 2)[0];
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

export async function readSessionOwnershipMarker(sessionFile: string, sessionId: string): Promise<{
	path: string;
	marker: SessionOwnershipMarker;
} | null> {
	const directory = dirname(sessionFile);
	const path = join(directory, "checkpoint-ownership.json");
	const identity = await readNativeHandoffIdentity(sessionFile, sessionId);
	let recoveryValue: unknown;
	try {
		recoveryValue = JSON.parse(await readFile(join(directory, "..", "recovery.json"), "utf8"));
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
		markerValue = JSON.parse(await readFile(path, "utf8"));
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
	await writeFile(temporary, JSON.stringify(consumed), { flag: "wx", mode: 0o600 });
	try {
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true });
		throw new Error("Could not persist the rotated session resume capability", { cause: error });
	}
}
