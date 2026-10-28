/**
 * The notice reader lists the sessions whose terminal records are live. A record another local user can
 * read or write must not add a session to that list, however live its pid looks.
 *
 * WHY: a planted record with the current pid would route a notice to a session the user did not start.
 * The owner-only record beside it is the control: the reader must still list the real session.
 * POSIX only: a Windows record's refusal rests on its ACL, which the utils test covers.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { listLiveSessionOwners } from "../../src/launch/session-notices";

const tempRoots: string[] = [];

async function writeTerminalRecord(root: string, name: string, sessionId: string, mode: number): Promise<void> {
	const directory = path.join(root, "run", "terminals");
	await fs.mkdir(directory, { recursive: true });
	await fs.chmod(directory, 0o700);
	const file = path.join(directory, name);
	await fs.writeFile(file, JSON.stringify({ version: 1, sessionId, pid: process.pid }));
	await fs.chmod(file, mode);
}

afterEach(async () => {
	for (const root of tempRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("live session ids from terminal records", () => {
	// WHY: the refusal case. A 0644 record with a live pid is the planted claim; it must not be listed.
	// The 0600 record in the same directory is the control, so an empty list cannot pass for correct.
	it("lists the owner-only live session and omits the one another user can read", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-notices-"));
		tempRoots.push(root);
		await writeTerminalRecord(root, "1-owner.json", "owner-session", 0o600);
		await writeTerminalRecord(root, "2-planted.json", "planted-session", 0o644);
		expect(listLiveSessionOwners(root).map(owner => owner.sessionId)).toEqual(["owner-session"]);
	});
});
