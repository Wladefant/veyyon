import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface SessionOwnershipMarker {
	version: 1;
	sessionId: string;
	targetNode: string;
	claimToken?: string;
	epoch: number;
}

export async function readSessionOwnershipMarker(sessionFile: string, sessionId: string): Promise<{
	path: string;
	marker: SessionOwnershipMarker;
} | null> {
	const directory = dirname(sessionFile);
	let recovery: { sessionId?: unknown; checkpointTransfer?: unknown };
	try {
		recovery = JSON.parse(await readFile(join(directory, "..", "recovery.json"), "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			try {
				await lstat(join(directory, "checkpoint-ownership.json"));
				throw new Error("Transferred session recovery metadata is missing");
			} catch (markerError) {
				if ((markerError as NodeJS.ErrnoException).code === "ENOENT") return null;
				throw markerError;
			}
		}
		throw new Error("Cannot verify restored checkpoint ownership", { cause: error });
	}
	if (recovery.sessionId !== sessionId) throw new Error("Recovery metadata does not match the active session");
	if (recovery.checkpointTransfer !== true) return null;
	const path = join(directory, "checkpoint-ownership.json");
	let marker: SessionOwnershipMarker;
	try {
		marker = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		throw new Error("Transferred session ownership marker is missing or unreadable", { cause: error });
	}
	if (
		marker?.version !== 1 ||
		marker.sessionId !== sessionId ||
		typeof marker.targetNode !== "string" ||
		!marker.targetNode ||
		marker.targetNode.length > 128 ||
		!Number.isSafeInteger(marker.epoch) ||
		marker.epoch < 1 ||
		(marker.claimToken !== undefined &&
			(typeof marker.claimToken !== "string" || !marker.claimToken || marker.claimToken.length > 128))
	)
		throw new Error("Transferred session ownership marker is invalid");
	return { path, marker };
}

export async function consumeSessionOwnershipClaim(
	path: string,
	marker: SessionOwnershipMarker,
): Promise<void> {
	const { claimToken: _claimToken, ...consumed } = marker;
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, JSON.stringify(consumed), { flag: "wx", mode: 0o600 });
	try {
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true });
		throw new Error("Could not persist the consumed session ownership claim", { cause: error });
	}
}
