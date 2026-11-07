import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { describe, expect, it, spyOn } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	CURRENT_SESSION_VERSION,
	type SessionHeader,
	type SessionMessageEntry,
} from "@veyyon/kernel/session/session-entries";
import { loadEntriesFromFile } from "@veyyon/kernel/session/session-loader";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { serializeTitleSlot } from "@veyyon/kernel/session/session-title-slot";
import { FileSessionStorage, MemorySessionStorage, type SessionFileBody, type SessionStorageWriter, type WriteTextAtomicOptions } from "@veyyon/kernel/session/session-storage";
import { getTerminalSessionsDir, removeWithRetries, setAgentDir, TempDir } from "@veyyon/utils";
import { captureDirOverrides, restoreDirOverrides } from "@veyyon/utils/dirs";
import { getTerminalId } from "@veyyon/utils/ttyid";

interface JsonlMessageEntry {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message: {
		role: "user";
		content: string;
		timestamp: number;
	};
}

describe("SessionManager.forkFrom", () => {
	it("suppresses terminal breadcrumbs while preserving source history under a new parented session", async () => {
		using tempDir = TempDir.createSync("@veyyon-session-fork-");
		// `setAgentDir(previousAgentDir)` is not an inverse: it exports the variable even
		// when it was absent and clears the active profile, which is what leaked here.
		const dirOverrides = captureDirOverrides();
		const previousTermSessionId = process.env.TERM_SESSION_ID;
		setAgentDir(path.join(tempDir.path(), "agent"));
		process.env.TERM_SESSION_ID = "veyyon-fork-test";
		try {
			const cwd = path.join(tempDir.path(), "project");
			const sessionDir = path.join(tempDir.path(), "sessions");
			await fs.mkdir(sessionDir, { recursive: true });
			const sourceFile = path.join(sessionDir, "source.jsonl");
			const timestamp = new Date().toISOString();
			const sourceHeader: SessionHeader = {
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "source-session",
				timestamp,
				cwd,
			};
			const sourceMessage: JsonlMessageEntry = {
				type: "message",
				id: "message-1",
				parentId: null,
				timestamp,
				message: { role: "user", content: "hello", timestamp: Date.now() },
			};
			const sourceText = `${JSON.stringify(sourceHeader)}\n${JSON.stringify(sourceMessage)}\n`;
			await Bun.write(sourceFile, sourceText);

			const terminalId = getTerminalId();
			expect(terminalId).toBeString();
			const breadcrumbFile = path.join(getTerminalSessionsDir(), terminalId ?? "missing");
			await removeWithRetries(breadcrumbFile);

			const forked = await SessionManager.forkFrom(sourceFile, cwd, sessionDir, undefined, {
				suppressBreadcrumb: true,
			});
			await Bun.sleep(10);
			const cloneFile = forked.getSessionFile();
			expect(cloneFile).toBeString();
			if (!cloneFile) throw new Error("expected forked session file");

			expect(await Bun.file(sourceFile).text()).toBe(sourceText);
			expect(await Bun.file(breadcrumbFile).exists()).toBe(false);
			expect(cloneFile).not.toBe(sourceFile);

			const cloneEntries = await loadEntriesFromFile(cloneFile);
			const cloneHeader = cloneEntries.find((entry): entry is SessionHeader => entry.type === "session");
			const cloneMessage = cloneEntries.find((entry): entry is SessionMessageEntry => entry.type === "message");
			expect(cloneHeader?.id).not.toBe(sourceHeader.id);
			expect(cloneHeader?.parentSession).toBe(sourceHeader.id);
			expect(cloneHeader?.cwd).toBe(cwd);
			if (cloneMessage?.message.role !== "user") throw new Error("expected forked user message");
			expect(cloneMessage.message.content).toBe("hello");
		} finally {
			if (previousTermSessionId === undefined) {
				delete process.env.TERM_SESSION_ID;
			} else {
				process.env.TERM_SESSION_ID = previousTermSessionId;
			}
			restoreDirOverrides(dirOverrides);
		}
	});
});



describe("SessionManager.forkFrom preserves inherited artifact evidence", () => {
	it("copies inherited local bytes before publication and allocates a distinct next artifact ID", async () => {
		using temp = TempDir.createSync("@veyyon-forkfrom-evidence-");
		const cwd = path.join(temp.path(), "project");
		const sessions = path.join(temp.path(), "sessions");
		const original = "original output Ω 😀\\r\\nwith trailing spaces  ";
		const source = SessionManager.create(cwd, sessions);
		let forked: SessionManager | undefined;
		try {
			expect(await source.saveArtifact(original, "bash")).toBe("0");
			const message = "Recover exact original output: artifact://0";
			source.appendMessage({ role: "user", content: message, timestamp: Date.now() });
			// User-only sessions stay lazy: flush() alone does not create their JSONL.
			// Materialize source evidence before exercising fork preservation.
			await source.ensureOnDisk();
			const sourceFile = source.getSessionFile();
			if (!sourceFile) throw new Error("expected persisted source");
			const sourceBefore = await fs.readFile(sourceFile, "utf8");
			const sourceArtifact = await source.getArtifactPath("0");
			if (!sourceArtifact) throw new Error("expected original local artifact");

			forked = await SessionManager.forkFrom(sourceFile, cwd, sessions, undefined, {
				suppressBreadcrumb: true,
			});
			const clonedFile = forked.getSessionFile();
			if (!clonedFile) throw new Error("expected persisted clone");
			expect(clonedFile).not.toBe(sourceFile);
			const inheritedArtifact = await forked.getArtifactPath("0");
			if (!inheritedArtifact) throw new Error("expected inherited local artifact");
			expect(inheritedArtifact).not.toBe(sourceArtifact);
			expect(await fs.readFile(inheritedArtifact, "utf8")).toBe(original);
			expect(await fs.readFile(sourceArtifact, "utf8")).toBe(original);
			expect(forked.getEntries().some(entry =>
				entry.type === "message" && entry.message.role === "user" && entry.message.content === message
			)).toBe(true);

			expect(await forked.saveArtifact("different later output", "bash")).toBe("1");
			expect(await fs.readFile(inheritedArtifact, "utf8")).toBe(original);
			expect(await fs.readFile(sourceArtifact, "utf8")).toBe(original);
			expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBefore);
		} finally {
			await forked?.close();
			await source.close();
		}
	});

	it("refuses a missing local source artifact before publishing a new session", async () => {
		using temp = TempDir.createSync("@veyyon-forkfrom-missing-");
		const cwd = path.join(temp.path(), "project");
		const sessions = path.join(temp.path(), "sessions");
		const source = SessionManager.create(cwd, sessions);
		try {
			const original = "source evidence must survive";
			expect(await source.saveArtifact(original, "bash")).toBe("0");
			source.appendMessage({ role: "user", content: "original: artifact://0", timestamp: Date.now() });
			await source.ensureOnDisk();
			const sourceFile = source.getSessionFile();
			if (!sourceFile) throw new Error("expected persisted source");
			const sourceBefore = await fs.readFile(sourceFile, "utf8");
			const originalDir = sourceFile.slice(0, -".jsonl".length);
			const parkedDir = path.join(temp.path(), "parked-evidence");
			await fs.rename(originalDir, parkedDir);
			try {
				const filesBefore = (await fs.readdir(sessions)).sort();
				await expect(SessionManager.forkFrom(sourceFile, cwd, sessions, undefined, {
					suppressBreadcrumb: true,
				})).rejects.toThrow(/referenced artifacts unavailable/i);
				expect((await fs.readdir(sessions)).sort()).toEqual(filesBefore);
				expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBefore);
				expect(await fs.readFile(path.join(parkedDir, "0.bash.log"), "utf8")).toBe(original);
			} finally {
				await fs.rename(parkedDir, originalDir);
			}
		} finally {
			await source.close();
		}
	});

	it("preserves foreign-session URLs without requiring or copying their artifact IDs", async () => {
		using temp = TempDir.createSync("@veyyon-forkfrom-foreign-");
		const cwd = path.join(temp.path(), "project");
		const sessions = path.join(temp.path(), "sessions");
		const source = SessionManager.create(cwd, sessions);
		let forked: SessionManager | undefined;
		try {
			const message = "External output: artifact://0?session=another-execution-session";
			source.appendMessage({ role: "user", content: message, timestamp: Date.now() });
			await source.ensureOnDisk();
			const sourceFile = source.getSessionFile();
			if (!sourceFile) throw new Error("expected persisted source");
			const sourceBefore = await fs.readFile(sourceFile, "utf8");

			forked = await SessionManager.forkFrom(sourceFile, cwd, sessions, undefined, {
				suppressBreadcrumb: true,
			});
			expect(forked.getEntries().some(entry =>
				entry.type === "message" && entry.message.role === "user" && entry.message.content === message
			)).toBe(true);
			expect(await forked.getArtifactPath("0")).toBeNull();
			expect(await forked.saveArtifact("new local output", "bash")).toBe("0");
			expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBefore);
		} finally {
			await forked?.close();
			await source.close();
		}
	});

	it("does not replace a valid terminal breadcrumb when inherited evidence preflight refuses", async () => {
		using temp = TempDir.createSync("@veyyon-forkfrom-breadcrumb-");
		const overrides = captureDirOverrides();
		const priorTerminalId = process.env.TERM_SESSION_ID;
		let source: SessionManager | undefined;
		let forked: SessionManager | undefined;
		try {
			setAgentDir(path.join(temp.path(), "agent"));
			process.env.TERM_SESSION_ID = "veyyon-forkfrom-breadcrumb-test";
			const cwd = path.join(temp.path(), "project");
			const sessions = path.join(temp.path(), "sessions");
			await fs.mkdir(cwd, { recursive: true });
			await fs.mkdir(getTerminalSessionsDir(), { recursive: true });
			const terminalId = getTerminalId();
			if (!terminalId) throw new Error("expected isolated test terminal ID");
			const breadcrumbFile = path.join(getTerminalSessionsDir(), terminalId);

			source = SessionManager.create(cwd, sessions);
			expect(await source.saveArtifact("synthetic preserved evidence", "bash")).toBe("0");
			source.appendMessage({
				role: "user", content: "Local evidence artifact://0", timestamp: Date.now(),
			});
			await source.ensureOnDisk();
			const sourceFile = source.getSessionFile();
			if (!sourceFile) throw new Error("expected persisted source");
			const beforeBreadcrumb = await fs.readFile(breadcrumbFile, "utf8");
			expect(beforeBreadcrumb.split(/\r?\n/)[1]).toBe(sourceFile);
			const sourceBefore = await fs.readFile(sourceFile, "utf8");
			const oldArtifacts = sourceFile.slice(0, -".jsonl".length);
			const parked = path.join(temp.path(), "parked-original-artifacts");
			await fs.rename(oldArtifacts, parked);
			try {
				const inventoryBefore = (await fs.readdir(sessions)).sort();
				await expect(SessionManager.forkFrom(sourceFile, cwd, sessions)).rejects.toThrow(
					/referenced artifacts unavailable/i,
				);
				expect(await fs.readFile(breadcrumbFile, "utf8")).toBe(beforeBreadcrumb);
				expect((await fs.readdir(sessions)).sort()).toEqual(inventoryBefore);
				expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBefore);
			} finally {
				await fs.rename(parked, oldArtifacts);
			}

			// Positive twin: a successful fork registers only an existing new JSONL.
			forked = await SessionManager.forkFrom(sourceFile, cwd, sessions);
			const forkFile = forked.getSessionFile();
			if (!forkFile) throw new Error("expected persisted fork");
			expect((await fs.stat(forkFile)).isFile()).toBe(true);
			const afterBreadcrumb = await fs.readFile(breadcrumbFile, "utf8");
			expect(afterBreadcrumb.split(/\r?\n/)[1]).toBe(forkFile);
			expect(afterBreadcrumb.split(/\r?\n/)).not.toContain("fresh");
			expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBefore);
		} finally {
			await forked?.close();
			await source?.close();
			if (priorTerminalId === undefined) delete process.env.TERM_SESSION_ID;
			else process.env.TERM_SESSION_ID = priorTerminalId;
			restoreDirOverrides(overrides);
		}
	});



	it("refuses forkFrom into the source artifact tree before reserving any child evidence", async () => {
		using temp = TempDir.createSync("@veyyon-forkfrom-nested-evidence-");
		const cwd = path.join(temp.path(), "project");
		const sessions = path.join(temp.path(), "sessions");
		const source = SessionManager.create(cwd, sessions);
		try {
			expect(await source.saveArtifact("synthetic source evidence must stay unchanged", "bash")).toBe("0");
			source.appendMessage({
				role: "user", content: "Recover synthetic evidence: artifact://0", timestamp: Date.now(),
			});
			await source.ensureOnDisk();
			const sourceFile = source.getSessionFile();
			const originalArtifact = await source.getArtifactPath("0");
			if (!sourceFile || !originalArtifact) throw new Error("expected persisted synthetic evidence");
			const artifactDir = path.dirname(originalArtifact);
			const nestedSession = path.join(artifactDir, "nested-fork.jsonl");
			const nestedSidecar = path.join(artifactDir, "nested-fork");
			const originalSession = await fs.readFile(sourceFile, "utf8");
			const originalBytes = await fs.readFile(originalArtifact, "utf8");
			const originalInventory = (await fs.readdir(artifactDir)).sort();

			// The old artifact tree cannot be the parent of the copied fork
			// output: even a failed recursive cp must not reserve a child inside it.
			await expect(SessionManager.forkFrom(sourceFile, cwd, sessions, undefined, {
				sessionFile: nestedSession, suppressBreadcrumb: true,
			})).rejects.toThrow(/destination inside source artifact tree/i);
			expect((await fs.readdir(artifactDir)).sort()).toEqual(originalInventory);
			expect(await fs.readFile(sourceFile, "utf8")).toBe(originalSession);
			expect(await fs.readFile(originalArtifact, "utf8")).toBe(originalBytes);
			expect(await Bun.file(nestedSession).exists()).toBe(false);
			expect(await Bun.file(nestedSidecar).exists()).toBe(false);
			expect(source.getSessionFile()).toBe(sourceFile);
		} finally {
			await source.close();
		}
	});



	it("refuses forkFrom through an aliased destination parent before mutating source evidence", async () => {
		using temp = TempDir.createSync("@veyyon-forkfrom-alias-evidence-");
		const cwd = path.join(temp.path(), "project");
		const sessions = path.join(temp.path(), "sessions");
		const source = SessionManager.create(cwd, sessions);
		try {
			const original = "synthetic original output may not be copied into itself";
			expect(await source.saveArtifact(original, "bash")).toBe("0");
			source.appendMessage({
				role: "user", content: "Original evidence: artifact://0", timestamp: Date.now(),
			});
			await source.ensureOnDisk();
			const sourceFile = source.getSessionFile();
			const sourceArtifact = await source.getArtifactPath("0");
			if (!sourceFile || !sourceArtifact) throw new Error("expected source artifact and transcript");

			const sourceArtifactDir = path.dirname(sourceArtifact);
			const alias = path.join(sessions, "aliased-artifact-parent");
			// The target is lexically outside sourceArtifactDir but physically inside it.
			// A Windows directory junction exercises the same parent-path alias.
			await fs.symlink(sourceArtifactDir, alias, process.platform === "win32" ? "junction" : "dir");
			const nestedSession = path.join(alias, "aliased-child.jsonl");
			const nestedSidecar = path.join(alias, "aliased-child");
			const transcriptBefore = await fs.readFile(sourceFile, "utf8");
			const inventoryBefore = (await fs.readdir(sourceArtifactDir)).sort();

			await expect(SessionManager.forkFrom(sourceFile, cwd, sessions, undefined, {
				sessionFile: nestedSession, suppressBreadcrumb: true,
			})).rejects.toThrow(/destination inside source artifact tree/i);
			expect((await fs.readdir(sourceArtifactDir)).sort()).toEqual(inventoryBefore);
			expect(await fs.readFile(sourceFile, "utf8")).toBe(transcriptBefore);
			expect(await fs.readFile(sourceArtifact, "utf8")).toBe(original);
			expect(await Bun.file(nestedSession).exists()).toBe(false);
			expect(await Bun.file(nestedSidecar).exists()).toBe(false);
			expect(source.getSessionFile()).toBe(sourceFile);
		} finally {
			await source.close();
		}
	});

	it("refuses transcript symlink and hardlink aliases before copying unrelated artifact evidence", async () => {
		using temp = TempDir.createSync("@veyyon-forkfrom-source-alias-provenance-");
		const cwd = path.join(temp.path(), "project");
		const sessions = path.join(temp.path(), "sessions");
		const source = SessionManager.create(cwd, sessions);
		try {
			const evidence = "synthetic evidence owned by the original transcript";
			expect(await source.saveArtifact(evidence, "bash")).toBe("0");
			source.appendMessage({
				role: "user", content: "Preserve the original artifact://0", timestamp: Date.now(),
			});
			await source.ensureOnDisk();
			const sourceFile = source.getSessionFile();
			const originalArtifact = await source.getArtifactPath("0");
			if (!sourceFile || !originalArtifact) throw new Error("expected persistent synthetic source evidence");
			const sourceBytes = await fs.readFile(sourceFile, "utf8");
			const originalInventory = (await fs.readdir(path.dirname(originalArtifact))).sort();
			for (const kind of ["symlink", "hardlink"] as const) {
				const aliasFile = path.join(sessions, `source-${kind}-alias.jsonl`);
				if (kind === "symlink") await fs.symlink(sourceFile, aliasFile, "file");
				else await fs.link(sourceFile, aliasFile);
				const aliasSidecar = aliasFile.slice(0, -".jsonl".length);
				await fs.mkdir(aliasSidecar);
				const wrongBytes = `synthetic DIFFERENT artifact for ${kind} alias`;
				const wrongLog = path.join(aliasSidecar, "0.bash.log");
				await fs.writeFile(wrongLog, wrongBytes);
				const destination = path.join(sessions, `fork-${kind}-alias.jsonl`);
				await expect(SessionManager.forkFrom(aliasFile, cwd, sessions, undefined, {
					sessionFile: destination, suppressBreadcrumb: true,
				})).rejects.toThrow(/source transcript alias/i);
				expect(await Bun.file(destination).exists()).toBe(false);
				expect(await Bun.file(destination.slice(0, -".jsonl".length)).exists()).toBe(false);
				expect(await fs.readFile(wrongLog, "utf8")).toBe(wrongBytes);
				expect(await fs.readFile(originalArtifact, "utf8")).toBe(evidence);
				expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBytes);
				expect((await fs.readdir(path.dirname(originalArtifact))).sort()).toEqual(originalInventory);
		}
	} finally {
		await source.close();
	}
	});

	it("refuses a pinned forkFrom destination equal to the source without rewriting history", async () => {
		using temp = TempDir.createSync("@veyyon-forkfrom-same-path-");
		const cwd = path.join(temp.path(), "project");
		const sessions = path.join(temp.path(), "sessions");
		const source = SessionManager.create(cwd, sessions);
		try {
			source.appendMessage({
				role: "user", content: "Original transcript must never be replaced", timestamp: Date.now(),
			});
			await source.ensureOnDisk();
			const sourceFile = source.getSessionFile();
			if (!sourceFile) throw new Error("expected persistent source");
			const originalBytes = await fs.readFile(sourceFile, "utf8");
			const filesBefore = (await fs.readdir(sessions)).sort();

			await expect(SessionManager.forkFrom(sourceFile, cwd, sessions, undefined, {
				suppressBreadcrumb: true,
				sessionFile: sourceFile,
			})).rejects.toThrow(/destination must differ from source/i);
			expect(await fs.readFile(sourceFile, "utf8")).toBe(originalBytes);
			expect((await fs.readdir(sessions)).sort()).toEqual(filesBefore);
			expect(source.getSessionFile()).toBe(sourceFile);
		} finally {
			await source.close();
		}
	});


  it("refuses occupied named transcript or artifact destinations without overwriting their evidence", async () => {
    using temp = TempDir.createSync("@veyyon-forkfrom-occupied-target-");
    const cwd = path.join(temp.path(), "project");
    const sessions = path.join(temp.path(), "sessions");
    const source = SessionManager.create(cwd, sessions);
    let forked: SessionManager | undefined;
    try {
      source.appendMessage({
        role: "user", content: "Original synthetic source history", timestamp: Date.now(),
      });
      await source.ensureOnDisk();
      const sourceFile = source.getSessionFile();
      if (!sourceFile) throw new Error("expected durable source transcript");
      const sourceBytes = await fs.readFile(sourceFile, "utf8");

      // Distinct existing destination JSONL: an unnamed new manager must not
      // silently replace another session simply because its path is pinned.
      const occupiedFile = path.join(sessions, "occupied-history.jsonl");
      const occupiedHeader: SessionHeader = {
        type: "session", version: CURRENT_SESSION_VERSION,
        id: "synthetic-other-session", timestamp: new Date().toISOString(), cwd,
      };
      const occupiedBytes = `${JSON.stringify(occupiedHeader)}\n${JSON.stringify({
        type: "message", id: "other-message", parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "Other history must survive", timestamp: Date.now() },
      })}\n`;
      await fs.writeFile(occupiedFile, occupiedBytes);
      await expect(SessionManager.forkFrom(sourceFile, cwd, sessions, undefined, {
        sessionFile: occupiedFile, suppressBreadcrumb: true,
      })).rejects.toThrow(/destination.*already exists/i);
      expect(await fs.readFile(occupiedFile, "utf8")).toBe(occupiedBytes);
      expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBytes);

      // A destination without JSONL may already own a different session's
      // artifact sidecar. Do not publish a fork that adopts those old bytes.
      const sidecarFile = path.join(sessions, "occupied-evidence.jsonl");
      const sidecarDir = sidecarFile.slice(0, -".jsonl".length);
      await fs.mkdir(sidecarDir);
      const otherArtifact = path.join(sidecarDir, "0.bash.log");
      await fs.writeFile(otherArtifact, "unrelated synthetic output");
      await expect(SessionManager.forkFrom(sourceFile, cwd, sessions, undefined, {
        sessionFile: sidecarFile, suppressBreadcrumb: true,
      })).rejects.toThrow(/destination.*already exists/i);
      expect(await Bun.file(sidecarFile).exists()).toBe(false);
      expect(await fs.readFile(otherArtifact, "utf8")).toBe("unrelated synthetic output");
      expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBytes);

      // Positive twin: a clean pinned destination remains supported.
      const cleanFile = path.join(sessions, "clean-fork.jsonl");
      forked = await SessionManager.forkFrom(sourceFile, cwd, sessions, undefined, {
        sessionFile: cleanFile, suppressBreadcrumb: true,
      });
      expect(forked.getSessionFile()).toBe(cleanFile);
      expect((await fs.stat(cleanFile)).isFile()).toBe(true);
      expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBytes);
      expect(await fs.readFile(occupiedFile, "utf8")).toBe(occupiedBytes);
      expect(await fs.readFile(otherArtifact, "utf8")).toBe("unrelated synthetic output");
    } finally {
      await forked?.close();
      await source.close();
    }
  });

	it("exclusively reserves a named fork before copying so a competing fork cannot replace its evidence", async () => {
		using temp = TempDir.createSync("@veyyon-forkfrom-concurrent-destination-");
		const cwd = path.join(temp.path(), "project");
		const sessions = path.join(temp.path(), "sessions");
		const source = SessionManager.create(cwd, sessions);
		let forked: SessionManager | undefined;
		let competing: SessionManager | undefined;
		try {
			expect(await source.saveArtifact("synthetic original archive", "bash")).toBe("0");
			source.appendMessage({
				role: "user", content: "Keep local recovery artifact://0", timestamp: Date.now(),
			});
			await source.ensureOnDisk();
			const sourceFile = source.getSessionFile();
			const sourceArtifact = await source.getArtifactPath("0");
			if (!sourceFile || !sourceArtifact) throw new Error("expected original persisted evidence");
			const sourceBefore = await fs.readFile(sourceFile, "utf8");
			const artifactBefore = await fs.readFile(sourceArtifact, "utf8");
			const destinationFile = path.join(sessions, "named-concurrent-fork.jsonl");
			const destinationArtifacts = destinationFile.slice(0, -".jsonl".length);
			const copyOriginal = nodeFs.promises.cp.bind(nodeFs.promises);
			let competitorAttempted = false;
			let competitorFailure: unknown;
			// A second independent manager arrives exactly after the first has
			// reached its real artifact-copy boundary. Without an atomic
			// reservation it can publish the same named destination first.
			const copySpy = spyOn(nodeFs.promises, "cp").mockImplementation(async (from, to, options) => {
				const fromPath = typeof from === "string" ? from : fileURLToPath(from);
				const toPath = typeof to === "string" ? to : fileURLToPath(to);
				if (path.dirname(fromPath) === path.dirname(sourceArtifact) && path.dirname(toPath) === destinationArtifacts && !competitorAttempted) {
					competitorAttempted = true;
					try {
						competing = await SessionManager.forkFrom(sourceFile, cwd, sessions, undefined, {
							sessionFile: destinationFile, suppressBreadcrumb: true,
						});
					} catch (error) {
						competitorFailure = error;
					}
				}
				await copyOriginal(from, to, options);
			});
			try {
				forked = await SessionManager.forkFrom(sourceFile, cwd, sessions, undefined, {
					sessionFile: destinationFile, suppressBreadcrumb: true,
				});
			} finally {
				copySpy.mockRestore();
			}
			expect(competitorAttempted).toBe(true);
			expect(competing).toBeUndefined();
			expect(String(competitorFailure)).toMatch(/destination.*already exists/i);
			expect(forked.getSessionFile()).toBe(destinationFile);
			expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBefore);
			expect(await fs.readFile(sourceArtifact, "utf8")).toBe(artifactBefore);
			expect(await fs.readFile(path.join(destinationArtifacts, path.basename(sourceArtifact)), "utf8")).toBe(artifactBefore);
		} finally {
			await competing?.close();
			await forked?.close();
			await source.close();
		}
	});

});

describe("SessionManager.fork preserves inherited artifact evidence", () => {
  const originalBytes = "original archived output Ω 😀\\r\\nwith exact spacing  ";
  async function readSaved(manager: SessionManager, id: string): Promise<string> {
    const artifactPath = await manager.getArtifactPath(id);
    if (!artifactPath) throw new Error(`missing expected artifact ${id}`);
    return fs.readFile(artifactPath, "utf8");
  }

  it("rebinds same-sidecar adopted evidence to the new fork before the next artifact save", async () => {
    using temp = TempDir.createSync("@veyyon-fork-same-sidecar-owner-");
    const cwd = path.join(temp.path(), "project");
    const manager = SessionManager.create(cwd, path.join(temp.path(), "sessions"));
    try {
      const originalBytes = "SYNTHETIC OLD-SIDE ARTIFACT";
      const nextBytes = "SYNTHETIC NEW-FORK ARTIFACT";
      expect(await manager.saveArtifact(originalBytes, "bash")).toBe("0");
      const sameSidecarOwner = manager.getArtifactManager();
      if (!sameSidecarOwner) throw new Error("expected original artifact manager");
      manager.adoptArtifactManager(sameSidecarOwner);
      manager.appendMessage({ role: "user", content: "Preserve local artifact://0", timestamp: Date.now() });
      await manager.ensureOnDisk();

      const originalFile = manager.getSessionFile();
      const originalDir = manager.getArtifactsDir();
      const originalPath = await manager.getArtifactPath("0");
      if (!originalFile || !originalDir || !originalPath) throw new Error("expected persisted original");
      expect(originalDir).toBe(originalFile.slice(0, -".jsonl".length));
      const switched = await manager.fork();
      if (!switched) throw new Error("expected persisted fork");
      expect(switched.oldSessionFile).toBe(originalFile);
      const forkDir = switched.newSessionFile.slice(0, -".jsonl".length);

      // The accepted same-sidecar adoption must not retain the old manager
      // across a new session identity: copied old evidence stays readable,
      // but later artifacts belong exclusively to the new sidecar.
      expect(manager.getArtifactsDir()).toBe(forkDir);
      const inheritedPath = await manager.getArtifactPath("0");
      expect(inheritedPath).toBe(path.join(forkDir, path.basename(originalPath)));
      expect(await fs.readFile(inheritedPath!, "utf8")).toBe(originalBytes);
      expect(await fs.readFile(originalPath, "utf8")).toBe(originalBytes);
      expect(await manager.saveArtifact(nextBytes, "bash")).toBe("1");
      const nextPath = await manager.getArtifactPath("1");
      if (!nextPath) throw new Error("expected new artifact");
      expect(path.dirname(nextPath)).toBe(forkDir);
      expect(await fs.readFile(nextPath, "utf8")).toBe(nextBytes);
      expect(await Bun.file(path.join(originalDir, path.basename(nextPath))).exists()).toBe(false);
      expect(await Bun.file(originalFile).exists()).toBe(true);
      expect(await Bun.file(switched.newSessionFile).exists()).toBe(true);
    } finally {
      await manager.close();
    }
  });

  it("refuses an adopted parent artifact scope even if a stale child sidecar has the same ID", async () => {
    using temp = TempDir.createSync("@veyyon-fork-adopted-artifact-owner-");
    const cwd = path.join(temp.path(), "project");
    const parent = SessionManager.create(cwd, path.join(temp.path(), "sessions"));
    let child: SessionManager | undefined;
    try {
      const parentEvidence = "SYNTHETIC ORIGINAL PARENT EVIDENCE";
      const staleEvidence = "SYNTHETIC UNRELATED CHILD SIDECAR";
      expect(await parent.saveArtifact(parentEvidence, "bash")).toBe("0");
      parent.appendMessage({ role: "user", content: "Parent owns artifact://0", timestamp: Date.now() });
      await parent.ensureOnDisk();
      const parentArtifactDir = parent.getArtifactsDir();
      const parentArtifactPath = await parent.getArtifactPath("0");
      const parentFile = parent.getSessionFile();
      const parentArtifactManager = parent.getArtifactManager();
      if (!parentArtifactDir || !parentArtifactPath || !parentFile || !parentArtifactManager) {
        throw new Error("expected persisted parent artifact owner");
      }

      // A real agent adopts the parent's directory and ID space while writing
      // its JSONL under that directory, not under a matching child sidecar.
      child = SessionManager.create(cwd, parentArtifactDir);
      child.adoptArtifactManager(parentArtifactManager);
      child.appendMessage({ role: "user", content: "Child inherited artifact://0", timestamp: Date.now() });
      await child.ensureOnDisk();
      const childFile = child.getSessionFile();
      if (!childFile) throw new Error("expected persisted child JSONL");
      expect(path.dirname(childFile)).toBe(parentArtifactDir);
      expect(child.getArtifactsDir()).toBe(parentArtifactDir);
      expect(await child.getArtifactPath("0")).toBe(parentArtifactPath);
      const childSidecar = childFile.slice(0, -".jsonl".length);
      const parentBefore = await fs.readFile(parentFile, "utf8");
      const childBefore = await fs.readFile(childFile, "utf8");
      const childId = child.getSessionId();
      const originalNames = (await fs.readdir(parentArtifactDir)).sort();

      // Missing child sidecar must not cause a successful fork that loses the
      // still-valid parent reference, or leave a reservation after refusal.
      expect(await Bun.file(childSidecar).exists()).toBe(false);
      await expect(child.fork()).rejects.toThrow(/adopted artifact scope.*session sidecar/i);
      expect(child.getSessionFile()).toBe(childFile);
      expect(child.getSessionId()).toBe(childId);
      expect((await fs.readdir(parentArtifactDir)).sort()).toEqual(originalNames);
      expect(await fs.readFile(parentFile, "utf8")).toBe(parentBefore);
      expect(await fs.readFile(childFile, "utf8")).toBe(childBefore);
      expect(await fs.readFile(parentArtifactPath, "utf8")).toBe(parentEvidence);

      // More dangerous twin: the child's independent sidecar *does* contain
      // artifact ID 0 but its bytes are unrelated to the adopted parent owner.
      // A self-consistent copy + SHA-256 of those stale bytes is still wrong.
      await fs.mkdir(childSidecar);
      const stalePath = path.join(childSidecar, "0.bash.log");
      await fs.writeFile(stalePath, staleEvidence);
      const namesWithStaleSidecar = (await fs.readdir(parentArtifactDir)).sort();
      await expect(child.fork()).rejects.toThrow(/adopted artifact scope.*session sidecar/i);
      expect(child.getSessionFile()).toBe(childFile);
      expect(child.getSessionId()).toBe(childId);
      expect((await fs.readdir(parentArtifactDir)).sort()).toEqual(namesWithStaleSidecar);
      expect(await fs.readFile(parentFile, "utf8")).toBe(parentBefore);
      expect(await fs.readFile(childFile, "utf8")).toBe(childBefore);
      expect(await fs.readFile(parentArtifactPath, "utf8")).toBe(parentEvidence);
      expect(await fs.readFile(stalePath, "utf8")).toBe(staleEvidence);
      expect(await child.getArtifactPath("0")).toBe(parentArtifactPath);
    } finally {
      await child?.close();
      await parent.close();
    }
  });

  it("copies the original evidence before switching and keeps the next artifact ID distinct", async () => {
    using temp = TempDir.createSync("@veyyon-fork-archive-");
    const manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
    try {
      const id = await manager.saveArtifact(originalBytes, "bash");
      expect(id).toBe("0");
      manager.appendMessage({
        role: "user", content: "Restore the recorded [full output](artifact://0)", timestamp: Date.now(),
      });
      await manager.ensureOnDisk();
      const sourceFile = manager.getSessionFile();
      if (!sourceFile) throw new Error("expected persistent source file");
      const sourceArtifact = await manager.getArtifactPath("0");
      if (!sourceArtifact) throw new Error("expected original artifact path");

      const fork = await manager.fork();
      if (!fork) throw new Error("expected persistent fork");
      expect(fork.oldSessionFile).toBe(sourceFile);
      expect(fork.newSessionFile).not.toBe(sourceFile);
      expect(manager.getSessionFile()).toBe(fork.newSessionFile);
      expect(await readSaved(manager, "0")).toBe(originalBytes);
      expect(await fs.readFile(sourceArtifact, "utf8")).toBe(originalBytes);

      const nextId = await manager.saveArtifact("new unrelated output", "bash");
      expect(nextId).toBe("1");
      expect(await readSaved(manager, "0")).toBe(originalBytes);
      expect(await readSaved(manager, "1")).toBe("new unrelated output");
      expect(await fs.readFile(sourceArtifact, "utf8")).toBe(originalBytes);
    } finally {
      await manager.close();
    }
  });

  it("refuses to switch when an inherited artifact is missing, leaving the original recoverable", async () => {
    using temp = TempDir.createSync("@veyyon-fork-archive-missing-");
    const manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
    try {
      const id = await manager.saveArtifact(originalBytes, "bash");
      expect(id).toBe("0");
      manager.appendMessage({
        role: "user", content: "Recorded evidence: artifact://0", timestamp: Date.now(),
      });
      await manager.ensureOnDisk();
      const sessionFile = manager.getSessionFile();
      if (!sessionFile) throw new Error("expected persistent source file");
      const sessionId = manager.getSessionId();
      const fileBefore = await fs.readFile(sessionFile, "utf8");
      const oldDir = sessionFile.slice(0, -6);
      const parkedDir = path.join(temp.path(), "unavailable-original-artifacts");
      await fs.rename(oldDir, parkedDir);
      try {
        await expect(manager.fork()).rejects.toThrow(/artifact.*(missing|unavailable)/i);
        expect(manager.getSessionFile()).toBe(sessionFile);
        expect(manager.getSessionId()).toBe(sessionId);
        expect(await fs.readFile(sessionFile, "utf8")).toBe(fileBefore);
        expect(await fs.readFile(path.join(parkedDir, "0.bash.log"), "utf8")).toBe(originalBytes);
      } finally {
        await fs.rename(parkedDir, oldDir);
      }
      expect(await readSaved(manager, "0")).toBe(originalBytes);
    } finally {
      await manager.close();
    }
  });

  it("refuses a same-length but byte-corrupted copied artifact and retries without losing source evidence", async () => {
    using temp = TempDir.createSync("@veyyon-fork-copy-content-mismatch-");
    const manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
    try {
      expect(await manager.saveArtifact(originalBytes, "bash")).toBe("0");
      const message = "Inherited audit evidence: artifact://0";
      manager.appendMessage({ role: "user", content: message, timestamp: Date.now() });
      await manager.ensureOnDisk();
      const sourceFile = manager.getSessionFile();
      if (!sourceFile) throw new Error("expected original session file");
      const sourceId = manager.getSessionId();
      const sourceJsonl = await fs.readFile(sourceFile, "utf8");
      const sourceArtifact = await manager.getArtifactPath("0");
      if (!sourceArtifact) throw new Error("expected original artifact file");
      const originalCopy = nodeFs.promises.cp.bind(nodeFs.promises);
      const changedBytes = "x".repeat(Buffer.byteLength(originalBytes, "utf8"));
      expect(Buffer.byteLength(changedBytes, "utf8")).toBe(Buffer.byteLength(originalBytes, "utf8"));
      expect(changedBytes).not.toBe(originalBytes);

      // Model a storage-side same-size corruption after the genuine directory
      // copy: length and regular-file checks alone cannot detect this.
      const cpSpy = spyOn(nodeFs.promises, "cp").mockImplementation(async (source, destination, options) => {
        await originalCopy(source, destination, options);
        const sourcePath = typeof source === "string" ? source : fileURLToPath(source);
        const destPath = typeof destination === "string" ? destination : fileURLToPath(destination);
        if (sourcePath === sourceArtifact) {
          await fs.writeFile(destPath, changedBytes);
        }
      });
      try {
        await expect(manager.fork()).rejects.toThrow(/referenced artifact.*(bytes|content).*differ/i);
      } finally {
        cpSpy.mockRestore();
      }

      expect(manager.getSessionFile()).toBe(sourceFile);
      expect(manager.getSessionId()).toBe(sourceId);
      expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceJsonl);
      expect(await fs.readFile(sourceArtifact, "utf8")).toBe(originalBytes);

      // Clean retry must still preserve the complete original output, and
      // the next new output must never reuse inherited artifact ID zero.
      const result = await manager.fork();
      if (!result) throw new Error("expected successful retry");
      expect(result.oldSessionFile).toBe(sourceFile);
      expect(result.newSessionFile).not.toBe(sourceFile);
      expect(await readSaved(manager, "0")).toBe(originalBytes);
      expect(await manager.saveArtifact("new independent output", "bash")).toBe("1");
      expect(await readSaved(manager, "0")).toBe(originalBytes);
      expect(await fs.readFile(sourceArtifact, "utf8")).toBe(originalBytes);
      expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceJsonl);
    } finally {
      await manager.close();
    }
  });

  it("rejects same-length corruption of unreferenced nested evidence before publishing a fork", async () => {
    using temp = TempDir.createSync("@veyyon-fork-unreferenced-nested-copy-");
    const manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
    try {
      expect(await manager.saveArtifact(originalBytes, "bash")).toBe("0");
      manager.appendMessage({
        role: "user", content: "Original referenced evidence: artifact://0", timestamp: Date.now(),
      });
      await manager.ensureOnDisk();
      const sourceFile = manager.getSessionFile();
      if (!sourceFile) throw new Error("expected persisted original session");
      const sourceId = manager.getSessionId();
      const sourceJsonl = await fs.readFile(sourceFile, "utf8");
      const sourceArtifact = await manager.getArtifactPath("0");
      if (!sourceArtifact) throw new Error("expected original artifact");
      const sourceDir = path.dirname(sourceArtifact);
      const nestedDir = path.join(sourceDir, "unreferenced-notes");
      const nestedOriginal = "SYNTHETIC NESTED EVIDENCE";
      await fs.mkdir(nestedDir);
      const nestedPath = path.join(nestedDir, "audit.log");
      await fs.writeFile(nestedPath, nestedOriginal);
      const alteredBytes = "x".repeat(Buffer.byteLength(nestedOriginal, "utf8"));
      expect(Buffer.byteLength(alteredBytes, "utf8")).toBe(Buffer.byteLength(nestedOriginal, "utf8"));

      const genuineCopy = nodeFs.promises.cp.bind(nodeFs.promises);
      const copySpy = spyOn(nodeFs.promises, "cp").mockImplementation(async (source, destination, options) => {
        await genuineCopy(source, destination, options);
        const sourcePath = typeof source === "string" ? source : fileURLToPath(source);
        const destPath = typeof destination === "string" ? destination : fileURLToPath(destination);
        if (sourcePath === nestedDir) {
          await fs.writeFile(path.join(destPath, "audit.log"), alteredBytes);
        }
      });
      try {
        await expect(manager.fork()).rejects.toThrow(/unreferenced artifact bytes differ from source/i);
      } finally {
        copySpy.mockRestore();
      }
      expect(manager.getSessionFile()).toBe(sourceFile);
      expect(manager.getSessionId()).toBe(sourceId);
      expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceJsonl);
      expect(await fs.readFile(sourceArtifact, "utf8")).toBe(originalBytes);
      expect(await fs.readFile(nestedPath, "utf8")).toBe(nestedOriginal);

      const fork = await manager.fork();
      if (!fork) throw new Error("expected successful clean retry");
      const copiedDir = fork.newSessionFile.slice(0, -".jsonl".length);
      expect(await fs.readFile(path.join(copiedDir, "unreferenced-notes", "audit.log"), "utf8")).toBe(nestedOriginal);
      expect(await readSaved(manager, "0")).toBe(originalBytes);
      expect(await manager.saveArtifact("later independent output", "bash")).toBe("1");
      expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceJsonl);
    } finally {
      await manager.close();
    }
  });

  it("rejects missing or extra unreferenced nested files in a fork copy without losing the source", async () => {
    for (const fault of ["missing", "extra"] as const) {
      using temp = TempDir.createSync("@veyyon-fork-nested-inventory-");
      const manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
      try {
        expect(await manager.saveArtifact(originalBytes, "bash")).toBe("0");
        manager.appendMessage({
          role: "user", content: "Referenced recovery data: artifact://0", timestamp: Date.now(),
        });
        await manager.ensureOnDisk();
        const sourceFile = manager.getSessionFile();
        if (!sourceFile) throw new Error("expected persisted source session");
        const sourceId = manager.getSessionId();
        const sourceJsonl = await fs.readFile(sourceFile, "utf8");
        const sourceArtifact = await manager.getArtifactPath("0");
        if (!sourceArtifact) throw new Error("expected source artifact file");
        const sourceDir = path.dirname(sourceArtifact);
        const sourceNotes = path.join(sourceDir, "unreferenced-notes");
        const nestedOriginal = "SYNTHETIC PRESERVED NESTED EVIDENCE";
        await fs.mkdir(sourceNotes);
        await fs.writeFile(path.join(sourceNotes, "audit.log"), nestedOriginal);

        const genuineCopy = nodeFs.promises.cp.bind(nodeFs.promises);
        const copySpy = spyOn(nodeFs.promises, "cp").mockImplementation(async (source, destination, options) => {
          await genuineCopy(source, destination, options);
          const sourcePath = typeof source === "string" ? source : fileURLToPath(source);
          const destPath = typeof destination === "string" ? destination : fileURLToPath(destination);
          if (sourcePath !== sourceNotes) return;
          const copiedNotes = destPath;
          if (fault === "missing") await fs.unlink(path.join(copiedNotes, "audit.log"));
          else await fs.writeFile(path.join(copiedNotes, "extra.log"), "SYNTHETIC UNEXPECTED FILE");
        });
        try {
          await expect(manager.fork()).rejects.toThrow(/artifact copy incomplete/i);
        } finally {
          copySpy.mockRestore();
        }
        expect(manager.getSessionId()).toBe(sourceId);
        expect(manager.getSessionFile()).toBe(sourceFile);
        expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceJsonl);
        expect(await fs.readFile(sourceArtifact, "utf8")).toBe(originalBytes);
        expect(await fs.readFile(path.join(sourceNotes, "audit.log"), "utf8")).toBe(nestedOriginal);

        const fork = await manager.fork();
        if (!fork) throw new Error("expected successful clean retry");
        const copiedNotes = path.join(fork.newSessionFile.slice(0, -".jsonl".length), "unreferenced-notes");
        expect(await fs.readdir(copiedNotes)).toEqual(["audit.log"]);
        expect(await fs.readFile(path.join(copiedNotes, "audit.log"), "utf8")).toBe(nestedOriginal);
        expect(await readSaved(manager, "0")).toBe(originalBytes);
        expect(await manager.saveArtifact("new independent output", "bash")).toBe("1");
        expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceJsonl);
      } finally {
        await manager.close();
      }
    }
  });

  it("refuses to propagate unrelated artifact symlinks before a fork publishes history", async () => {
    using temp = TempDir.createSync("@veyyon-fork-symlink-boundary-");
    const manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
    try {
      const original = "synthetic safe recovery evidence";
      expect(await manager.saveArtifact(original, "bash")).toBe("0");
      manager.appendMessage({
        role: "user", content: "Keep evidence artifact://0", timestamp: Date.now(),
      });
      await manager.ensureOnDisk();
      const sourceFile = manager.getSessionFile();
      if (!sourceFile) throw new Error("expected original source session");
      const sourceId = manager.getSessionId();
      const sourceBytes = await fs.readFile(sourceFile, "utf8");
      const sourceArtifact = await manager.getArtifactPath("0");
      if (!sourceArtifact) throw new Error("expected real local artifact");
      const sourceDir = path.dirname(sourceArtifact);
      const outside = path.join(temp.path(), "synthetic-outside-store.txt");
      const outsideBytes = "SYNTHETIC OUTSIDE STORE: never copied to a fork";
      await fs.writeFile(outside, outsideBytes);
      const directLink = path.join(sourceDir, "77.extra.log");
      const reservationDir = path.join(sourceDir, "unused-reservations");
      await fs.mkdir(reservationDir);
      const nestedLink = path.join(reservationDir, "78.extra.log");
      await fs.symlink(outside, directLink, "file");
      await fs.symlink(outside, nestedLink, "file");
      const beforeInventory = (await fs.readdir(path.dirname(sourceFile))).sort();

      // The unreferenced artifact://77 link must not be inherited just because
      // a different, legitimate artifact://0 was referenced in the transcript.
      await expect(manager.fork()).rejects.toThrow(/unsafe artifact (entry|tree)/i);
      expect(manager.getSessionId()).toBe(sourceId);
      expect(manager.getSessionFile()).toBe(sourceFile);
      expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBytes);
      expect((await fs.readdir(path.dirname(sourceFile))).sort()).toEqual(beforeInventory);
      expect((await fs.lstat(directLink)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(outside, "utf8")).toBe(outsideBytes);

      await fs.unlink(directLink);
      // Valid empty directories may be retained, but symlinks inside them
      // must be refused just as symlinks at the artifact root are.
      await expect(manager.fork()).rejects.toThrow(/unsafe artifact (entry|tree)/i);
      expect(manager.getSessionId()).toBe(sourceId);
      expect(manager.getSessionFile()).toBe(sourceFile);
      expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBytes);
      expect(await fs.readFile(outside, "utf8")).toBe(outsideBytes);

      await fs.unlink(nestedLink);
      const fork = await manager.fork();
      if (!fork) throw new Error("expected safe evidence-preserving fork");
      const destinationDir = fork.newSessionFile.slice(0, -".jsonl".length);
      expect(await fs.readFile(path.join(destinationDir, "0.bash.log"), "utf8")).toBe(original);
      expect((await fs.stat(path.join(destinationDir, "unused-reservations"))).isDirectory()).toBe(true);
      expect((await fs.readdir(destinationDir)).some(name => name.startsWith("77."))).toBe(false);
      expect(await manager.saveArtifact("new independent output", "bash")).toBe("1");
      expect(await fs.readFile(sourceArtifact, "utf8")).toBe(original);
      expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBytes);
      expect(await fs.readFile(outside, "utf8")).toBe(outsideBytes);
    } finally {
      await manager.close();
    }
  });


  it("refuses unreferenced hard links in source and destination without changing the original session", async () => {
    using temp = TempDir.createSync("@veyyon-fork-hardlink-boundary-");
    const manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
    try {
      const original = "synthetic inherited evidence";
      expect(await manager.saveArtifact(original, "bash")).toBe("0");
      manager.appendMessage({ role: "user", content: "Keep artifact://0", timestamp: Date.now() });
      await manager.ensureOnDisk();
      const sourceFile = manager.getSessionFile();
      if (!sourceFile) throw new Error("expected durable source session");
      const sourceId = manager.getSessionId();
      const sourceBytes = await fs.readFile(sourceFile, "utf8");
      const sourceArtifact = await manager.getArtifactPath("0");
      if (!sourceArtifact) throw new Error("expected source artifact");
      const artifactDir = path.dirname(sourceArtifact);
      const outside = path.join(temp.path(), "outside-synthetic.txt");
      const outsideBytes = "unrelated synthetic bytes";
      await fs.writeFile(outside, outsideBytes);
      const nestedDir = path.join(artifactDir, "unreferenced");
      await fs.mkdir(nestedDir);

      for (const link of [
        path.join(artifactDir, "77.unreferenced.log"),
        path.join(nestedDir, "78.unreferenced.log"),
      ]) {
        await fs.link(outside, link);
        try {
          const stat = await fs.lstat(link);
          expect(stat.isFile()).toBe(true);
          expect(stat.isSymbolicLink()).toBe(false);
          expect(stat.nlink).toBeGreaterThan(1);
          await expect(manager.fork()).rejects.toThrow(/unsafe artifact entry/i);
          expect(manager.getSessionId()).toBe(sourceId);
          expect(manager.getSessionFile()).toBe(sourceFile);
          expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBytes);
          expect(await fs.readFile(sourceArtifact, "utf8")).toBe(original);
          expect(await fs.readFile(outside, "utf8")).toBe(outsideBytes);
        } finally {
          await fs.unlink(link);
        }
      }

      // A hard link added after the genuine copy must fail destination validation too.
      const originalCp = nodeFs.promises.cp.bind(nodeFs.promises);
      let linked = false;
      const copySpy = spyOn(nodeFs.promises, "cp").mockImplementation(async (src, dst, options) => {
        await originalCp(src, dst, options);
        const srcPath = typeof src === "string" ? src : fileURLToPath(src);
        const dstPath = typeof dst === "string" ? dst : fileURLToPath(dst);
        if (!linked && path.dirname(srcPath) === artifactDir) {
          linked = true;
          await fs.link(outside, path.join(path.dirname(dstPath), "79.unreferenced.log"));
        }
      });
      try {
        await expect(manager.fork()).rejects.toThrow(/unsafe artifact entry/i);
      } finally {
        copySpy.mockRestore();
      }
      expect(manager.getSessionId()).toBe(sourceId);
      expect(manager.getSessionFile()).toBe(sourceFile);
      expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBytes);
      expect(await fs.readFile(outside, "utf8")).toBe(outsideBytes);

      const fork = await manager.fork();
      if (!fork) throw new Error("expected clean successful retry");
      const copied = path.join(fork.newSessionFile.slice(0, -".jsonl".length), path.basename(sourceArtifact));
      expect(await fs.readFile(copied, "utf8")).toBe(original);
      expect(await fs.readFile(sourceArtifact, "utf8")).toBe(original);
      expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBytes);
      expect(await manager.saveArtifact("new independent output", "bash")).toBe("1");
    } finally {
      await manager.close();
    }
  });

  it("refuses equal-byte parent-directory swaps in source and copied fork evidence", async () => {
    for (const side of ["source", "destination"] as const) {
      using temp = TempDir.createSync(`@veyyon-fork-parent-swap-${side}-`);
      const manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
      try {
        const original = "synthetic root recovery evidence";
        const nestedBytes = "synthetic nested recovery evidence";
        expect(await manager.saveArtifact(original, "bash")).toBe("0");
        manager.appendMessage({ role: "user", content: "Keep artifact://0", timestamp: Date.now() });
        await manager.ensureOnDisk();
        const sourceFile = manager.getSessionFile();
        if (!sourceFile) throw new Error("expected durable source session");
        const sourceId = manager.getSessionId();
        const sourceBytes = await fs.readFile(sourceFile, "utf8");
        const sourceArtifact = await manager.getArtifactPath("0");
        if (!sourceArtifact) throw new Error("expected source artifact");
        const sourceDir = path.dirname(sourceArtifact);
        const sourceNestedDir = path.join(sourceDir, "nested");
        const sourceNestedFile = path.join(sourceNestedDir, "trace.txt");
        await fs.mkdir(sourceNestedDir);
        await fs.writeFile(sourceNestedFile, nestedBytes);
        const outsideDir = path.join(temp.path(), "unrelated-synthetic-directory");
        await fs.mkdir(outsideDir);
        await fs.writeFile(path.join(outsideDir, "trace.txt"), nestedBytes);

        const realCopy = nodeFs.promises.cp.bind(nodeFs.promises);
        const realLstat = nodeFs.promises.lstat.bind(nodeFs.promises);
        let copiedDir: string | undefined;
        let swappedDir: string | undefined;
        const copySpy = spyOn(nodeFs.promises, "cp").mockImplementation(async (src, dst, options) => {
          await realCopy(src, dst, options);
          const srcPath = typeof src === "string" ? src : fileURLToPath(src);
          const dstPath = typeof dst === "string" ? dst : fileURLToPath(dst);
          if (path.dirname(srcPath) === sourceDir) copiedDir = path.dirname(dstPath);
        });
        async function statMock(target: nodeFs.PathLike, opts?: (nodeFs.StatOptions & { bigint?: false }) | undefined): Promise<nodeFs.Stats>;
        async function statMock(target: nodeFs.PathLike, opts: nodeFs.StatOptions & { bigint: true }): Promise<nodeFs.BigIntStats>;
        async function statMock(target: nodeFs.PathLike, opts?: nodeFs.StatOptions | undefined): Promise<nodeFs.Stats | nodeFs.BigIntStats>;
        async function statMock(target: nodeFs.PathLike, opts?: nodeFs.StatOptions | undefined): Promise<nodeFs.Stats | nodeFs.BigIntStats> {
          const leaf = side === "source"
            ? sourceNestedFile
            : copiedDir && path.join(copiedDir, "nested", "trace.txt");
          // The real copy has completed; substitute the ancestor exactly
          // before a leaf check could rebaseline an external equal-byte file.
          if (copiedDir && leaf && String(target) === leaf && !swappedDir) {
            const directory = path.dirname(leaf);
            await fs.rename(directory, `${directory}.parked`);
            await fs.symlink(outsideDir, directory, "dir");
            if (!(await realLstat(directory)).isSymbolicLink()) {
              throw new Error("synthetic parent symlink was not installed");
            }
            swappedDir = directory;
          }
          if (opts) return realLstat(target, opts);
          return realLstat(target);
        }
        const statSpy = spyOn(nodeFs.promises, "lstat").mockImplementation(statMock);
        try {
          await expect(manager.fork()).rejects.toThrow(
            /artifact changed during digest read|artifact directory changed during verification/i,
          );
        } finally {
          statSpy.mockRestore();
          copySpy.mockRestore();
          if (swappedDir) {
            await fs.unlink(swappedDir);
            await fs.rename(`${swappedDir}.parked`, swappedDir);
          }
        }
        expect(swappedDir).toBeDefined();
        expect(manager.getSessionId()).toBe(sourceId);
        expect(manager.getSessionFile()).toBe(sourceFile);
        expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBytes);
        expect(await fs.readFile(sourceNestedFile, "utf8")).toBe(nestedBytes);
        expect(await fs.readFile(path.join(outsideDir, "trace.txt"), "utf8")).toBe(nestedBytes);
        expect(await fs.readFile(sourceArtifact, "utf8")).toBe(original);

        const clean = await manager.fork();
        if (!clean) throw new Error("expected successful clean retry");
        const destinationDir = clean.newSessionFile.slice(0, -".jsonl".length);
        expect(await fs.readFile(path.join(destinationDir, "nested", "trace.txt"), "utf8")).toBe(nestedBytes);
        expect(await fs.readFile(path.join(destinationDir, "0.bash.log"), "utf8")).toBe(original);
        expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBytes);
      } finally {
        await manager.close();
      }
    }
  });

  it("refuses a substituted file descriptor at the fork artifact hash boundary", async () => {
    using temp = TempDir.createSync("@veyyon-fork-digest-open-");
    const manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
    try {
      const original = "SYNTHETIC PRESERVED RECOVERY OUTPUT";
      expect(await manager.saveArtifact(original, "bash")).toBe("0");
      manager.appendMessage({ role: "user", content: "Retain artifact://0", timestamp: Date.now() });
      await manager.ensureOnDisk();
      const sourceFile = manager.getSessionFile();
      if (!sourceFile) throw new Error("expected persistent source");
      const sourceId = manager.getSessionId();
      const sourceBytes = await fs.readFile(sourceFile, "utf8");
      const sourceArtifact = await manager.getArtifactPath("0");
      if (!sourceArtifact) throw new Error("expected source artifact");

      const unrelatedSingle = path.join(temp.path(), "other-regular.txt");
      const unrelatedLinked = path.join(temp.path(), "other-linked.txt");
      await fs.writeFile(unrelatedSingle, "X".repeat(original.length));
      await fs.writeFile(unrelatedLinked, "Y".repeat(original.length));
      await fs.link(unrelatedLinked, path.join(temp.path(), "other-linked-alias.txt"));
      const sourceStat = await fs.stat(sourceArtifact);
      const singleStat = await fs.stat(unrelatedSingle);
      // Some Windows filesystems report no stable inode; still run the
      // multiply-linked case, whose open-time nlink must be rejected.
      const candidates = [
        ...(sourceStat.dev !== singleStat.dev || sourceStat.ino !== singleStat.ino
          ? [unrelatedSingle] : []),
        unrelatedLinked,
      ];
      for (const unrelated of candidates) {
        const realCopy = nodeFs.promises.cp.bind(nodeFs.promises);
        const realOpen = nodeFs.promises.open.bind(nodeFs.promises);
        let copied = false;
        let substituted = false;
        const copySpy = spyOn(nodeFs.promises, "cp").mockImplementation(async (src, dst, options) => {
          await realCopy(src, dst, options);
          const srcPath = typeof src === "string" ? src : fileURLToPath(src);
          if (path.dirname(srcPath) === path.dirname(sourceArtifact)) copied = true;
        });
        const openSpy = spyOn(nodeFs.promises, "open").mockImplementation(async (file, flags, mode) => {
          if (copied && String(file) === sourceArtifact && !substituted) {
            substituted = true;
            return realOpen(unrelated, flags, mode);
          }
          return realOpen(file, flags, mode);
        });
        try {
          await expect(manager.fork()).rejects.toThrow(/artifact changed during digest read/i);
        } finally {
          openSpy.mockRestore();
          copySpy.mockRestore();
        }
        expect(copied).toBe(true);
        expect(substituted).toBe(true);
        expect(manager.getSessionId()).toBe(sourceId);
        expect(manager.getSessionFile()).toBe(sourceFile);
        expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBytes);
        expect(await fs.readFile(sourceArtifact, "utf8")).toBe(original);
        expect(await fs.readFile(unrelated, "utf8")).toBe(
          unrelated === unrelatedSingle ? "X".repeat(original.length) : "Y".repeat(original.length)
        );
      }

      const clean = await manager.fork();
      if (!clean) throw new Error("expected successful clean retry");
      const clonedArtifact = path.join(clean.newSessionFile.slice(0, -".jsonl".length), "0.bash.log");
      expect(await fs.readFile(clonedArtifact, "utf8")).toBe(original);
      expect(await fs.readFile(sourceArtifact, "utf8")).toBe(original);
      expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBytes);
      expect(await manager.saveArtifact("new independent output", "bash")).toBe("1");
    } finally {
      await manager.close();
    }
  });

  it("refuses a post-check symlink swap at the copied artifact digest open", async () => {
    using temp = TempDir.createSync("@veyyon-fork-hash-symlink-race-");
    const manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
    try {
      const original = "SYNTHETIC SOURCE EVIDENCE";
      expect(await manager.saveArtifact(original, "bash")).toBe("0");
      manager.appendMessage({ role: "user", content: "Retain artifact://0", timestamp: Date.now() });
      await manager.ensureOnDisk();
      const sourceFile = manager.getSessionFile();
      if (!sourceFile) throw new Error("expected durable source");
      const sourceId = manager.getSessionId();
      const sourceBytes = await fs.readFile(sourceFile, "utf8");
      const sourceArtifact = await manager.getArtifactPath("0");
      if (!sourceArtifact) throw new Error("expected local source artifact");
      const outside = path.join(temp.path(), "unrelated-synthetic.txt");
      // Matching bytes make a pathname-following pre-fix hasher succeed: the
      // violation is following an unrelated symlink, not a digest mismatch.
      const outsideBytes = original;
      await fs.writeFile(outside, outsideBytes);

      const realCopy = nodeFs.promises.cp.bind(nodeFs.promises);
      const realOpen = nodeFs.promises.open.bind(nodeFs.promises);
      let copiedPath: string | undefined;
      let swapped = false;
      const copySpy = spyOn(nodeFs.promises, "cp").mockImplementation(async (src, dst, options) => {
        await realCopy(src, dst, options);
        const srcPath = typeof src === "string" ? src : fileURLToPath(src);
        const dstPath = typeof dst === "string" ? dst : fileURLToPath(dst);
        if (srcPath === sourceArtifact) copiedPath = dstPath;
      });
      // The source and destination have both passed inventory/size checks.
      // Replace only the copied file just before its hash-open, not the real
      // source file or the unrelated synthetic target.
      const openSpy = spyOn(nodeFs.promises, "open").mockImplementation(async (file, flags, mode) => {
        if (copiedPath && String(file) === copiedPath && !swapped) {
          await fs.rename(copiedPath, copiedPath + ".parked");
          await fs.symlink(outside, copiedPath, "file");
          // A filesystem that rejects symlink creation must fail this test,
          // not pass by throwing before the prohibited link was installed.
          swapped = (await fs.lstat(copiedPath)).isSymbolicLink();
          if (!swapped) throw new Error("synthetic symlink substitution was not installed");
        }
        return realOpen(file, flags, mode);
      });
      try {
        // A fixture/permissions error is not evidence that the fork's
        // production descriptor guard rejected the injected symlink.
        await expect(manager.fork()).rejects.toThrow(/artifact changed during digest read|ELOOP/);
      } finally {
        openSpy.mockRestore();
        copySpy.mockRestore();
      }
      expect(swapped).toBe(true);
      expect(manager.getSessionId()).toBe(sourceId);
      expect(manager.getSessionFile()).toBe(sourceFile);
      expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBytes);
      expect(await fs.readFile(sourceArtifact, "utf8")).toBe(original);
      expect(await fs.readFile(outside, "utf8")).toBe(outsideBytes);

      const goodFork = await manager.fork();
      if (!goodFork) throw new Error("expected a clean retry");
      const copied = path.join(goodFork.newSessionFile.slice(0, -".jsonl".length), "0.bash.log");
      expect(await fs.readFile(copied, "utf8")).toBe(original);
      expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBytes);
    } finally {
      await manager.close();
    }
  });

  it("rejects an unreferenced link injected into the fork destination after copying", async () => {
    using temp = TempDir.createSync("@veyyon-fork-copy-link-injection-");
    const manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
    try {
      expect(await manager.saveArtifact("synthetic retained output", "bash")).toBe("0");
      manager.appendMessage({ role: "user", content: "Retain artifact://0", timestamp: Date.now() });
      await manager.ensureOnDisk();
      const sourceFile = manager.getSessionFile();
      if (!sourceFile) throw new Error("expected source session");
      const oldSessionId = manager.getSessionId();
      const sourceBytes = await fs.readFile(sourceFile, "utf8");
      const sourceArtifact = await manager.getArtifactPath("0");
      if (!sourceArtifact) throw new Error("expected source artifact");
      const outside = path.join(temp.path(), "synthetic-only-target.txt");
      const outsideBytes = "SYNTHETIC OUTSIDE SOURCE DATA";
      await fs.writeFile(outside, outsideBytes);

      // Exercise destination validation, not merely pre-copy source validation.
      const originalCp = nodeFs.promises.cp.bind(nodeFs.promises);
      let injected = false;
      const cpSpy = spyOn(nodeFs.promises, "cp").mockImplementation(async (source, destination, options) => {
        await originalCp(source, destination, options);
        const sourcePath = typeof source === "string" ? source : fileURLToPath(source);
        const destPath = typeof destination === "string" ? destination : fileURLToPath(destination);
        if (!injected && path.dirname(sourcePath) === path.dirname(sourceArtifact)) {
          injected = true;
          await fs.symlink(outside, path.join(path.dirname(destPath), "88.unreferenced.log"), "file");
        }
      });
      try {
        await expect(manager.fork()).rejects.toThrow(/unsafe artifact (entry|tree)/i);
      } finally {
        cpSpy.mockRestore();
      }
      expect(manager.getSessionId()).toBe(oldSessionId);
      expect(manager.getSessionFile()).toBe(sourceFile);
      expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBytes);
      expect(await fs.readFile(sourceArtifact, "utf8")).toBe("synthetic retained output");
      expect(await fs.readFile(outside, "utf8")).toBe(outsideBytes);

      const goodFork = await manager.fork();
      if (!goodFork) throw new Error("expected clean retry");
      const destinationDir = goodFork.newSessionFile.slice(0, -".jsonl".length);
      expect(await fs.readFile(path.join(destinationDir, "0.bash.log"), "utf8")).toBe("synthetic retained output");
      expect((await fs.readdir(destinationDir)).some(name => name.startsWith("88."))).toBe(false);
      expect(await manager.saveArtifact("later distinct output", "bash")).toBe("1");
      expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBytes);
    } finally {
      await manager.close();
    }
  });

  it("rejects a referenced symlink in forkFrom before publishing its new session", async () => {
    using temp = TempDir.createSync("@veyyon-forkfrom-referenced-symlink-");
    const cwd = path.join(temp.path(), "project");
    const sessions = path.join(temp.path(), "sessions");
    const source = SessionManager.create(cwd, sessions);
    try {
      expect(await source.saveArtifact("synthetic referenced bytes", "bash")).toBe("0");
      source.appendMessage({ role: "user", content: "Required artifact://0", timestamp: Date.now() });
      await source.ensureOnDisk();
      const sourceFile = source.getSessionFile();
      if (!sourceFile) throw new Error("expected original source session");
      const sourceBytes = await fs.readFile(sourceFile, "utf8");
      const sourceArtifact = await source.getArtifactPath("0");
      if (!sourceArtifact) throw new Error("expected original source artifact");
      const parked = path.join(temp.path(), "synthetic-original-artifact.txt");
      await fs.rename(sourceArtifact, parked);
      await fs.symlink(parked, sourceArtifact, "file");
      try {
        const beforeInventory = (await fs.readdir(sessions)).sort();
        await expect(SessionManager.forkFrom(sourceFile, cwd, sessions, undefined, {
          suppressBreadcrumb: true,
        })).rejects.toThrow(/unsafe artifact entry/i);
        expect((await fs.readdir(sessions)).sort()).toEqual(beforeInventory);
        expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBytes);
        expect(await fs.readFile(parked, "utf8")).toBe("synthetic referenced bytes");
      } finally {
        await fs.unlink(sourceArtifact);
        await fs.rename(parked, sourceArtifact);
      }
    } finally {
      await source.close();
    }
  });

  it("refuses a referenced artifact that became a directory without changing the original session", async () => {
    using temp = TempDir.createSync("@veyyon-fork-invalid-artifact-");
    const manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
    try {
      const id = await manager.saveArtifact(originalBytes, "bash");
      expect(id).toBe("0");
      manager.appendMessage({
        role: "user", content: "Recorded evidence: artifact://0", timestamp: Date.now(),
      });
      await manager.ensureOnDisk();
      const sourceFile = manager.getSessionFile();
      if (!sourceFile) throw new Error("expected persistent source file");
      const oldSessionId = manager.getSessionId();
      const sourceBefore = await fs.readFile(sourceFile, "utf8");
      const originalPath = await manager.getArtifactPath("0");
      if (!originalPath) throw new Error("expected original artifact");
      const parkedFile = path.join(temp.path(), "safe-original-artifact.txt");
      await fs.rename(originalPath, parkedFile);
      await fs.mkdir(originalPath);
      try {
        await expect(manager.fork()).rejects.toThrow(/referenced artifact|not a directory/i);
        expect(manager.getSessionFile()).toBe(sourceFile);
        expect(manager.getSessionId()).toBe(oldSessionId);
        expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBefore);
        expect(await fs.readFile(parkedFile, "utf8")).toBe(originalBytes);
      } finally {
        await fs.rmdir(originalPath);
        await fs.rename(parkedFile, originalPath);
      }
      expect(await readSaved(manager, "0")).toBe(originalBytes);
    } finally {
      await manager.close();
    }
  });

  it("keeps an explicit foreign-session artifact reference unchanged without requiring local files", async () => {
    using temp = TempDir.createSync("@veyyon-fork-foreign-artifact-");
    const manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
    try {
      const sourceId = manager.getSessionId();
      const foreignId = "different-execution-session";
      expect(sourceId).not.toBe(foreignId);
      const foreignLink = `artifact://0?view=metadata&session=${foreignId}`;
      const message = `Inspect the original evidence: ${foreignLink}`;
      manager.appendMessage({ role: "user", content: message, timestamp: Date.now() });
      await manager.ensureOnDisk();
      const sourceFile = manager.getSessionFile();
      if (!sourceFile) throw new Error("expected persistent source file");
      const sourceText = await fs.readFile(sourceFile, "utf8");

      const result = await manager.fork();
      if (!result) throw new Error("expected persistent fork");
      expect(result.oldSessionFile).toBe(sourceFile);
      expect(manager.getSessionFile()).toBe(result.newSessionFile);
      expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceText);
      expect(manager.getEntries().some(entry =>
        entry.type === "message" && entry.message.role === "user" && entry.message.content === message
      )).toBe(true);
      // The foreign reference is explicitly pinned to another session, even if
      // this otherwise empty fork allocates a local artifact with the same ID.
      expect(await manager.saveArtifact("new local evidence", "bash")).toBe("0");
      expect(manager.getEntries().some(entry =>
        entry.type === "message" && entry.message.role === "user" && entry.message.content === message
      )).toBe(true);
    } finally {
      await manager.close();
    }
  });

  it("refuses a missing artifact explicitly scoped to the source session before switching", async () => {
    using temp = TempDir.createSync("@veyyon-fork-current-artifact-missing-");
    const manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
    try {
      const sourceId = manager.getSessionId();
      const localLink = `artifact://0?session=${sourceId}`;
      manager.appendMessage({ role: "user", content: `Retain ${localLink}`, timestamp: Date.now() });
      await manager.ensureOnDisk();
      const sourceFile = manager.getSessionFile();
      if (!sourceFile) throw new Error("expected persistent source file");
      const sourceText = await fs.readFile(sourceFile, "utf8");

      await expect(manager.fork()).rejects.toThrow(/referenced artifacts unavailable/i);
      expect(manager.getSessionId()).toBe(sourceId);
      expect(manager.getSessionFile()).toBe(sourceFile);
      expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceText);
    } finally {
      await manager.close();
    }
  });

  it("does not mistake malformed artifact hosts for missing local evidence", async () => {
    // The protocol only accepts complete numeric hosts. A numeric prefix in
    // ordinary text must not make an artifact-free session impossible to fork.
    for (const malformed of [
      "artifact://0abc",
      "artifact://123abc?session=another-execution",
      "artifact://0-bad",
      "artifact://0.example",
      "artifact://0:80",
      "artifact://0!x",
      "artifact://0$x",
      "artifact://0,foo",
      "artifact://0;foo",
    ]) {
      using temp = TempDir.createSync("@veyyon-fork-malformed-artifact-");
      const manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
      try {
        const message = `Example of an invalid URL: ${malformed}`;
        manager.appendMessage({ role: "user", content: message, timestamp: Date.now() });
        await manager.ensureOnDisk();
        const sourceFile = manager.getSessionFile();
        if (!sourceFile) throw new Error("expected source session file");
        const sourceId = manager.getSessionId();
        const original = await fs.readFile(sourceFile, "utf8");

        const fork = await manager.fork();
        if (!fork) throw new Error("expected fork for artifact-free session");
        expect(fork.oldSessionFile).toBe(sourceFile);
        expect(fork.newSessionFile).not.toBe(sourceFile);
        expect(manager.getSessionId()).not.toBe(sourceId);
        expect(await fs.readFile(sourceFile, "utf8")).toBe(original);
        expect(manager.getEntries().some(entry =>
          entry.type === "message" && entry.message.role === "user" && entry.message.content === message
        )).toBe(true);
      } finally {
        await manager.close();
      }
    }
  });

  it("preserves decoded numeric artifact hosts before switching a live session fork", async () => {
    for (const variant of ["artifact://%30", "ArTiFaCt://%30", "local-session"]) {
      using temp = TempDir.createSync("@veyyon-fork-encoded-host-");
      const manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
      try {
        const link = variant === "local-session"
          ? `artifact://%30?session=${manager.getSessionId()}`
          : variant;
        expect(await manager.saveArtifact(originalBytes, "bash")).toBe("0");
        manager.appendMessage({ role: "user", content: `Original evidence: ${link}`, timestamp: Date.now() });
        await manager.ensureOnDisk();
        const sourceFile = manager.getSessionFile();
        if (!sourceFile) throw new Error("expected persisted source session");
        const sourceId = manager.getSessionId();
        const sourceBefore = await fs.readFile(sourceFile, "utf8");
        const oldDir = sourceFile.slice(0, -".jsonl".length);
        const parked = path.join(temp.path(), "parked-original-artifacts");
        await fs.rename(oldDir, parked);
        try {
          await expect(manager.fork()).rejects.toThrow(/referenced artifacts unavailable/i);
          expect(manager.getSessionFile()).toBe(sourceFile);
          expect(manager.getSessionId()).toBe(sourceId);
          expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBefore);
          expect(await fs.readFile(path.join(parked, "0.bash.log"), "utf8")).toBe(originalBytes);
        } finally {
          await fs.rename(parked, oldDir);
        }

        const fork = await manager.fork();
        if (!fork) throw new Error("expected an evidence-preserving fork");
        expect(fork.oldSessionFile).toBe(sourceFile);
        expect(fork.newSessionFile).not.toBe(sourceFile);
        expect(await readSaved(manager, "0")).toBe(originalBytes);
        expect(await manager.saveArtifact("new unrelated output", "bash")).toBe("1");
        expect(await readSaved(manager, "0")).toBe(originalBytes);
        expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBefore);
      } finally {
        await manager.close();
      }
    }
  });

  it("forkFrom preserves decoded-host source artifacts and refuses missing originals", async () => {
    using temp = TempDir.createSync("@veyyon-forkfrom-encoded-host-");
    const cwd = path.join(temp.path(), "project");
    const sessions = path.join(temp.path(), "sessions");
    const source = SessionManager.create(cwd, sessions);
    let forked: SessionManager | undefined;
    try {
      expect(await source.saveArtifact(originalBytes, "bash")).toBe("0");
      const link = `artifact://%30?session=${source.getSessionId()}`;
      source.appendMessage({ role: "user", content: `Original evidence: ${link}`, timestamp: Date.now() });
      await source.ensureOnDisk();
      const sourceFile = source.getSessionFile();
      if (!sourceFile) throw new Error("expected persisted source session");
      const sourceBefore = await fs.readFile(sourceFile, "utf8");
      const oldDir = sourceFile.slice(0, -".jsonl".length);
      const parked = path.join(temp.path(), "parked-original-artifacts");
      await fs.rename(oldDir, parked);
      try {
        await expect(SessionManager.forkFrom(sourceFile, cwd, sessions, undefined, {
          suppressBreadcrumb: true,
        })).rejects.toThrow(/referenced artifacts unavailable/i);
        expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBefore);
        expect(await fs.readFile(path.join(parked, "0.bash.log"), "utf8")).toBe(originalBytes);
      } finally {
        await fs.rename(parked, oldDir);
      }

      forked = await SessionManager.forkFrom(sourceFile, cwd, sessions, undefined, {
        suppressBreadcrumb: true,
      });
      const inherited = await forked.getArtifactPath("0");
      if (!inherited) throw new Error("expected copied source artifact");
      expect(await fs.readFile(inherited, "utf8")).toBe(originalBytes);
      expect(await forked.saveArtifact("new unrelated output", "bash")).toBe("1");
      expect(await fs.readFile(inherited, "utf8")).toBe(originalBytes);
      expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBefore);
    } finally {
      await forked?.close();
      await source.close();
    }
  });

  it("does not reinterpret encoded foreign or invalid artifact hosts as local evidence", async () => {
    for (const link of [
      "artifact://%30?session=another-execution-session",
      "artifact://%30bad",
    ]) {
      using temp = TempDir.createSync("@veyyon-fork-encoded-foreign-");
      const manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
      try {
        manager.appendMessage({ role: "user", content: `Keep source URL: ${link}`, timestamp: Date.now() });
        await manager.ensureOnDisk();
        const sourceFile = manager.getSessionFile();
        if (!sourceFile) throw new Error("expected persisted source session");
        const sourceBefore = await fs.readFile(sourceFile, "utf8");
        const fork = await manager.fork();
        if (!fork) throw new Error("expected fork without local source artifacts");
        expect(fork.oldSessionFile).toBe(sourceFile);
        expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBefore);
        expect(await manager.saveArtifact("new unrelated local evidence", "bash")).toBe("0");
        expect(manager.getEntries().some(entry =>
          entry.type === "message" && entry.message.role === "user" &&
          entry.message.content === `Keep source URL: ${link}`
        )).toBe(true);
      } finally {
        await manager.close();
      }
    }
  });

  it("fails closed for missing local evidence with case-insensitive artifact schemes", async () => {
    for (const scheme of ["ARTIFACT", "ArTiFaCt"]) {
      using temp = TempDir.createSync("@veyyon-fork-artifact-scheme-");
      const manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
      try {
        manager.appendMessage({
          role: "user", content: `Preserve the recorded ${scheme}://0 evidence`, timestamp: Date.now(),
        });
        await manager.ensureOnDisk();
        const sourceFile = manager.getSessionFile();
        if (!sourceFile) throw new Error("expected source session file");
        const sourceId = manager.getSessionId();
        const original = await fs.readFile(sourceFile, "utf8");

        await expect(manager.fork()).rejects.toThrow(/referenced artifacts unavailable/i);
        expect(manager.getSessionFile()).toBe(sourceFile);
        expect(manager.getSessionId()).toBe(sourceId);
        expect(await fs.readFile(sourceFile, "utf8")).toBe(original);
      } finally {
        await manager.close();
      }
    }
  });

  it("preserves the permitted no-artifacts fork when no recovery references exist", async () => {
    using temp = TempDir.createSync("@veyyon-fork-empty-");
    const manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
    try {
      manager.appendMessage({ role: "user", content: "No archived artifacts", timestamp: Date.now() });
      await manager.ensureOnDisk();
      const oldFile = manager.getSessionFile();
      if (!oldFile) throw new Error("expected persistent source file");
      const fork = await manager.fork();
      if (!fork) throw new Error("expected successful artifact-free fork");
      expect(fork.oldSessionFile).toBe(oldFile);
      expect(fork.newSessionFile).not.toBe(oldFile);
      expect(manager.getEntries().some(e => e.type === "message" && e.message.role === "user")).toBe(true);
    } finally {
      await manager.close();
    }
  });
});

/** Inject a single synthetic new-JSONL publication refusal after fork preflight succeeds. */
class SyntheticForkJsonlRefusalStorage extends FileSessionStorage {
  protectedSourceFile: string | undefined;
  rejectNewSession = false;
  rejectSourceRepair = false;

  override async writeTextAtomic(
    target: string,
    body: SessionFileBody,
    options?: WriteTextAtomicOptions,
  ): Promise<void> {
    if (this.rejectNewSession && target !== this.protectedSourceFile) {
      throw new Error("synthetic new fork JSONL publication refusal");
    }
    if (this.rejectSourceRepair && target === this.protectedSourceFile) {
      throw new Error("synthetic original-source rollback refusal");
    }
    await super.writeTextAtomic(target, body, options);
  }
}


/** Fail a real source-writer close *after* the source lifecycle event was written. */
class SyntheticForkSourceCloseRefusalStorage extends FileSessionStorage {
  protectedSourceFile: string | undefined;
  rejectNextSourceClose = false;
  appendForeignLineOnRefusal: string | undefined;
  // Disposable raw bytes test strict failure handling before lossy UTF-8 decoding.
  appendForeignBytesOnRefusal: Buffer | undefined;
  // Deliberately prepend a real UTF-8 BOM to a disposable already-written journal.
  prependBomOnRefusal = false;
  // Test-only independent writer revises a previously owned line before the
  // strict source reread; the id and all other journal lines remain valid.
  rewriteOwnedRecordOnRefusal: "header" | "message" | "missing-message" | "foreign-before-header" | "foreign-between-owned" | undefined;
  reviseAbortedMarkerOnRefusal: "message" | "reason" | undefined;
  appendForeignLineBeforeRepairPublish: string | undefined;
  // Independent append after the storage's final synchronous publication guard,
  // inside the actual rename hook. This deliberately exposes the residual CAS gap.
  appendForeignLineAtRename: string | undefined;
  // Exercise a same-length independent edit after strict reread while a writer
  // preserves mtime. Only the source's change time exposes this version.
  rewriteOwnedTextAtGuard: { before: string; after: string } | undefined;
  pinSourceMtimeOnRefusal = false;
  // Synthetic peer append after synchronous strict source reread, before staging.
  appendForeignLineBeforeSyncRewrite: string | undefined;
  forceNextSourceAtomicEperm = false;
  // The other writer publishes a fresh journal at the vacated original path
  // while Windows-style EPERM fallback holds the old inode at a backup path.
  recreateJournalAfterMoveAside: string | undefined;
  // A fresh foreign target can also appear AFTER the initial absence check.
  recreateJournalOnRejectedGuard: string | undefined;
  recreateJournalOnFailedReplace: string | undefined;
  movedAsideJournalPath: string | undefined;
  // Synthetic-only seam; arm the read refusal after a failed writer close.
  refuseSourceReadOnClose = false;
  refuseNextSourceRead = false;

  override statSync(target: string) {
    if (
      target === this.movedAsideJournalPath &&
      this.recreateJournalOnRejectedGuard !== undefined &&
      this.protectedSourceFile !== undefined
    ) {
      const replacement = this.recreateJournalOnRejectedGuard;
      this.recreateJournalOnRejectedGuard = undefined;
      // The independent writer claims the original pathname while the version
      // guard detects a changed backup. Both histories must remain recoverable.
      nodeFs.writeFileSync(this.protectedSourceFile, replacement);
      nodeFs.appendFileSync(target, JSON.stringify({
        type: "message", id: "guard-rejected-foreign-tail", parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "Backup has an independent append", timestamp: Date.now() },
      }) + "\n");
    }
    return super.statSync(target);
  }

  override renameSync(source: string, target: string): void {
    if (target === this.protectedSourceFile && this.appendForeignLineAtRename) {
      const foreignLine = this.appendForeignLineAtRename;
      this.appendForeignLineAtRename = undefined;
      nodeFs.appendFileSync(target, foreignLine);
    }
    if (this.forceNextSourceAtomicEperm && target === this.protectedSourceFile) {
      this.forceNextSourceAtomicEperm = false;
      const error = new Error("synthetic Windows-style EPERM replacement refusal") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    }
    if (
      target === this.protectedSourceFile &&
      this.recreateJournalOnFailedReplace !== undefined &&
      this.movedAsideJournalPath !== undefined
    ) {
      const replacement = this.recreateJournalOnFailedReplace;
      this.recreateJournalOnFailedReplace = undefined;
      nodeFs.writeFileSync(target, replacement);
      const error = new Error("synthetic retry refused after foreign publication") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    }
    super.renameSync(source, target);
    if (
      source === this.protectedSourceFile &&
      (this.recreateJournalOnRejectedGuard !== undefined || this.recreateJournalOnFailedReplace !== undefined)
    ) {
      this.movedAsideJournalPath = target;
    }
    if (source === this.protectedSourceFile && this.recreateJournalAfterMoveAside !== undefined) {
      const replacement = this.recreateJournalAfterMoveAside;
      this.recreateJournalAfterMoveAside = undefined;
      this.movedAsideJournalPath = target;
      nodeFs.writeFileSync(source, replacement);
    }
  }

  override readText(target: string): Promise<string> {
    if (target === this.protectedSourceFile && this.refuseNextSourceRead) {
      this.refuseNextSourceRead = false;
      return Promise.reject(new Error("synthetic source journal read refusal"));
    }
    return super.readText(target);
  }

  override readTextStrict(target: string): Promise<string> {
    if (target === this.protectedSourceFile && this.refuseNextSourceRead) {
      this.refuseNextSourceRead = false;
      return Promise.reject(new Error("synthetic source journal read refusal"));
    }
    return super.readTextStrict(target);
  }

  private async appendForeignBeforeRepair(target: string): Promise<void> {
    if (target !== this.protectedSourceFile || !this.appendForeignLineBeforeRepairPublish) return;
    const foreignLine = this.appendForeignLineBeforeRepairPublish;
    this.appendForeignLineBeforeRepairPublish = undefined;
    await fs.appendFile(target, foreignLine);
  }

  override writeTextSync(target: string, body: SessionFileBody, options?: WriteTextAtomicOptions): void {
    if (target === this.protectedSourceFile && this.appendForeignLineBeforeSyncRewrite) {
      const line = this.appendForeignLineBeforeSyncRewrite;
      this.appendForeignLineBeforeSyncRewrite = undefined;
      nodeFs.appendFileSync(target, line);
    }
    super.writeTextSync(target, body, options);
  }

  private withSameSizePeerEdit(
    target: string, options?: WriteTextAtomicOptions,
  ): WriteTextAtomicOptions | undefined {
    const edit = this.rewriteOwnedTextAtGuard;
    if (!edit || target !== this.protectedSourceFile || !options?.commitGuard) return options;
    const originalGuard = options.commitGuard;
    return {
      ...options,
      commitGuard: sourcePath => {
        if (this.rewriteOwnedTextAtGuard === edit) {
          this.rewriteOwnedTextAtGuard = undefined;
          const original = nodeFs.readFileSync(target, "utf8");
          if (!original.includes(edit.before) ||
            Buffer.byteLength(edit.before) !== Buffer.byteLength(edit.after)) {
            throw new Error("expected same-sized disposable peer revision");
          }
          const previous = nodeFs.statSync(target);
          nodeFs.writeFileSync(target, original.replace(edit.before, edit.after));
          nodeFs.utimesSync(target, previous.atime, previous.mtime);
        }
        return originalGuard(sourcePath);
      },
    };
  }

  override async writeTextAtomic(
    target: string, body: SessionFileBody, options?: WriteTextAtomicOptions,
  ): Promise<void> {
    await this.appendForeignBeforeRepair(target);
    await super.writeTextAtomic(target, body, this.withSameSizePeerEdit(target, options));
  }

  override async rewriteTailAtomic(
    target: string, headBytes: number, keepBytes: number, head: string,
    tail: SessionFileBody, options?: WriteTextAtomicOptions,
  ): Promise<void> {
    await this.appendForeignBeforeRepair(target);
    await super.rewriteTailAtomic(target, headBytes, keepBytes, head, tail, this.withSameSizePeerEdit(target, options));
  }

  override openWriter(
    target: string,
    options?: { flags?: "a" | "w"; onError?: (err: Error) => void },
  ): SessionStorageWriter {
    const writer = super.openWriter(target, options);
    return {
      append: line => writer.append(line),
      flush: () => writer.flush(),
      sync: () => writer.sync(),
      isOpen: () => writer.isOpen(),
      getError: () => writer.getError(),
      close: async () => {
        await writer.close();
        if (this.rejectNextSourceClose && target === this.protectedSourceFile) {
          this.rejectNextSourceClose = false;
          if (this.pinSourceMtimeOnRefusal) {
            this.pinSourceMtimeOnRefusal = false;
            const fixed = new Date("2020-01-01T00:00:00.000Z");
            nodeFs.utimesSync(target, fixed, fixed);
          }
          // A separate writer can append between our end marker and rollback.
          const foreignLine = this.appendForeignLineOnRefusal;
          this.appendForeignLineOnRefusal = undefined;
          if (foreignLine) await fs.appendFile(target, foreignLine);
          const rawPeer = this.appendForeignBytesOnRefusal;
          this.appendForeignBytesOnRefusal = undefined;
          if (rawPeer) await fs.appendFile(target, rawPeer);
          if (this.prependBomOnRefusal) {
            this.prependBomOnRefusal = false;
            const original = await fs.readFile(target);
            await fs.writeFile(target, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original]));
          }
          const revision = this.rewriteOwnedRecordOnRefusal;
          this.rewriteOwnedRecordOnRefusal = undefined;
          if (revision) {
            const rows = (await fs.readFile(target, "utf8")).split("\n");
            const targetType = revision === "header" ? "session" : "message";
            const rowIndex = rows.findIndex(row => {
              if (!row) return false;
              try { return (JSON.parse(row) as { type?: string }).type === targetType; }
              catch { return false; }
            });
            if (rowIndex < 0) throw new Error("expected disposable original journal record");
            if (revision === "foreign-before-header") {
              // A valid independent JSONL row before the session header must
              // never be silently relocated to the tail by strict recovery.
              rows.unshift(JSON.stringify({
                type: "message", id: "synthetic-preheader-foreign", parentId: null,
                timestamp: new Date().toISOString(),
                message: { role: "user", content: "Synthetic foreign entry before original header", timestamp: Date.now() },
              }));
            } else if (revision === "foreign-between-owned") {
              // The peer puts valid history between two intact owned messages.
              // Rebuilding all owned entries before a foreign tail would move it.
              const nextOwned = rows.findIndex((row, index) => index > rowIndex && row.includes('"type":"message"'));
              if (nextOwned < 0) throw new Error("expected second disposable owned message");
              rows.splice(nextOwned, 0, JSON.stringify({
                type: "message", id: "synthetic-interleaved-peer", parentId: null,
                timestamp: new Date().toISOString(),
                message: { role: "user", content: "Synthetic peer inserted between owned messages", timestamp: Date.now() },
              }));
            } else if (revision === "missing-message") {
              // A peer removes one complete, previously published owned line;
              // the surviving journal is still syntactically valid JSONL.
              rows.splice(rowIndex, 1);
            } else {
              const record = JSON.parse(rows[rowIndex]!) as Record<string, unknown>;
              if (revision === "header") {
                record.cwd = path.join(String(record.cwd), "synthetic-independent-cwd");
              } else {
                record.message = {
                  ...(record.message as Record<string, unknown>),
                  content: "Synthetic independently revised owned message",
                };
              }
              rows[rowIndex] = JSON.stringify(record);
            }
            await fs.writeFile(target, rows.join("\n"));
          }
          const alteredMarker = this.reviseAbortedMarkerOnRefusal;
          this.reviseAbortedMarkerOnRefusal = undefined;
          if (alteredMarker) {
            const rows = (await fs.readFile(target, "utf8")).split("\n");
            const markerIndex = rows.findIndex(row => {
              if (!row) return false;
              try {
                const entry = JSON.parse(row) as { type?: string; state?: string; reason?: string };
                return entry.type === "session_lifecycle" &&
                  entry.state === "ended" && entry.reason === "session_switched";
              } catch { return false; }
            });
            if (markerIndex < 0) throw new Error("expected synthetic aborted fork marker on disk");
            const originalMarker = JSON.parse(rows[markerIndex]!) as Record<string, unknown>;
            // Keep the marker's ID while independently changing a valid record.
            rows[markerIndex] = JSON.stringify(alteredMarker === "message"
              ? {
                type: "message", id: originalMarker.id, parentId: null,
                timestamp: originalMarker.timestamp,
                message: { role: "user", content: "Synthetic peer with reused aborted marker ID", timestamp: Date.now() },
              }
              : { ...originalMarker, reason: "closed" });
            await fs.writeFile(target, rows.join("\n"));
          }
          if (this.refuseSourceReadOnClose) {
            this.refuseSourceReadOnClose = false;
            this.refuseNextSourceRead = true;
          }
          throw new Error("synthetic source writer-close refusal");
        }
      },
    };
  }
}

describe("SessionManager.fork terminal breadcrumb publication order", () => {
  it("keeps the prior recoverable terminal pointer when the post-preflight JSONL publish fails", async () => {
    using temp = TempDir.createSync("@veyyon-fork-publish-fault-");
    const overrides = captureDirOverrides();
    const previousTerminalId = process.env.TERM_SESSION_ID;
    const storage = new SyntheticForkJsonlRefusalStorage();
    let manager: SessionManager | undefined;
    try {
      setAgentDir(path.join(temp.path(), "agent"));
      process.env.TERM_SESSION_ID = "veyyon-fork-publish-refusal-test";
      await fs.mkdir(getTerminalSessionsDir(), { recursive: true });
      const terminalId = getTerminalId();
      if (!terminalId) throw new Error("expected isolated test terminal ID");
      const breadcrumbFile = path.join(getTerminalSessionsDir(), terminalId);

      manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"), storage);
      manager.appendMessage({
        role: "user", content: "Original recovery entry", timestamp: Date.now(),
      });
      await manager.ensureOnDisk();
      const sourceFile = manager.getSessionFile();
      if (!sourceFile) throw new Error("expected durable original session");
      const sourceBytes = await fs.readFile(sourceFile, "utf8");
      const originalBreadcrumb = await fs.readFile(breadcrumbFile, "utf8");
      expect(originalBreadcrumb.split(/\r?\n/)[1]).toBe(sourceFile);

      storage.protectedSourceFile = sourceFile;
      storage.rejectNewSession = true;
      await expect(manager.fork()).rejects.toThrow(/synthetic new fork JSONL publication refusal/i);
      const failedTarget = manager.getSessionFile();
      if (!failedTarget) throw new Error("expected attempted fork destination");
      expect(failedTarget).not.toBe(sourceFile);
      expect(await fs.stat(failedTarget).then(() => true, () => false)).toBe(false);
      expect(await fs.readFile(breadcrumbFile, "utf8")).toBe(originalBreadcrumb);
      expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBytes);

      // A later ordinary durable retry must advance the pointer ONLY after the
      // previously refused fork has finally published, rather than stranding
      // recovery at the parent forever after a transient storage outage.
      storage.rejectNewSession = false;
      await manager.flush();
      expect((await fs.stat(failedTarget)).isFile()).toBe(true);
      const recoveredBreadcrumb = await fs.readFile(breadcrumbFile, "utf8");
      expect(recoveredBreadcrumb.split(/\r?\n/)[1]).toBe(failedTarget);
      expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBytes);
    } finally {
      try { await manager?.close(); } catch { /* injected failure may remain latched on an early assertion */ }
      if (previousTerminalId === undefined) delete process.env.TERM_SESSION_ID;
      else process.env.TERM_SESSION_ID = previousTerminalId;
      restoreDirOverrides(overrides);
    }
  });

  it("updates the terminal pointer to an existing fork JSONL on successful publication", async () => {
    using temp = TempDir.createSync("@veyyon-fork-publish-success-");
    const overrides = captureDirOverrides();
    const previousTerminalId = process.env.TERM_SESSION_ID;
    let manager: SessionManager | undefined;
    try {
      setAgentDir(path.join(temp.path(), "agent"));
      process.env.TERM_SESSION_ID = "veyyon-fork-publish-success-test";
      await fs.mkdir(getTerminalSessionsDir(), { recursive: true });
      const terminalId = getTerminalId();
      if (!terminalId) throw new Error("expected isolated test terminal ID");
      const breadcrumbFile = path.join(getTerminalSessionsDir(), terminalId);

      manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
      manager.appendMessage({
        role: "user", content: "Preserved recovery entry", timestamp: Date.now(),
      });
      await manager.ensureOnDisk();
      const sourceFile = manager.getSessionFile();
      if (!sourceFile) throw new Error("expected durable original session");
      const sourceBytes = await fs.readFile(sourceFile, "utf8");
      const originalBreadcrumb = await fs.readFile(breadcrumbFile, "utf8");
      expect(originalBreadcrumb.split(/\r?\n/)[1]).toBe(sourceFile);

      const fork = await manager.fork();
      if (!fork) throw new Error("expected persisted fork");
      expect(fork.oldSessionFile).toBe(sourceFile);
      expect(fork.newSessionFile).not.toBe(sourceFile);
      expect((await fs.stat(fork.newSessionFile)).isFile()).toBe(true);
      const newBreadcrumb = await fs.readFile(breadcrumbFile, "utf8");
      expect(newBreadcrumb.split(/\r?\n/)[1]).toBe(fork.newSessionFile);
      expect(newBreadcrumb).not.toBe(originalBreadcrumb);
      expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBytes);
    } finally {
      await manager?.close();
      if (previousTerminalId === undefined) delete process.env.TERM_SESSION_ID;
      else process.env.TERM_SESSION_ID = previousTerminalId;
      restoreDirOverrides(overrides);
    }
  });
});


// An AgentSession must not keep its provider identity on the old transcript
// while the underlying manager waits to retry publishing an unpublished fork.
// Drive the real AgentSession and SessionManager; only the disk publication
// failure and disposable local auth data are synthetic.
describe("AgentSession fork after an unpublished JSONL refusal", () => {
  it.each([undefined, "basic"] as const)("restores the original transcript identity and can fork after storage recovers (%s)", async instrumentation => {
    using temp = TempDir.createSync("@veyyon-agent-fork-publish-failure-");
    const storage = new SyntheticForkJsonlRefusalStorage();
    const manager = SessionManager.create(
      temp.path(), path.join(temp.path(), "sessions"), storage, { instrumentation },
    );
    const authStorage = await AuthStorage.create(path.join(temp.path(), "synthetic-auth.db"));
    let session: AgentSession | undefined;
    try {
      // A failed fork must not mutate the original artifact/archive sidecar.
      expect(await manager.saveArtifact("synthetic retained archive evidence", "bash")).toBe("0");
      manager.appendMessage({
        role: "user", content: "Original recoverable conversation artifact://0", timestamp: Date.now(),
      });
      await manager.ensureOnDisk();
      const sourceFile = manager.getSessionFile();
      if (!sourceFile) throw new Error("expected durable source session");
      const sourceId = manager.getSessionId();
      const sourceBytes = await fs.readFile(sourceFile, "utf8");
      const sourceArtifact = await manager.getArtifactPath("0");
      if (!sourceArtifact) throw new Error("expected source artifact");
      const originalArtifactBytes = await fs.readFile(sourceArtifact);

      const agent = new Agent({
        initialState: { systemPrompt: ["Synthetic test prompt"], tools: [], messages: [] },
      });
      session = new AgentSession({
        agent,
        sessionManager: manager,
        settings: Settings.isolated({ "async.enabled": false }),
        modelRegistry: new ModelRegistry(authStorage, path.join(temp.path(), "models.yml")),
      });
      const providerSessionId = agent.sessionId;

      storage.protectedSourceFile = sourceFile;
      storage.rejectNewSession = true;
      await expect(session.fork()).rejects.toThrow(/synthetic new fork JSONL publication refusal/i);

      // The manager and provider must still describe the same old transcript.
      expect(manager.getSessionId()).toBe(sourceId);
      expect(manager.getHeader()?.id).toBe(sourceId);
      expect(manager.getSessionFile()).toBe(sourceFile);
      expect(agent.sessionId).toBe(providerSessionId);
      // Read the disk journal without a caller flush: even if the process
      // terminates now, reopening this source must not observe a false end.
      const failedEntries = await loadEntriesFromFile(sourceFile);
      expect(failedEntries.some(entry =>
        entry.type === "session_lifecycle" && entry.state === "ended" &&
        entry.reason === "session_switched"
      )).toBe(false);
      expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBytes);
      expect(await fs.readFile(sourceArtifact)).toEqual(originalArtifactBytes);

      // A foreign writer can append after durable rollback; later appends
      const foreignEntry: JsonlMessageEntry = {
        type: "message",
        id: "publication-refusal-foreign-tail",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: "user", content: "Foreign publication recovery tail", timestamp: Date.now(),
        },
      };
      const foreignLine = `${JSON.stringify(foreignEntry)}\n`;
      await fs.appendFile(sourceFile, foreignLine);

      storage.rejectNewSession = false;
      await manager.flush();
      expect(manager.getSessionFile()).toBe(sourceFile);
      expect(manager.getSessionId()).toBe(sourceId);
      expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBytes + foreignLine);

      // A subsequent ordinary append must persist on the recovered source,
      // not the abandoned fork path, and must keep the old history readable.
      manager.appendMessage({
        role: "user", content: "Entry after rejected fork", timestamp: Date.now(),
      });
      await manager.flush();
      const recoveredSource = await fs.readFile(sourceFile, "utf8");
      expect(recoveredSource).toContain("Original recoverable conversation");
      expect(recoveredSource).toContain("Entry after rejected fork");
      expect(recoveredSource).not.toBe(sourceBytes);
      expect(await fs.readFile(sourceArtifact)).toEqual(originalArtifactBytes);

      // Positive twin: a genuinely published fork still switches both identities
      // and leaves the source's original recovery bytes intact.
      expect(await session.fork()).toBe(true);
      const nextFile = manager.getSessionFile();
      if (!nextFile) throw new Error("expected committed fork file");
      expect(nextFile).not.toBe(sourceFile);
      expect((await fs.stat(nextFile)).isFile()).toBe(true);
      expect(manager.getSessionId()).not.toBe(sourceId);
      expect(agent.sessionId).toBe(manager.getSessionId());
      const committedEntries = await loadEntriesFromFile(sourceFile);
      expect(committedEntries.some(entry =>
        entry.type === "session_lifecycle" && entry.state === "ended" &&
        entry.reason === "session_switched"
      )).toBe(instrumentation === "basic");
      expect(await fs.readFile(sourceFile, "utf8")).toContain("Entry after rejected fork");
      expect(await fs.readFile(sourceFile, "utf8")).toContain("Foreign publication recovery tail");
      const copiedArtifact = await manager.getArtifactPath("0");
      if (!copiedArtifact) throw new Error("expected copied archived artifact");
      expect(copiedArtifact).not.toBe(sourceArtifact);
      expect(await fs.readFile(copiedArtifact)).toEqual(originalArtifactBytes);
      expect(await fs.readFile(sourceArtifact)).toEqual(originalArtifactBytes);
    } finally {
      storage.rejectNewSession = false;
      try { await session?.dispose(); } finally {
        authStorage.close();
        if (!session) await manager.close();
      }
    }
  });

  it("reports both failures when the rejected fork cannot repair its original journal", async () => {
    using temp = TempDir.createSync("@veyyon-agent-fork-double-refusal-");
    const storage = new SyntheticForkJsonlRefusalStorage();
    const manager = SessionManager.create(
      temp.path(), path.join(temp.path(), "sessions"), storage, { instrumentation: "basic" },
    );
    const authStorage = await AuthStorage.create(path.join(temp.path(), "synthetic-auth.db"));
    let session: AgentSession | undefined;
    try {
      manager.appendMessage({
        role: "user", content: "Original history survives both failures", timestamp: Date.now(),
      });
      await manager.ensureOnDisk();
      const originalFile = manager.getSessionFile();
      if (!originalFile) throw new Error("expected persisted source");
      const originalId = manager.getSessionId();

      const agent = new Agent({
        initialState: { systemPrompt: ["Synthetic test prompt"], tools: [], messages: [] },
      });
      session = new AgentSession({
        agent,
        sessionManager: manager,
        settings: Settings.isolated({ "async.enabled": false }),
        modelRegistry: new ModelRegistry(authStorage, path.join(temp.path(), "models.yml")),
      });
      const providerId = agent.sessionId;
      storage.protectedSourceFile = originalFile;
      storage.rejectNewSession = true;
      storage.rejectSourceRepair = true;
      let failure: unknown;
      try {
        await session.fork();
      } catch (error) {
        failure = error;
      }
      // Never silently claim a safe rollback when the repair itself failed.
      expect(failure).toBeInstanceOf(AggregateError);
      const errors = (failure as AggregateError).errors.map((error: unknown) => String(error));
      expect(errors.some(error => error.includes("synthetic new fork JSONL publication refusal"))).toBe(true);
      expect(errors.some(error => error.includes("synthetic original-source rollback refusal"))).toBe(true);
      expect(manager.getSessionId()).toBe(originalId);
      expect(manager.getSessionFile()).toBe(originalFile);
      expect(agent.sessionId).toBe(providerId);

      // The active source must be repaired before it is treated as reloadable.
      // This is explicit recovery after the caller observed the aggregate error.
      storage.rejectSourceRepair = false;
      storage.rejectNewSession = false;
      await manager.flush();
      const repaired = await loadEntriesFromFile(originalFile);
      expect(repaired.some(entry =>
        entry.type === "session_lifecycle" && entry.state === "ended" &&
        entry.reason === "session_switched"
      )).toBe(false);
      expect(repaired.some(entry =>
        entry.type === "message" && entry.message.role === "user" &&
        entry.message.content === "Original history survives both failures"
      )).toBe(true);
    } finally {
      storage.rejectNewSession = false;
      storage.rejectSourceRepair = false;
      try { await session?.dispose(); } finally {
        authStorage.close();
        if (!session) await manager.close();
      }
    }
  });
});

describe("AgentSession fork pre-switch writer-close failure", () => {
  it("restores the still-running source lifecycle and preserves a foreign writer tail", async () => {
    using temp = TempDir.createSync("@veyyon-fork-source-writer-close-");
    const storage = new SyntheticForkSourceCloseRefusalStorage();
    const manager = SessionManager.create(
      temp.path(), path.join(temp.path(), "sessions"), storage, { instrumentation: "basic" },
    );
    const authStorage = await AuthStorage.create(path.join(temp.path(), "synthetic-auth.db"));
    let session: AgentSession | undefined;
    try {
      expect(await manager.saveArtifact("synthetic pre-switch archival evidence", "bash")).toBe("0");
      manager.appendMessage({
        role: "user", content: "Original active session", timestamp: Date.now(),
      });
      manager.appendMessage({
        role: "user", content: "Retain artifact://0 through a failed source close", timestamp: Date.now(),
      });
      await manager.ensureOnDisk();
      const sourceFile = manager.getSessionFile();
      if (!sourceFile) throw new Error("expected persisted original session");
      const sourceId = manager.getSessionId();
      expect(manager.getLifecycleState()).toBe("running");
      const initialBytes = await fs.readFile(sourceFile, "utf8");
      const sourceArtifact = await manager.getArtifactPath("0");
      if (!sourceArtifact) throw new Error("expected original sidecar evidence");
      const originalArtifactBytes = await fs.readFile(sourceArtifact);

      const agent = new Agent({
        initialState: { systemPrompt: ["Synthetic test prompt"], tools: [], messages: [] },
      });
      session = new AgentSession({
        agent,
        sessionManager: manager,
        settings: Settings.isolated({ "async.enabled": false }),
        modelRegistry: new ModelRegistry(authStorage, path.join(temp.path(), "models.yml")),
      });
      const providerSessionId = agent.sessionId;

      storage.protectedSourceFile = sourceFile;
      // Interleave a real file append from an independent synthetic writer
      // AFTER our old-source end marker but BEFORE the rollback repairs it.
      const interleavedForeign: JsonlMessageEntry = {
        type: "message",
        id: "synthetic-interleaved-close-tail",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: "user", content: "Foreign tail before rollback", timestamp: Date.now(),
        },
      };
      storage.appendForeignLineOnRefusal = `${JSON.stringify(interleavedForeign)}\n`;
      storage.rejectNextSourceClose = true;
      await expect(session.fork()).rejects.toThrow(/synthetic source writer-close refusal/);
      expect(storage.rejectNextSourceClose).toBe(false);
      expect(manager.getSessionFile()).toBe(sourceFile);
      expect(manager.getSessionId()).toBe(sourceId);
      expect(manager.getLifecycleState()).toBe("running");
      expect(agent.sessionId).toBe(providerSessionId);
      expect(manager.getEntries().some(entry =>
        entry.type === "session_lifecycle" && entry.state === "ended" &&
        entry.reason === "session_switched"
      )).toBe(false);
      // Reparse the actual source bytes without an explicit caller flush.
      // The aborted terminal marker must not survive a process restart.
      const diskAfterRefusal = await loadEntriesFromFile(sourceFile);
      expect(diskAfterRefusal.some(entry =>
        entry.type === "session_lifecycle" && entry.state === "ended" &&
        entry.reason === "session_switched"
      )).toBe(false);
      expect(diskAfterRefusal.some(entry =>
        entry.type === "message" && entry.message.role === "user" &&
        entry.message.content === "Original active session"
      )).toBe(true);
      expect(diskAfterRefusal.some(entry =>
        entry.type === "message" && entry.message.role === "user" &&
        entry.message.content === "Foreign tail before rollback"
      )).toBe(true);
      expect(await fs.readFile(sourceArtifact)).toEqual(originalArtifactBytes);

      // Simulate another legitimate writer after this manager has repaired
      // only its own aborted switch marker. The foreign line must survive.
      const foreignEntry: JsonlMessageEntry = {
        type: "message",
        id: "synthetic-foreign-tail",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: "user", content: "Foreign writer must survive recovery", timestamp: Date.now(),
        },
      };
      await fs.appendFile(sourceFile, `${JSON.stringify(foreignEntry)}\n`);
      await manager.flush();

      const recovered = await fs.readFile(sourceFile, "utf8");
      const recoveredEntries = await loadEntriesFromFile(sourceFile);
      expect(recoveredEntries.some(entry =>
        entry.type === "session_lifecycle" && entry.state === "ended" &&
        entry.reason === "session_switched"
      )).toBe(false);
      expect(recoveredEntries.some(entry =>
        entry.type === "message" && entry.message.role === "user" &&
        entry.message.content === "Foreign writer must survive recovery"
      )).toBe(true);
      expect(recovered).toContain("Original active session");
      expect(recovered).not.toBe(initialBytes);
      expect(manager.getLifecycleState()).toBe("running");

      // Successful retry ends the old session legitimately and publishes a
      // distinct new one, without changing the old provider identity first.
      expect(await session.fork()).toBe(true);
      const forkedFile = manager.getSessionFile();
      if (!forkedFile) throw new Error("expected committed fork file");
      expect(forkedFile).not.toBe(sourceFile);
      expect((await fs.stat(forkedFile)).isFile()).toBe(true);
      expect(manager.getSessionId()).not.toBe(sourceId);
      expect(agent.sessionId).toBe(manager.getSessionId());
      expect(await fs.readFile(sourceFile, "utf8")).toContain("Foreign writer must survive recovery");
      // No source history/sidecar elision, and the published fork gets its own copy.
      const forkedArtifact = await manager.getArtifactPath("0");
      if (!forkedArtifact) throw new Error("expected fork sidecar copy");
      expect(forkedArtifact).not.toBe(sourceArtifact);
      expect(await fs.readFile(forkedArtifact)).toEqual(originalArtifactBytes);
      expect(await fs.readFile(sourceArtifact)).toEqual(originalArtifactBytes);
    } finally {
      storage.rejectNextSourceClose = false;
      try { await session?.dispose(); } finally {
        authStorage.close();
        if (!session) await manager.close();
      }
    }
  });




  it("preserves synthetic foreign journal history through the Windows EPERM rollback fallback", async () => {
    using temp = TempDir.createSync("@veyyon-fork-eperm-backup-guard-");
    const storage = new SyntheticForkSourceCloseRefusalStorage();
    const manager = SessionManager.create(
      temp.path(), path.join(temp.path(), "sessions"), storage, { instrumentation: "basic" },
    );
    try {
      expect(await manager.saveArtifact("synthetic original archived bytes", "bash")).toBe("0");
      manager.appendMessage({
        role: "user", content: "Original synthetic history with artifact://0", timestamp: Date.now(),
      });
      await manager.ensureOnDisk();
      const sourceFile = manager.getSessionFile();
      const sourceId = manager.getSessionId();
      const originalArtifact = await manager.getArtifactPath("0");
      if (!sourceFile || !originalArtifact) throw new Error("expected persisted synthetic source and archive");
      const preservedArtifact = await fs.readFile(originalArtifact);

      storage.protectedSourceFile = sourceFile;
      storage.appendForeignLineOnRefusal = `${JSON.stringify({
        type: "message", id: "synthetic-eperm-foreign-history", parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "Keep independent EPERM foreign history", timestamp: Date.now() },
      })}\n`;
      storage.rejectNextSourceClose = true;
      storage.forceNextSourceAtomicEperm = true;
      await expect(manager.fork()).rejects.toThrow(/synthetic source writer-close refusal/);
      expect(storage.forceNextSourceAtomicEperm).toBe(false);
      expect(manager.getSessionId()).toBe(sourceId);
      expect(manager.getSessionFile()).toBe(sourceFile);

      const disk = await loadEntriesFromFile(sourceFile);
      expect(disk.some(entry => entry.type === "session_lifecycle" &&
        entry.state === "ended" && entry.reason === "session_switched")).toBe(false);
      expect(disk.some(entry => entry.type === "message" &&
        entry.message.role === "user" &&
        entry.message.content === "Keep independent EPERM foreign history")).toBe(true);
      expect(disk.some(entry => entry.type === "message" &&
        entry.message.role === "user" &&
        entry.message.content === "Original synthetic history with artifact://0")).toBe(true);
      expect(await fs.readFile(originalArtifact)).toEqual(preservedArtifact);
    } finally {
      storage.rejectNextSourceClose = false;
      storage.forceNextSourceAtomicEperm = false;
      storage.appendForeignLineOnRefusal = undefined;
      await manager.close().catch(() => undefined);
    }
  });

  it("refuses Windows EPERM rollback that would overwrite a re-created foreign journal", async () => {
    using temp = TempDir.createSync("@veyyon-fork-eperm-foreign-recreate-");
    const storage = new SyntheticForkSourceCloseRefusalStorage();
    const manager = SessionManager.create(
      temp.path(), path.join(temp.path(), "sessions"), storage, { instrumentation: "basic" },
    );
    try {
      expect(await manager.saveArtifact("original synthetic archive preserved", "bash")).toBe("0");
      manager.appendMessage({
        role: "user", content: "Original source with artifact://0", timestamp: Date.now(),
      });
      await manager.ensureOnDisk();
      const sourceFile = manager.getSessionFile();
      const sourceId = manager.getSessionId();
      const artifact = await manager.getArtifactPath("0");
      if (!sourceFile || !artifact) throw new Error("expected disposable source and artifact");
      const preservedArtifact = await fs.readFile(artifact);
      const foreignJournal = [
        JSON.stringify({
          type: "session", version: CURRENT_SESSION_VERSION, id: "independent-published-session",
          timestamp: new Date().toISOString(), cwd: temp.path(),
        }),
        JSON.stringify({
          type: "message", id: "independent-published-message", parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: "user", content: "Fresh independent journal must not be overwritten",
            timestamp: Date.now(),
          },
        }),
        "",
      ].join("\n");

      storage.protectedSourceFile = sourceFile;
      storage.recreateJournalAfterMoveAside = foreignJournal;
      storage.rejectNextSourceClose = true;
      storage.forceNextSourceAtomicEperm = true;

      let failure: unknown;
      try {
        await manager.fork();
      } catch (error) {
        failure = error;
      }
      // Returning only the injected writer-close failure would misreport a
      // destructive or unverified recovery as complete.
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) throw new Error("expected fail-closed fork repair");
      const causes = failure.errors.map((error: unknown) => String(error));
      expect(causes.some((error: string) => error.includes("synthetic source writer-close refusal"))).toBe(true);
      expect(causes.some((error: string) => /foreign|changed|reappeared|conflict|replace/i.test(error))).toBe(true);

      expect(storage.recreateJournalAfterMoveAside).toBeUndefined();
      expect(storage.forceNextSourceAtomicEperm).toBe(false);
      expect(manager.getSessionId()).toBe(sourceId);
      expect(manager.getSessionFile()).toBe(sourceFile);
      // A foreign writer published a different valid JSONL inode while the old
      // source was moved aside. Neither the new journal nor the old source's
      // archive/history may be silently discarded on failed recovery.
      expect(await fs.readFile(sourceFile, "utf8")).toBe(foreignJournal);
      const backupPath = storage.movedAsideJournalPath;
      if (!backupPath) throw new Error("expected captured EPERM move-aside path");
      const backupText = await fs.readFile(backupPath, "utf8");
      expect(backupText).toContain("Original source with artifact://0");
      expect(await fs.readFile(artifact)).toEqual(preservedArtifact);
    } finally {
      storage.rejectNextSourceClose = false;
      storage.forceNextSourceAtomicEperm = false;
      storage.recreateJournalAfterMoveAside = undefined;
      await manager.close().catch(() => undefined);
    }
  });

  it("refuses EPERM backup rollback over a foreign journal after guard or replacement failure", async () => {
    for (const phase of ["guard-rejected", "retry-failed"] as const) {
      using temp = TempDir.createSync("@veyyon-fork-eperm-rollback-foreign-" + phase);
      const storage = new SyntheticForkSourceCloseRefusalStorage();
      const manager = SessionManager.create(
        temp.path(), path.join(temp.path(), "sessions"), storage, { instrumentation: "basic" },
      );
      try {
        expect(await manager.saveArtifact("original synthetic archive bytes", "bash")).toBe("0");
        manager.appendMessage({
          role: "user", content: "Original source with artifact://0", timestamp: Date.now(),
        });
        await manager.ensureOnDisk();
        const sourceFile = manager.getSessionFile();
        const sourceId = manager.getSessionId();
        const artifact = await manager.getArtifactPath("0");
        if (!sourceFile || !artifact) throw new Error("expected disposable source and artifact");
        const artifactBefore = await fs.readFile(artifact);
        const foreignJournal = [
          JSON.stringify({
            type: "session", version: CURRENT_SESSION_VERSION, id: "retry-foreign-session",
            timestamp: new Date().toISOString(), cwd: temp.path(),
          }),
          JSON.stringify({
            type: "message", id: "retry-foreign-message", parentId: null,
            timestamp: new Date().toISOString(),
            message: {
              role: "user", content: "Foreign journal claimed original pathname",
              timestamp: Date.now(),
            },
          }),
          "",
        ].join("\n");

        storage.protectedSourceFile = sourceFile;
        storage.rejectNextSourceClose = true;
        storage.forceNextSourceAtomicEperm = true;
        if (phase === "guard-rejected") storage.recreateJournalOnRejectedGuard = foreignJournal;
        else storage.recreateJournalOnFailedReplace = foreignJournal;

        let failure: unknown;
        try {
          await manager.fork();
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(AggregateError);
        if (!(failure instanceof AggregateError)) throw new Error("expected failed fork and refused rollback");
        const causes = failure.errors.map((error: unknown) => String(error));
        expect(causes.some((reason: string) => reason.includes("synthetic source writer-close refusal"))).toBe(true);
        const conflict = phase === "guard-rejected"
          ? "reappeared during EPERM rollback"
          : "reappeared after failed EPERM replacement";
        expect(causes.some((reason: string) => reason.includes(conflict))).toBe(true);
        expect(storage.forceNextSourceAtomicEperm).toBe(false);
        expect(storage.recreateJournalOnRejectedGuard).toBeUndefined();
        expect(storage.recreateJournalOnFailedReplace).toBeUndefined();
        expect(manager.getSessionId()).toBe(sourceId);
        expect(manager.getSessionFile()).toBe(sourceFile);
        expect(await fs.readFile(sourceFile, "utf8")).toBe(foreignJournal);
        const backupPath = storage.movedAsideJournalPath;
        if (!backupPath) throw new Error("expected retained original EPERM backup");
        const backupBytes = await fs.readFile(backupPath, "utf8");
        expect(backupBytes).toContain("Original source with artifact://0");
        if (phase === "guard-rejected") expect(backupBytes).toContain("Backup has an independent append");
        expect(await fs.readFile(artifact)).toEqual(artifactBefore);
      } finally {
        storage.rejectNextSourceClose = false;
        storage.forceNextSourceAtomicEperm = false;
        storage.recreateJournalOnRejectedGuard = undefined;
        storage.recreateJournalOnFailedReplace = undefined;
        await manager.close().catch(() => undefined);
      }
    }
  });

  it("refuses stale failed-fork repair when a foreign writer appends after the successful journal read", async () => {
    using temp = TempDir.createSync("@veyyon-fork-foreign-append-before-replace-");
    const storage = new SyntheticForkSourceCloseRefusalStorage();
    const manager = SessionManager.create(
      temp.path(), path.join(temp.path(), "sessions"), storage, { instrumentation: "basic" },
    );
    try {
      expect(await manager.saveArtifact("synthetic original archive", "bash")).toBe("0");
      manager.appendMessage({
        role: "user", content: "Original source preserves artifact://0", timestamp: Date.now(),
      });
      await manager.ensureOnDisk();
      const sourceFile = manager.getSessionFile();
      if (!sourceFile) throw new Error("expected original journal");
      const sessionId = manager.getSessionId();
      const artifactFile = await manager.getArtifactPath("0");
      if (!artifactFile) throw new Error("expected synthetic original archive");
      const artifactBytes = await fs.readFile(artifactFile);

      const foreignLine = (id: string, content: string) => `${JSON.stringify({
        type: "message", id, parentId: null, timestamp: new Date().toISOString(),
        message: { role: "user", content, timestamp: Date.now() },
      })}\n`;
      storage.protectedSourceFile = sourceFile;
      // The first independent append forces a successful disk reread. A second
      // independent append arrives after that read, as staging starts.
      storage.appendForeignLineOnRefusal = foreignLine(
        "synthetic-foreign-before-read", "Foreign before source reread",
      );
      storage.appendForeignLineBeforeRepairPublish = foreignLine(
        "synthetic-foreign-after-read", "Foreign after source reread",
      );
      storage.rejectNextSourceClose = true;

      let failure: unknown;
      try {
        await manager.fork();
      } catch (error) {
        failure = error;
      }
      expect(storage.appendForeignLineBeforeRepairPublish).toBeUndefined();
      expect(failure).toBeInstanceOf(AggregateError);
      const reasons = (failure as AggregateError).errors.map((error: unknown) => String(error));
      expect(reasons.some(reason => reason.includes("synthetic source writer-close refusal"))).toBe(true);
      expect(reasons.some(reason => reason.includes("Original journal changed before failed-fork repair publication"))).toBe(true);
      expect(manager.getSessionId()).toBe(sessionId);
      expect(manager.getSessionFile()).toBe(sourceFile);

      // A refused repair must leave the source and both independent appends
      // intact, even though its own aborted end marker still awaits repair.
      const stillOriginal = await fs.readFile(sourceFile, "utf8");
      expect(stillOriginal).toContain("Foreign before source reread");
      expect(stillOriginal).toContain("Foreign after source reread");
      expect(await fs.readFile(artifactFile)).toEqual(artifactBytes);

      // Once the foreign writer is quiet, explicit recovery can safely remove
      // only our aborted end marker without discarding either foreign entry.
      await manager.flush();
      const repaired = await loadEntriesFromFile(sourceFile);
      expect(repaired.some(entry =>
        entry.type === "session_lifecycle" && entry.state === "ended" &&
        entry.reason === "session_switched"
      )).toBe(false);
      expect(repaired.filter(entry =>
        entry.type === "message" && entry.message.role === "user" &&
        typeof entry.message.content === "string" && entry.message.content.startsWith("Foreign ")
      )).toHaveLength(2);
      expect(await fs.readFile(artifactFile)).toEqual(artifactBytes);
    } finally {
      storage.rejectNextSourceClose = false;
      storage.appendForeignLineOnRefusal = undefined;
      storage.appendForeignLineBeforeRepairPublish = undefined;
      await manager.close().catch(() => undefined);
    }
  });

  it("refuses a same-size independently rewritten journal despite restored mtime", async () => {
    using temp = TempDir.createSync("@veyyon-fork-ctime-aba-");
    const storage = new SyntheticForkSourceCloseRefusalStorage();
    const manager = SessionManager.create(
      temp.path(), path.join(temp.path(), "sessions"), storage, { instrumentation: "basic" },
    );
    try {
      expect(await manager.saveArtifact("synthetic ctime guard archive", "bash")).toBe("0");
      manager.appendMessage({
        role: "user", content: "Preserve SYNTHETIC-OLD and artifact://0", timestamp: Date.now(),
      });
      await manager.ensureOnDisk();
      const sourceFile = manager.getSessionFile();
      const sourceId = manager.getSessionId();
      const artifact = await manager.getArtifactPath("0");
      if (!sourceFile || !artifact) throw new Error("expected disposable original journal and archive");
      const archiveBytes = await fs.readFile(artifact);
      storage.protectedSourceFile = sourceFile;
      storage.rejectNextSourceClose = true;
      storage.pinSourceMtimeOnRefusal = true;
      storage.rewriteOwnedTextAtGuard = { before: "SYNTHETIC-OLD", after: "SYNTHETIC-NEW" };
      let failure: unknown;
      try { await manager.fork(); } catch (error) { failure = error; }
      expect(storage.rewriteOwnedTextAtGuard).toBeUndefined();
      expect(failure).toBeInstanceOf(AggregateError);
      const reasons = (failure as AggregateError).errors.map((error: unknown) => String(error));
      expect(reasons.some(reason => reason.includes("synthetic source writer-close refusal"))).toBe(true);
      expect(reasons.some(reason =>
        reason.includes("Original journal changed before failed-fork repair publication")
      )).toBe(true);
      expect(manager.getSessionFile()).toBe(sourceFile);
      expect(manager.getSessionId()).toBe(sourceId);
      const persisted = await fs.readFile(sourceFile, "utf8");
      expect(persisted).toContain("SYNTHETIC-NEW");
      expect(persisted).not.toContain("SYNTHETIC-OLD");
      expect(persisted).toContain('"reason":"session_switched"');
      expect(await fs.readFile(artifact)).toEqual(archiveBytes);
    } finally {
      storage.rejectNextSourceClose = false;
      storage.pinSourceMtimeOnRefusal = false;
      storage.rewriteOwnedTextAtGuard = undefined;
      await manager.close().catch(() => undefined);
    }
  });

  it("preserves a separate append landing after the final guard, immediately before rename", async () => {
    using temp = TempDir.createSync("@veyyon-fork-final-guard-race-");
    const storage = new SyntheticForkSourceCloseRefusalStorage();
    const manager = SessionManager.create(
      temp.path(), path.join(temp.path(), "sessions"), storage, { instrumentation: "basic" },
    );
    try {
      expect(await manager.saveArtifact("synthetic retained sidecar", "bash")).toBe("0");
      manager.appendMessage({
        role: "user", content: "Original journal keeps artifact://0", timestamp: Date.now(),
      });
      await manager.ensureOnDisk();
      const originalFile = manager.getSessionFile();
      const originalId = manager.getSessionId();
      const artifact = await manager.getArtifactPath("0");
      if (!originalFile || !artifact) throw new Error("expected synthetic journal and sidecar");
      const archiveBefore = await fs.readFile(artifact);
      const entry = (id: string, content: string) => `${JSON.stringify({
        type: "message", id, parentId: null, timestamp: new Date().toISOString(),
        message: { role: "user", content, timestamp: Date.now() },
      })}\n`;

      storage.protectedSourceFile = originalFile;
      // The first independent append forces a successful source reread. The
      // second is written synchronously in renameSync, AFTER commitGuard().
      storage.appendForeignLineOnRefusal = entry(
        "synthetic-before-reread", "Independent entry before rollback reread",
      );
      storage.appendForeignLineAtRename = entry(
        "synthetic-last-window", "Independent entry after final guard",
      );
      storage.rejectNextSourceClose = true;
      await expect(manager.fork()).rejects.toThrow(/synthetic source writer-close refusal/);
      expect(storage.appendForeignLineAtRename).toBeUndefined();
      expect(manager.getSessionFile()).toBe(originalFile);
      expect(manager.getSessionId()).toBe(originalId);

      // In the current implementation the final guard checks the OLD inode,
      // then rename replaces it. An uncoordinated append in that gap is lost.
      // This is an acceptance regression, not a known-green test.
      const disk = await fs.readFile(originalFile, "utf8");
      expect(disk).toContain("Original journal keeps artifact://0");
      expect(disk).toContain("Independent entry before rollback reread");
      expect(disk).toContain("Independent entry after final guard");
      expect(disk).not.toContain('"reason":"session_switched"');
      expect(await fs.readFile(artifact)).toEqual(archiveBefore);
    } finally {
      storage.rejectNextSourceClose = false;
      storage.appendForeignLineOnRefusal = undefined;
      storage.appendForeignLineAtRename = undefined;
      await manager.close().catch(() => undefined);
    }
  });

  it("preserves a peer append after strict synchronous failed-fork reread", async () => {
    // Exercise real flushSync -> writeTextSync with a separate append descriptor,
    // not only an isolated rename reproduction. Both paths use disposable roots.
    for (const injectPeer of [false, true]) {
      using temp = TempDir.createSync("@veyyon-fork-sync-peer-publication-");
      const storage = new SyntheticForkSourceCloseRefusalStorage();
      const manager = SessionManager.create(
        temp.path(), path.join(temp.path(), "sessions"), storage, { instrumentation: "basic" },
      );
      try {
        expect(await manager.saveArtifact("synthetic sync repair sidecar", "bash")).toBe("0");
        manager.appendMessage({
          role: "user", content: "Owned journal keeps artifact://0", timestamp: Date.now(),
        });
        await manager.ensureOnDisk();
        const sourceFile = manager.getSessionFile();
        const sourceId = manager.getSessionId();
        const artifact = await manager.getArtifactPath("0");
        if (!sourceFile || !artifact) throw new Error("expected disposable source and sidecar");
        const archiveBefore = await fs.readFile(artifact);

        // Fail the source writer close, then one async strict reread, so the
        // real manager must retry the pending failed-fork repair synchronously.
        storage.protectedSourceFile = sourceFile;
        storage.rejectNextSourceClose = true;
        storage.refuseSourceReadOnClose = true;
        let forkFailure: unknown;
        try { await manager.fork(); } catch (error) { forkFailure = error; }
        expect(forkFailure).toBeInstanceOf(AggregateError);
        if (!(forkFailure instanceof AggregateError)) throw new Error("expected failed async repair");
        expect(forkFailure.errors.some((error: unknown) =>
          String(error).includes("synthetic source writer-close refusal")
        )).toBe(true);
        const beforeSync = await fs.readFile(sourceFile, "utf8");
        expect(beforeSync).toContain('"reason":"session_switched"');

        const peerLine = `${JSON.stringify({
          type: "message", id: "synthetic-sync-peer", parentId: null,
          timestamp: new Date().toISOString(),
          message: { role: "user", content: "Independent sync peer history", timestamp: Date.now() },
        })}\n`;
        if (injectPeer) storage.appendForeignLineBeforeSyncRewrite = peerLine;
        let syncFailure: unknown;
        try { manager.flushSync(); } catch (error) { syncFailure = error; }
        const afterSync = await fs.readFile(sourceFile, "utf8");
        expect(storage.appendForeignLineBeforeSyncRewrite).toBeUndefined();
        expect(manager.getSessionFile()).toBe(sourceFile);
        expect(manager.getSessionId()).toBe(sourceId);
        expect(afterSync).toContain("Owned journal keeps artifact://0");
        expect(await fs.readFile(artifact)).toEqual(archiveBefore);
        if (!injectPeer) {
          expect(syncFailure).toBeUndefined();
          expect(afterSync).not.toContain('"reason":"session_switched"');
        } else {
          // Safe outcomes: preserve the peer in a repaired file, or refuse
          // publication with the exact original+peer source still recoverable.
          expect(afterSync).toContain(peerLine);
          if (syncFailure === undefined) {
            expect(afterSync).not.toContain('"reason":"session_switched"');
          } else {
            expect(String(syncFailure)).toMatch(/journal changed|Cannot preserve|Cannot verify/i);
            expect(afterSync).toBe(beforeSync + peerLine);
          }
        }
      } finally {
        storage.rejectNextSourceClose = false;
        storage.refuseSourceReadOnClose = false;
        storage.appendForeignLineBeforeSyncRewrite = undefined;
        await manager.close().catch(() => undefined);
      }
    }
  });

  // POSIX rename keeps an independent O_APPEND descriptor on the displaced
  // original inode. Windows may refuse the replacement while that handle is
  // open; the separate EPERM tests cover its distinct path behavior.
  // Acceptance is deliberately RED until cross-process history is protected.
  it.skipIf(process.platform === "win32")(
    "preserves a pre-open independent append descriptor after rollback replaces the journal",
    async () => {
      using temp = TempDir.createSync("@veyyon-fork-postrename-peer-fd-");
      const storage = new SyntheticForkSourceCloseRefusalStorage();
      const manager = SessionManager.create(
        temp.path(), path.join(temp.path(), "sessions"), storage, { instrumentation: "basic" },
      );
      let peer: SessionStorageWriter | undefined;
      try {
        expect(await manager.saveArtifact("synthetic retained post-rename archive", "bash")).toBe("0");
        manager.appendMessage({
          role: "user", content: "Original journal keeps artifact://0", timestamp: Date.now(),
        });
        await manager.ensureOnDisk();
        const sourceFile = manager.getSessionFile();
        if (!sourceFile) throw new Error("expected original session journal");
        const sourceId = manager.getSessionId();
        const artifact = await manager.getArtifactPath("0");
        if (!artifact) throw new Error("expected synthetic archive");
        const archiveBytes = await fs.readFile(artifact);
        const oldInode = nodeFs.statSync(sourceFile).ino;

        // A separate storage instance opens a REAL writer descriptor before
        // the failed fork. No pathname re-open happens after the repair.
        peer = new FileSessionStorage().openWriter(sourceFile);
        storage.protectedSourceFile = sourceFile;
        storage.rejectNextSourceClose = true;
        await expect(manager.fork()).rejects.toThrow(/synthetic source writer-close refusal/);
        expect(storage.rejectNextSourceClose).toBe(false);
        expect(manager.getSessionId()).toBe(sourceId);
        expect(manager.getSessionFile()).toBe(sourceFile);
        // Verify that the repaired pathname really points at a new inode:
        // the peer's existing append handle still targets the old one.
        expect(nodeFs.statSync(sourceFile).ino).not.toBe(oldInode);

        const foreignEntry: JsonlMessageEntry = {
          type: "message", id: "synthetic-postrename-open-peer", parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: "user", content: "Post-rename independent append remains recoverable",
            timestamp: Date.now(),
          },
        };
        // After the real rename has returned, the second writer accepts this
        // entry. A successful repair must not leave it invisible at the path.
        await peer.append(`${JSON.stringify(foreignEntry)}\n`);
        await peer.sync();
        const active = await fs.readFile(sourceFile, "utf8");
        expect(active).toContain("Original journal keeps artifact://0");
        expect(active).toContain("Post-rename independent append remains recoverable");
        expect(active).not.toContain('"reason":"session_switched"');
        expect(await fs.readFile(artifact)).toEqual(archiveBytes);
      } finally {
        storage.rejectNextSourceClose = false;
        try { await peer?.close(); } finally { await manager.close().catch(() => undefined); }
      }
    },
  );


  it("refuses invalid UTF-8 bytes in a separately appended failed-fork journal record", async () => {
    using temp = TempDir.createSync("@veyyon-fork-raw-utf8-refusal-");
    const storage = new SyntheticForkSourceCloseRefusalStorage();
    const manager = SessionManager.create(
      temp.path(), path.join(temp.path(), "sessions"), storage, { instrumentation: "basic" },
    );
    try {
      expect(await manager.saveArtifact("synthetic raw-byte preservation evidence", "bash")).toBe("0");
      manager.appendMessage({
        role: "user", content: "Retain synthetic artifact://0", timestamp: Date.now(),
      });
      await manager.ensureOnDisk();
      const sourceFile = manager.getSessionFile();
      const originalId = manager.getSessionId();
      const artifact = await manager.getArtifactPath("0");
      if (!sourceFile || !artifact) throw new Error("expected disposable source and archive");
      const prefix = await fs.readFile(sourceFile);
      const archiveBytes = await fs.readFile(artifact);

      // JSON syntax is valid after replacement decoding, so a text-only strict
      // parser can incorrectly republish different bytes instead of refusing.
      const foreign = Buffer.from(JSON.stringify({
        type: "message", id: "synthetic-raw-invalid-utf8", parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "peer!bytes", timestamp: Date.now() },
      }) + "\n", "utf8");
      const corruptOffset = foreign.indexOf("!");
      expect(corruptOffset).toBeGreaterThan(0);
      foreign[corruptOffset] = 0xff;
      storage.protectedSourceFile = sourceFile;
      storage.appendForeignBytesOnRefusal = foreign;
      storage.rejectNextSourceClose = true;

      let failure: unknown;
      try { await manager.fork(); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) throw new Error("expected fail-closed journal recovery");
      const reasons = failure.errors.map((error: unknown) => String(error));
      expect(reasons.some((reason: string) => reason.includes("synthetic source writer-close refusal"))).toBe(true);
      expect(reasons.some((reason: string) => reason.includes("Cannot verify current session journal"))).toBe(true);

      const preserved = await fs.readFile(sourceFile);
      expect(preserved.subarray(0, prefix.length)).toEqual(prefix);
      expect(preserved.subarray(-foreign.length)).toEqual(foreign);
      expect(await fs.readFile(artifact)).toEqual(archiveBytes);
      expect(manager.getSessionId()).toBe(originalId);
      expect(manager.getSessionFile()).toBe(sourceFile);
      expect(() => manager.flushSync()).toThrow(/Cannot verify current session journal/);
      expect(await fs.readFile(sourceFile)).toEqual(preserved);

      // Simulate a backend exposing only lossy ordinary readers. A fallback
      // would parse U+FFFD and overwrite the exact independent byte during
      // either a synchronous exit flush or an asynchronous repair retry.
      Object.defineProperty(storage, "readTextStrict", { value: undefined });
      Object.defineProperty(storage, "readTextSyncStrict", { value: undefined });
      expect(() => manager.flushSync()).toThrow(/Cannot verify current session journal/);
      expect(await fs.readFile(sourceFile)).toEqual(preserved);
      await expect(manager.flush()).rejects.toThrow(/Cannot verify current session journal/);
      expect(await fs.readFile(sourceFile)).toEqual(preserved);
    } finally {
      storage.rejectNextSourceClose = false;
      storage.appendForeignBytesOnRefusal = undefined;
      await manager.close().catch(() => undefined);
    }
  });


  it("repairs a failed fork on text-native memory storage without refusing a valid strict reader", async () => {
    // Memory storage has no raw undecoded bytes, so its exact-text reader
    // remains safe when strict file-backed byte decoding becomes mandatory.
    class RejectOneCloseMemoryStorage extends MemorySessionStorage {
      refuseNextClose = false;

      override openWriter(target: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter {
        const writer = super.openWriter(target, options);
        const actualClose = writer.close.bind(writer);
        writer.close = async () => {
          await actualClose();
          if (this.refuseNextClose) {
            this.refuseNextClose = false;
            throw new Error("synthetic memory source close refusal");
          }
        };
        return writer;
      }
    }

    using temp = TempDir.createSync("@veyyon-fork-memory-strict-read-");
    // The fork's artifact reservation is intentionally on the disposable OS
    // filesystem even though the source JSONL uses the text-only memory store.
    const sessionDir = path.join(temp.path(), "sessions");
    await fs.mkdir(sessionDir, { recursive: true });
    const storage = new RejectOneCloseMemoryStorage();
    const manager = SessionManager.create(
      temp.path(), sessionDir, storage, { instrumentation: "basic" },
    );
    try {
      manager.appendMessage({
        role: "user", content: "Synthetic memory history survives a rejected fork", timestamp: Date.now(),
      });
      await manager.ensureOnDisk();
      manager.appendMessage({
        role: "user", content: "Second synthetic append uses a writer", timestamp: Date.now(),
      });
      await manager.flush();
      const source = manager.getSessionFile();
      const id = manager.getSessionId();
      if (!source) throw new Error("expected memory-backed source journal");
      const before = await storage.readText(source);
      expect(before).toContain("Second synthetic append uses a writer");
      expect(await storage.readTextStrict(source)).toBe(before);
      expect(storage.readTextSyncStrict(source)).toBe(before);

      storage.refuseNextClose = true;
      let failure: unknown;
      try { await manager.fork(); } catch (err) { failure = err; }
      // A successful durable source repair rethrows the original close error.
      // AggregateError is reserved for a failed close PLUS failed restoration.
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain("synthetic memory source close refusal");
      expect(manager.getSessionId()).toBe(id);
      expect(manager.getSessionFile()).toBe(source);
      const after = await storage.readText(source);
      expect(after).toBe(before);
      expect(after).not.toContain('"reason":"session_switched"');
      expect(storage.readTextSyncStrict(source)).toBe(before);
    } finally {
      storage.refuseNextClose = false;
      await manager.close().catch(() => undefined);
    }
  });


  it("refuses a new UTF-8 BOM at the beginning of the original failed-fork journal", async () => {
    using temp = TempDir.createSync("@veyyon-fork-strict-bom-");
    const storage = new SyntheticForkSourceCloseRefusalStorage();
    const manager = SessionManager.create(
      temp.path(), path.join(temp.path(), "sessions"), storage, { instrumentation: "basic" },
    );
    try {
      expect(await manager.saveArtifact("synthetic BOM preservation evidence", "bash")).toBe("0");
      manager.appendMessage({
        role: "user", content: "Keep synthetic artifact://0 intact", timestamp: Date.now(),
      });
      await manager.ensureOnDisk();
      const originalFile = manager.getSessionFile();
      const originalId = manager.getSessionId();
      const artifact = await manager.getArtifactPath("0");
      if (!originalFile || !artifact) throw new Error("expected disposable original and sidecar");
      const archiveBefore = await fs.readFile(artifact);
      const prefixBefore = await fs.readFile(originalFile);
      storage.protectedSourceFile = originalFile;
      storage.prependBomOnRefusal = true;
      storage.rejectNextSourceClose = true;

      // TextDecoder's default ignoreBOM=false strips the BOM: even a fatal
      // decoder then sees clean JSON and may erase these three peer bytes.
      let failure: unknown;
      try { await manager.fork(); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) throw new Error("expected failed-fork rollback refusal");
      const reasons = failure.errors.map((error: unknown) => String(error));
      expect(reasons.some((reason: string) => reason.includes("synthetic source writer-close refusal"))).toBe(true);
      expect(reasons.some((reason: string) =>
        reason.includes("Cannot preserve malformed session journal") ||
        reason.includes("Cannot verify current session journal")
      )).toBe(true);

      const bytes = await fs.readFile(originalFile);
      expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
      expect(bytes.subarray(3, 3 + prefixBefore.length)).toEqual(prefixBefore);
      expect(await fs.readFile(artifact)).toEqual(archiveBefore);
      expect(manager.getSessionId()).toBe(originalId);
      expect(manager.getSessionFile()).toBe(originalFile);
      expect(() => manager.flushSync()).toThrow(/Cannot preserve malformed session journal|Cannot verify current session journal/);
      expect(await fs.readFile(originalFile)).toEqual(bytes);
    } finally {
      storage.rejectNextSourceClose = false;
      storage.prependBomOnRefusal = false;
      await manager.close().catch(() => undefined);
    }
  });

  it("refuses an independent append that collides with an existing session entry ID", async () => {
    using temp = TempDir.createSync("@veyyon-fork-foreign-colliding-id-");
    const storage = new SyntheticForkSourceCloseRefusalStorage();
    const manager = SessionManager.create(
      temp.path(), path.join(temp.path(), "sessions"), storage, { instrumentation: "basic" },
    );
    try {
      expect(await manager.saveArtifact("synthetic colliding-ID preserved sidecar", "bash")).toBe("0");
      manager.appendMessage({
        role: "user", content: "Original entry owning the ID", timestamp: Date.now(),
      });
      await manager.ensureOnDisk();
      const source = manager.getSessionFile();
      const sourceId = manager.getSessionId();
      const artifact = await manager.getArtifactPath("0");
      const originalEntry = manager.getEntries().find(entry => entry.type === "message");
      if (!source || !artifact || !originalEntry) throw new Error("expected original synthetic journal");
      const originalBytes = await fs.readFile(source, "utf8");
      const artifactBytes = await fs.readFile(artifact);
      // The independent writer supplies a valid JSONL record whose single ID
      // collides with one already present in the source file.
      const foreignLine = `${JSON.stringify({
        type: "message", id: originalEntry.id, parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "Independent payload with colliding ID", timestamp: Date.now() },
      })}\n`;
      storage.protectedSourceFile = source;
      storage.appendForeignLineOnRefusal = foreignLine;
      storage.rejectNextSourceClose = true;
      let failure: unknown;
      try { await manager.fork(); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) throw new Error("expected fail-closed duplicate-ID refusal");
      const causes = failure.errors.map((error: unknown) => String(error));
      expect(causes.some((cause: string) => cause.includes("synthetic source writer-close refusal"))).toBe(true);
      expect(causes.some((cause: string) => cause.includes("repeated session journal entry ID"))).toBe(true);
      expect(manager.getSessionFile()).toBe(source);
      expect(manager.getSessionId()).toBe(sourceId);
      const after = await fs.readFile(source, "utf8");
      expect(after.startsWith(originalBytes)).toBe(true);
      expect(after.endsWith(foreignLine)).toBe(true);
      expect(await fs.readFile(artifact)).toEqual(artifactBytes);
      expect(() => manager.flushSync()).toThrow(/repeated session journal entry ID/);
      expect(await fs.readFile(source, "utf8")).toBe(after);
    } finally {
      storage.rejectNextSourceClose = false;
      storage.appendForeignLineOnRefusal = undefined;
      await manager.close().catch(() => undefined);
    }
  });

  it("refuses a same-size in-place title update by an independent writer during failed-fork recovery", async () => {
    using temp = TempDir.createSync("@veyyon-fork-foreign-title-in-place-");
    const storage = new SyntheticForkSourceCloseRefusalStorage();
    const manager = SessionManager.create(
      temp.path(), path.join(temp.path(), "sessions"), storage, { instrumentation: "basic" },
    );
    try {
      expect(await manager.saveArtifact("synthetic in-place title archive", "bash")).toBe("0");
      manager.appendMessage({
        role: "user", content: "Original journal with artifact://0", timestamp: Date.now(),
      });
      await manager.ensureOnDisk();
      const source = manager.getSessionFile();
      const sessionId = manager.getSessionId();
      const artifact = await manager.getArtifactPath("0");
      if (!source || !artifact) throw new Error("expected disposable original journal and archive");
      const savedArtifact = await fs.readFile(artifact);
      const originalBytes = await fs.readFile(source, "utf8");
      const originalStat = nodeFs.statSync(source);
      // The independent writer modifies the fixed-size first slot, with no
      // append, inode replacement or total-length change.
      const foreignSlot = serializeTitleSlot({
        title: "independent synthetic updated title", source: "user", updatedAt: new Date().toISOString(),
      });
      const fd = nodeFs.openSync(source, "r+");
      try {
        const encoded = Buffer.from(foreignSlot, "utf8");
        expect(nodeFs.writeSync(fd, encoded, 0, encoded.length, 0)).toBe(encoded.length);
      } finally {
        nodeFs.closeSync(fd);
      }
      expect(nodeFs.statSync(source).ino).toBe(originalStat.ino);
      expect(nodeFs.statSync(source).size).toBe(originalStat.size);
      const foreignBefore = await fs.readFile(source, "utf8");
      expect(foreignBefore.startsWith(foreignSlot)).toBe(true);
      expect(foreignBefore.slice(foreignSlot.length)).toBe(originalBytes.slice(foreignSlot.length));

      storage.protectedSourceFile = source;
      storage.rejectNextSourceClose = true;
      let failure: unknown;
      try { await manager.fork(); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) throw new Error("expected fail-closed title update refusal");
      const causes = failure.errors.map((error: unknown) => String(error));
      expect(causes.some((cause: string) => cause.includes("synthetic source writer-close refusal"))).toBe(true);
      expect(causes.some((cause: string) => cause.includes("independently modified session title slot"))).toBe(true);
      expect(manager.getSessionFile()).toBe(source);
      expect(manager.getSessionId()).toBe(sessionId);
      const after = await fs.readFile(source, "utf8");
      expect(after.startsWith(foreignSlot)).toBe(true);
      expect(after.slice(foreignSlot.length).startsWith(originalBytes.slice(foreignSlot.length))).toBe(true);
      expect(await fs.readFile(artifact)).toEqual(savedArtifact);
      expect(() => manager.flushSync()).toThrow(/independently modified session title slot/);
      expect(await fs.readFile(source, "utf8")).toBe(after);
    } finally {
      storage.rejectNextSourceClose = false;
      await manager.close().catch(() => undefined);
    }
  });

  it("refuses to recreate a title slot removed by an independent failed-fork writer", async () => {
    using temp = TempDir.createSync("@veyyon-fork-removed-title-slot-");
    const storage = new SyntheticForkSourceCloseRefusalStorage();
    const manager = SessionManager.create(
      temp.path(), path.join(temp.path(), "sessions"), storage, { instrumentation: "basic" },
    );
    try {
      expect(await manager.saveArtifact("synthetic removed-slot archive", "bash")).toBe("0");
      manager.appendMessage({
        role: "user", content: "Preserve original journal artifact://0", timestamp: Date.now(),
      });
      await manager.ensureOnDisk();
      const source = manager.getSessionFile();
      const identity = manager.getSessionId();
      const archive = await manager.getArtifactPath("0");
      if (!source || !archive) throw new Error("expected disposable source and artifact");
      const original = await fs.readFile(source, "utf8");
      const archiveBefore = await fs.readFile(archive);
      const afterSlot = original.indexOf("\n") + 1;
      expect(afterSlot).toBeGreaterThan(1);
      const withoutSlot = original.slice(afterSlot);
      expect(JSON.parse(withoutSlot.split("\n")[0]!).type).toBe("session");

      // A separate writer removes the first fixed-width title record, leaving
      // otherwise parseable legacy-shaped JSONL. Recovery must not reconstruct
      // an old title and erase this independently modified source history.
      await fs.writeFile(source, withoutSlot);
      storage.protectedSourceFile = source;
      storage.rejectNextSourceClose = true;
      let failure: unknown;
      try { await manager.fork(); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) throw new Error("expected missing-slot integrity refusal");
      const reasons = failure.errors.map((error: unknown) => String(error));
      expect(reasons.some((reason: string) => reason.includes("synthetic source writer-close refusal"))).toBe(true);
      expect(reasons.some((reason: string) => reason.includes("missing session title slot"))).toBe(true);
      expect(manager.getSessionId()).toBe(identity);
      expect(manager.getSessionFile()).toBe(source);
      const preserved = await fs.readFile(source, "utf8");
      expect(preserved.startsWith(withoutSlot)).toBe(true);
      expect(await fs.readFile(archive)).toEqual(archiveBefore);
      expect(() => manager.flushSync()).toThrow(/missing session title slot/);
      expect(await fs.readFile(source, "utf8")).toBe(preserved);
    } finally {
      storage.rejectNextSourceClose = false;
      await manager.close().catch(() => undefined);
    }
  });

  it("refuses a second title slot appended by an independent failed-fork writer", async () => {
    using temp = TempDir.createSync("@veyyon-fork-foreign-title-slot-");
    const storage = new SyntheticForkSourceCloseRefusalStorage();
    const manager = SessionManager.create(
      temp.path(), path.join(temp.path(), "sessions"), storage, { instrumentation: "basic" },
    );
    try {
      expect(await manager.saveArtifact("synthetic original title-slot archive", "bash")).toBe("0");
      manager.appendMessage({
        role: "user", content: "Original history with artifact://0", timestamp: Date.now(),
      });
      await manager.ensureOnDisk();
      const source = manager.getSessionFile();
      const identity = manager.getSessionId();
      const archive = await manager.getArtifactPath("0");
      if (!source || !archive) throw new Error("expected original synthetic source and archive");
      const sourceBefore = await fs.readFile(source, "utf8");
      const archiveBefore = await fs.readFile(archive);
      const foreignTitle = serializeTitleSlot({ title: "independent synthetic title", updatedAt: new Date().toISOString() });
      storage.protectedSourceFile = source;
      storage.appendForeignLineOnRefusal = foreignTitle;
      storage.rejectNextSourceClose = true;
      let failure: unknown;
      try { await manager.fork(); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) throw new Error("expected strict title-slot refusal");
      const causes = failure.errors.map((error: unknown) => String(error));
      expect(causes.some((cause: string) => cause.includes("synthetic source writer-close refusal"))).toBe(true);
      expect(causes.some((cause: string) => cause.includes("Cannot preserve unexpected session title slot"))).toBe(true);
      expect(manager.getSessionFile()).toBe(source);
      expect(manager.getSessionId()).toBe(identity);
      const sourceAfter = await fs.readFile(source, "utf8");
      expect(sourceAfter.startsWith(sourceBefore)).toBe(true);
      expect(sourceAfter.endsWith(foreignTitle)).toBe(true);
      expect(await fs.readFile(archive)).toEqual(archiveBefore);
      expect(() => manager.flushSync()).toThrow(/Cannot preserve unexpected session title slot/);
      expect(await fs.readFile(source, "utf8")).toBe(sourceAfter);
    } finally {
      storage.rejectNextSourceClose = false;
      storage.appendForeignLineOnRefusal = undefined;
      await manager.close().catch(() => undefined);
    }
  });

  it("refuses a foreign or duplicate source header during failed-fork repair", async () => {
    for (const variant of ["foreign-header", "duplicate-owner-header"] as const) {
      using temp = TempDir.createSync(`@veyyon-fork-unowned-source-header-${variant}-`);
      const storage = new SyntheticForkSourceCloseRefusalStorage();
      const manager = SessionManager.create(
        temp.path(), path.join(temp.path(), "sessions"), storage, { instrumentation: "basic" },
      );
      try {
        expect(await manager.saveArtifact("synthetic header refusal archive", "bash")).toBe("0");
        manager.appendMessage({
          role: "user", content: "Original journal with artifact://0", timestamp: Date.now(),
        });
        await manager.ensureOnDisk();
        const source = manager.getSessionFile();
        const identity = manager.getSessionId();
        const archive = await manager.getArtifactPath("0");
        if (!source || !archive) throw new Error("expected disposable source and artifact");
        const sourceBefore = await fs.readFile(source, "utf8");
        const archiveBefore = await fs.readFile(archive);
        const foreignHeader = JSON.stringify({
          type: "session", version: CURRENT_SESSION_VERSION,
          id: variant === "foreign-header" ? "synthetic-independent-session" : identity,
          timestamp: new Date().toISOString(), cwd: temp.path(),
        }) + "\n";
        storage.protectedSourceFile = source;
        storage.appendForeignLineOnRefusal = foreignHeader;
        storage.rejectNextSourceClose = true;

        let failure: unknown;
        try { await manager.fork(); } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(AggregateError);
        if (!(failure instanceof AggregateError)) throw new Error("expected fail-closed header refusal");
        const causes = failure.errors.map((error: unknown) => String(error));
        expect(causes.some((cause: string) => cause.includes("synthetic source writer-close refusal"))).toBe(true);
        expect(causes.some((cause: string) => cause.includes("Cannot preserve unexpected session journal header"))).toBe(true);
        expect(manager.getSessionId()).toBe(identity);
        expect(manager.getSessionFile()).toBe(source);
        const sourceAfter = await fs.readFile(source, "utf8");
        expect(sourceAfter.startsWith(sourceBefore)).toBe(true);
        expect(sourceAfter.endsWith(foreignHeader)).toBe(true);
        expect(await fs.readFile(archive)).toEqual(archiveBefore);
        expect(() => manager.flushSync()).toThrow(/Cannot preserve unexpected session journal header/);
        expect(await fs.readFile(source, "utf8")).toBe(sourceAfter);
      } finally {
        storage.rejectNextSourceClose = false;
        storage.appendForeignLineOnRefusal = undefined;
        await manager.close().catch(() => undefined);
      }
    }
  });

  it("refuses altered owned records and interleaved foreign history during failed-fork repair", async () => {
    for (const revision of ["message", "header", "missing-message", "missing-message-with-peer-tail", "foreign-before-header", "foreign-between-owned"] as const) {
      using temp = TempDir.createSync(`@veyyon-fork-owned-revision-${revision}-`);
      const storage = new SyntheticForkSourceCloseRefusalStorage();
      const manager = SessionManager.create(
        temp.path(), path.join(temp.path(), "sessions"), storage, { instrumentation: "basic" },
      );
      try {
        expect(await manager.saveArtifact("disposable owned-revision archive", "bash")).toBe("0");
        manager.appendMessage({
          role: "user", content: "Original same-ID message with artifact://0", timestamp: Date.now(),
        });
        manager.appendMessage({
          role: "user", content: "Second original message must survive removal", timestamp: Date.now(),
        });
        await manager.ensureOnDisk();
        const source = manager.getSessionFile();
        const sessionId = manager.getSessionId();
        const artifact = await manager.getArtifactPath("0");
        if (!source || !artifact) throw new Error("expected synthetic source and archive");
        if (revision === "missing-message-with-peer-tail") {
          // First publish an independent valid record with our own history.
          // Foreign tails disable the reusable byte-offset layout, but must
          // not disable evidence that earlier owned messages were published.
          const peerLine = `${JSON.stringify({
            type: "message", id: "synthetic-foreign-owned-deletion-control", parentId: null,
            timestamp: new Date().toISOString(),
            message: { role: "user", content: "Foreign tail survives failed recovery", timestamp: Date.now() },
          })}\n`;
          await fs.appendFile(source, peerLine);
          await manager.rewriteEntries();
          expect(await fs.readFile(source, "utf8")).toContain(peerLine);
        }
        const original = await fs.readFile(source, "utf8");
        const archiveBytes = await fs.readFile(artifact);
        storage.protectedSourceFile = source;
        storage.rewriteOwnedRecordOnRefusal =
          revision === "missing-message-with-peer-tail" ? "missing-message" : revision;
        storage.rejectNextSourceClose = true;

        let failure: unknown;
        try { await manager.fork(); } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(AggregateError);
        if (!(failure instanceof AggregateError)) throw new Error("expected strict recovery refusal");
        const causes = failure.errors.map((error: unknown) => String(error));
        expect(causes.some((cause: string) => cause.includes("synthetic source writer-close refusal"))).toBe(true);
        const refusal = revision === "header"
          ? "Cannot preserve unexpected session journal header"
          : revision === "foreign-before-header"
            ? "Cannot preserve journal entry before source header during failed-fork repair"
            : revision === "foreign-between-owned"
              ? "Cannot preserve interleaved foreign journal history during failed-fork repair"
              : revision.startsWith("missing-message")
                ? "Cannot preserve missing previously published session entry"
                : "Cannot preserve independently modified session journal entry";
        expect(causes.some((cause: string) => cause.includes(refusal))).toBe(true);

        const observed = await fs.readFile(source, "utf8");
        expect(observed).not.toBe(original);
        if (revision === "foreign-before-header") {
          const first = JSON.parse(observed.split("\n")[0]!) as { id: string };
          expect(first.id).toBe("synthetic-preheader-foreign");
          expect(observed).toContain("Synthetic foreign entry before original header");
          expect(observed).toContain("Original same-ID message with artifact://0");
        } else if (revision === "foreign-between-owned") {
          const first = observed.indexOf("Original same-ID message with artifact://0");
          const peer = observed.indexOf("Synthetic peer inserted between owned messages");
          const second = observed.indexOf("Second original message must survive removal");
          expect(first).toBeGreaterThanOrEqual(0);
          expect(peer).toBeGreaterThan(first);
          expect(second).toBeGreaterThan(peer);
        } else if (revision.startsWith("missing-message")) {
          expect(observed).not.toContain("Original same-ID message with artifact://0");
          expect(observed).toContain("Second original message must survive removal");
          if (revision === "missing-message-with-peer-tail") {
            expect(observed).toContain("Foreign tail survives failed recovery");
          }
        } else {
          expect(observed).toContain(revision === "header"
            ? "synthetic-independent-cwd"
            : "Synthetic independently revised owned message");
        }
        // A failed source-close can append its own aborted lifecycle marker;
        // the complete modified journal must remain recoverable and unchanged.
        expect(manager.getSessionId()).toBe(sessionId);
        expect(manager.getSessionFile()).toBe(source);
        expect(await fs.readFile(artifact)).toEqual(archiveBytes);
        expect(() => manager.flushSync()).toThrow(refusal);
        expect(await fs.readFile(source, "utf8")).toBe(observed);
      } finally {
        storage.rejectNextSourceClose = false;
        storage.rewriteOwnedRecordOnRefusal = undefined;
        await manager.close().catch(() => undefined);
      }
    }
  });

  it("refuses a peer rewrite that reuses an aborted fork marker ID", async () => {
    for (const variant of ["message", "reason"] as const) {
      using temp = TempDir.createSync(`@veyyon-fork-aborted-marker-collision-${variant}-`);
      const storage = new SyntheticForkSourceCloseRefusalStorage();
      const manager = SessionManager.create(
        temp.path(), path.join(temp.path(), "sessions"), storage, { instrumentation: "basic" },
      );
      try {
        expect(await manager.saveArtifact("synthetic marker-collision archive", "bash")).toBe("0");
        manager.appendMessage({
          role: "user", content: "Retain artifact://0 through refused recovery", timestamp: Date.now(),
        });
        await manager.ensureOnDisk();
        const source = manager.getSessionFile();
        const sourceId = manager.getSessionId();
        const artifact = await manager.getArtifactPath("0");
        if (!source || !artifact) throw new Error("expected disposable session and archive");
        const before = await fs.readFile(source, "utf8");
        const artifactBefore = await fs.readFile(artifact);
        storage.protectedSourceFile = source;
        storage.reviseAbortedMarkerOnRefusal = variant;
        storage.rejectNextSourceClose = true;

        let failure: unknown;
        try { await manager.fork(); } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(AggregateError);
        if (!(failure instanceof AggregateError)) throw new Error("expected collision refusal");
        const errors = failure.errors.map((error: unknown) => String(error));
        expect(errors.some((error: string) => error.includes("synthetic source writer-close refusal"))).toBe(true);
        expect(errors.some((error: string) =>
          error.includes("Cannot preserve independently modified aborted fork lifecycle marker")
        )).toBe(true);

        const observed = await fs.readFile(source, "utf8");
        expect(observed).not.toBe(before);
        expect(observed).toContain(variant === "message"
          ? "Synthetic peer with reused aborted marker ID"
          : '"reason":"closed"');
        expect(manager.getSessionFile()).toBe(source);
        expect(manager.getSessionId()).toBe(sourceId);
        expect(await fs.readFile(artifact)).toEqual(artifactBefore);
        expect(() => manager.flushSync()).toThrow(/independently modified aborted fork lifecycle marker/);
        expect(await fs.readFile(source, "utf8")).toBe(observed);
        expect(await fs.readFile(artifact)).toEqual(artifactBefore);
      } finally {
        storage.rejectNextSourceClose = false;
        storage.reviseAbortedMarkerOnRefusal = undefined;
        await manager.close().catch(() => undefined);
      }
    }
  });

  it("refuses duplicate JSON members that could hide independent failed-fork history", async () => {
    // JSON.parse keeps the last duplicate property, including escaped-equivalent
    // names. A peer's earlier entry ID must not be masked by our own ID.
    const variants = ["literal-id", "escaped-id", "nested-content"] as const;
    for (const variant of variants) {
      using temp = TempDir.createSync(`@veyyon-fork-duplicate-id-${variant}-`);
      const storage = new SyntheticForkSourceCloseRefusalStorage();
      const manager = SessionManager.create(
        temp.path(), path.join(temp.path(), "sessions"), storage, { instrumentation: "basic" },
      );
      try {
        expect(await manager.saveArtifact("synthetic artifact survives ambiguous rollback", "bash")).toBe("0");
        manager.appendMessage({
          role: "user", content: "Original owner history with artifact://0", timestamp: Date.now(),
        });
        await manager.ensureOnDisk();
        const sourceFile = manager.getSessionFile();
        const ownerId = manager.getEntries().find(entry => entry.type === "message")?.id;
        const sourceId = manager.getSessionId();
        const artifact = await manager.getArtifactPath("0");
        if (!sourceFile || !ownerId || !artifact) throw new Error("expected disposable original journal");
        const before = await fs.readFile(sourceFile, "utf8");
        const archive = await fs.readFile(artifact);
        const peerId = "independent-unpublished-history";
        const idMembers = variant === "escaped-id"
          ? `"\\u0069d":"${peerId}","id":${JSON.stringify(ownerId)}`
          : variant === "nested-content"
            ? `"id":"${peerId}"`
            : `"id":"${peerId}","id":${JSON.stringify(ownerId)}`;
        const contentMembers = variant === "nested-content"
          ? '"content":"independent original","content":"masked content"'
          : '"content":"independent original"';
        const foreignLine = `{"type":"message",${idMembers},"parentId":null,"timestamp":"2026-11-06T00:00:00.000Z","message":{"role":"user",${contentMembers},"timestamp":1}}` + String.fromCharCode(10);
        storage.protectedSourceFile = sourceFile;
        storage.appendForeignLineOnRefusal = foreignLine;
        storage.rejectNextSourceClose = true;

        let failed: unknown;
        try { await manager.fork(); } catch (error) { failed = error; }
        expect(failed).toBeInstanceOf(AggregateError);
        if (!(failed instanceof AggregateError)) throw new Error("expected failed-fork integrity refusal");
        const causes = failed.errors.map((error: unknown) => String(error));
        expect(causes.some((reason: string) => reason.includes("synthetic source writer-close refusal"))).toBe(true);
        expect(causes.some((reason: string) => reason.includes("Cannot preserve ambiguous session journal"))).toBe(true);
        const preserved = await fs.readFile(sourceFile, "utf8");
        // A rejected fork may leave its own aborted lifecycle marker between
        // the original file and the independent tail; preserve those bytes too.
        expect(preserved.startsWith(before)).toBe(true);
        expect(preserved.endsWith(foreignLine)).toBe(true);
        expect(manager.getSessionId()).toBe(sourceId);
        expect(manager.getSessionFile()).toBe(sourceFile);
        expect(() => manager.flushSync()).toThrow(/Cannot preserve ambiguous session journal/);
        expect(await fs.readFile(sourceFile, "utf8")).toBe(preserved);
        expect(await fs.readFile(artifact)).toEqual(archive);
      } finally {
        storage.rejectNextSourceClose = false;
        storage.appendForeignLineOnRefusal = undefined;
        await manager.close().catch(() => undefined);
      }
    }
  });

  it("fails closed on incomplete or malformed independent JSONL during failed-fork repair", async () => {
    // Reject a partial record, malformed JSON and independent blank lines;
    // none may be silently removed by the aborted-fork repair.
    const variants = [
      ["partial", '{"type":"message","id":"synthetic-incomplete","message":'],
      ["malformed", '{"type":"message","id":"synthetic-malformed",oops}\n'],
      ["blank-line", "\n"],
      ["whitespace-only", " \t\n"],
    ] as const;
    for (const [variant, foreignBytes] of variants) {
      using temp = TempDir.createSync(`@veyyon-fork-unparseable-foreign-${variant}-`);
      const storage = new SyntheticForkSourceCloseRefusalStorage();
      const manager = SessionManager.create(
        temp.path(), path.join(temp.path(), "sessions"), storage, { instrumentation: "basic" },
      );
      try {
        expect(await manager.saveArtifact("synthetic bytes must survive rejected repair", "bash")).toBe("0");
        manager.appendMessage({
          role: "user", content: "Original history with artifact://0", timestamp: Date.now(),
        });
        await manager.ensureOnDisk();
        const sourceFile = manager.getSessionFile();
        const sourceId = manager.getSessionId();
        const artifact = await manager.getArtifactPath("0");
        if (!sourceFile || !artifact) throw new Error("expected disposable source and artifact");
        const priorJournal = await fs.readFile(sourceFile, "utf8");
        const priorArtifact = await fs.readFile(artifact);
        storage.protectedSourceFile = sourceFile;
        storage.appendForeignLineOnRefusal = foreignBytes;
        storage.rejectNextSourceClose = true;

        let failure: unknown;
        try {
          await manager.fork();
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(AggregateError);
        if (!(failure instanceof AggregateError)) throw new Error("expected failed-fork aggregate rejection");
        const causes = failure.errors.map((error: unknown) => String(error));
        expect(causes.some((cause: string) => cause.includes("synthetic source writer-close refusal"))).toBe(true);
        expect(causes.some((cause: string) => /Cannot preserve (incomplete|malformed) session journal/.test(cause))).toBe(true);
        expect(manager.getSessionId()).toBe(sourceId);
        expect(manager.getSessionFile()).toBe(sourceFile);
        const retained = await fs.readFile(sourceFile, "utf8");
        expect(retained.startsWith(priorJournal)).toBe(true);
        expect(retained.endsWith(foreignBytes)).toBe(true);
        // A shutdown/flushSync fallback must not undo the async fail-closed
        // refusal and quietly discard an undecodable foreign tail.
        expect(() => manager.flushSync()).toThrow(/Cannot preserve (incomplete|malformed) session journal/);
        expect(await fs.readFile(sourceFile, "utf8")).toBe(retained);
        expect(await fs.readFile(artifact)).toEqual(priorArtifact);
      } finally {
        storage.rejectNextSourceClose = false;
        storage.appendForeignLineOnRefusal = undefined;
        await manager.close().catch(() => undefined);
      }
    }
  });

  it("refuses to overwrite unreadable foreign history during failed-fork rollback", async () => {
    using temp = TempDir.createSync("@veyyon-fork-unreadable-foreign-tail-");
    const storage = new SyntheticForkSourceCloseRefusalStorage();
    const manager = SessionManager.create(
      temp.path(), path.join(temp.path(), "sessions"), storage, { instrumentation: "basic" },
    );
    try {
      expect(await manager.saveArtifact("synthetic retained archive evidence", "bash")).toBe("0");
      manager.appendMessage({
        role: "user", content: "Original source with artifact://0", timestamp: Date.now(),
      });
      await manager.ensureOnDisk();
      const sourceFile = manager.getSessionFile();
      if (!sourceFile) throw new Error("expected synthetic persisted source");
      const sourceId = manager.getSessionId();
      const sourceArtifact = await manager.getArtifactPath("0");
      if (!sourceArtifact) throw new Error("expected synthetic source artifact");
      const originalArtifact = await fs.readFile(sourceArtifact);

      const foreign: JsonlMessageEntry = {
        type: "message",
        id: "synthetic-unreadable-foreign-tail",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: "user", content: "Foreign history must survive read refusal", timestamp: Date.now(),
        },
      };
      storage.protectedSourceFile = sourceFile;
      storage.appendForeignLineOnRefusal = `${JSON.stringify(foreign)}\n`;
      storage.rejectNextSourceClose = true;
      storage.refuseSourceReadOnClose = true;

      let failure: unknown;
      try {
        await manager.fork();
      } catch (error) {
        failure = error;
      }
      // The fault was consumed by the genuine rollback read, not preflight.
      expect(storage.refuseNextSourceRead).toBe(false);
      expect(failure).toBeInstanceOf(AggregateError);
      const causes = (failure as AggregateError).errors.map((error: unknown) => String(error));
      expect(causes.some(cause => cause.includes("synthetic source writer-close refusal"))).toBe(true);
      expect(causes.some(cause => cause.includes("Cannot verify current session journal"))).toBe(true);
      expect(manager.getSessionId()).toBe(sourceId);
      expect(manager.getSessionFile()).toBe(sourceFile);

      // No extra caller flush: the failed repair must not report success or
      // silently overwrite the independent writer's original journal bytes.
      const disk = await fs.readFile(sourceFile, "utf8");
      expect(disk).toContain("Original source with artifact://0");
      expect(disk).toContain("Foreign history must survive read refusal");
      expect(await fs.readFile(sourceArtifact)).toEqual(originalArtifact);
    } finally {
      storage.rejectNextSourceClose = false;
      storage.refuseSourceReadOnClose = false;
      storage.refuseNextSourceRead = false;
      await manager.close().catch(() => undefined);
    }
  });
});


describe("SessionManager.createBranchedSession fail-closed artifact ownership", () => {
	it("refuses a retained encoded local artifact before changing source identity or evidence", async () => {
		using temp = TempDir.createSync("@veyyon-branch-local-evidence-");
		const source = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
		try {
			const original = "synthetic exact recovery bytes Ω \r\nwith spaces  ";
			expect(await source.saveArtifact(original, "bash")).toBe("0");
			source.appendMessage({
				role: "user", content: "Retain local recovery artifact://%30", timestamp: Date.now(),
			});
			await source.ensureOnDisk();
			const oldFile = source.getSessionFile();
			const oldLeaf = source.getLeafId();
			if (!oldFile || !oldLeaf) throw new Error("expected persisted source and branch leaf");
			const originalId = source.getSessionId();
			const originalState = source.getLifecycleState();
			const originalTranscript = await fs.readFile(oldFile);
			const artifactFile = await source.getArtifactPath("0");
			if (!artifactFile) throw new Error("expected original artifact");
			const originalArtifact = await fs.readFile(artifactFile);
			const sessionFilesBefore = (await fs.readdir(path.dirname(oldFile))).sort();
			const artifactsBefore = (await fs.readdir(path.dirname(artifactFile))).sort();

			expect(() => source.createBranchedSession(oldLeaf)).toThrow(/Cannot branch session: retained local artifact evidence/i);
			expect(source.getSessionId()).toBe(originalId);
			expect(source.getSessionFile()).toBe(oldFile);
			expect(source.getLifecycleState()).toBe(originalState);
			expect(await fs.readFile(oldFile)).toEqual(originalTranscript);
			expect(await fs.readFile(artifactFile)).toEqual(originalArtifact);
			expect((await fs.readdir(path.dirname(oldFile))).sort()).toEqual(sessionFilesBefore);
			expect((await fs.readdir(path.dirname(artifactFile))).sort()).toEqual(artifactsBefore);
		} finally {
			await source.close();
		}
	});

	it("permits an explicit foreign-only branch and rebinds later writes away from an adopted parent", async () => {
		using temp = TempDir.createSync("@veyyon-branch-adopted-evidence-");
		const sessions = path.join(temp.path(), "sessions");
		const parent = SessionManager.create(temp.path(), sessions);
		const child = SessionManager.create(temp.path(), sessions);
		try {
			expect(await parent.saveArtifact("synthetic parent evidence", "bash")).toBe("0");
			const parentFile = await parent.getArtifactPath("0");
			const parentManager = parent.getArtifactManager();
			if (!parentFile || !parentManager) throw new Error("expected parent artifact owner");
			const parentDir = path.dirname(parentFile);
			const parentInventory = (await fs.readdir(parentDir)).sort();
			const parentBytes = await fs.readFile(parentFile);
			const foreignReference = "Foreign recovery: artifact://0?session=other-owned-session";
			child.appendMessage({ role: "user", content: foreignReference, timestamp: Date.now() });
			await child.ensureOnDisk();
			const sourceFile = child.getSessionFile();
			const leaf = child.getLeafId();
			if (!sourceFile || !leaf) throw new Error("expected persisted child and branch leaf");
			const oldChildId = child.getSessionId();
			child.adoptArtifactManager(parentManager);
			expect(child.getArtifactsDir()).toBe(parentDir);

			const branchedFile = child.createBranchedSession(leaf);
			if (!branchedFile) throw new Error("expected new branch file");
			expect(branchedFile).not.toBe(sourceFile);
			expect(child.getSessionFile()).toBe(branchedFile);
			expect(child.getSessionId()).not.toBe(oldChildId);
			expect(child.getArtifactsDir()).toBe(branchedFile.slice(0, -".jsonl".length));
			expect(child.getEntries().some(entry =>
				entry.type === "message" && entry.message.role === "user" &&
				entry.message.content === foreignReference
			)).toBe(true);

			expect(await child.saveArtifact("synthetic new branch evidence", "bash")).toBe("0");
			const branchArtifact = await child.getArtifactPath("0");
			if (!branchArtifact) throw new Error("expected new branch artifact");
			expect(path.dirname(branchArtifact)).not.toBe(parentDir);
			expect(await fs.readFile(branchArtifact, "utf8")).toBe("synthetic new branch evidence");
			expect(await fs.readFile(parentFile)).toEqual(parentBytes);
			expect((await fs.readdir(parentDir)).sort()).toEqual(parentInventory);
		} finally {
			await child.close();
			await parent.close();
		}
	});
});
