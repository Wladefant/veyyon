import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	CURRENT_SESSION_VERSION,
	type SessionHeader,
	type SessionMessageEntry,
} from "@veyyon/kernel/session/session-entries";
import { loadEntriesFromFile } from "@veyyon/kernel/session/session-loader";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
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
      await source.flush();
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
      await source.flush();
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
      await source.flush();
      const sourceFile = source.getSessionFile();
      if (!sourceFile) throw new Error("expected persisted source");
      const sourceBefore = await fs.readFile(sourceFile, "utf8");

      forked = await SessionManager.forkFrom(sourceFile, cwd, sessions, undefined, {
        suppressBreadcrumb: true,
      });
      expect(forked.getEntries().some(entry =>
        entry.type === "message" && entry.message.role === "user" && entry.message.content === message
      )).toBe(true);
      expect(await forked.getArtifactPath("0")).toBeUndefined();
      expect(await forked.saveArtifact("new local output", "bash")).toBe("0");
      expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBefore);
    } finally {
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

  it("copies the original evidence before switching and keeps the next artifact ID distinct", async () => {
    using temp = TempDir.createSync("@veyyon-fork-archive-");
    const manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
    try {
      const id = await manager.saveArtifact(originalBytes, "bash");
      expect(id).toBe("0");
      manager.appendMessage({
        role: "user", content: "Restore the recorded [full output](artifact://0)", timestamp: Date.now(),
      });
      await manager.flush();
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
      await manager.flush();
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

  it("refuses a referenced artifact that became a directory without changing the original session", async () => {
    using temp = TempDir.createSync("@veyyon-fork-invalid-artifact-");
    const manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
    try {
      const id = await manager.saveArtifact(originalBytes, "bash");
      expect(id).toBe("0");
      manager.appendMessage({
        role: "user", content: "Recorded evidence: artifact://0", timestamp: Date.now(),
      });
      await manager.flush();
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
      await manager.flush();
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
      await manager.flush();
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
        await manager.flush();
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

  it("fails closed for missing local evidence with case-insensitive artifact schemes", async () => {
    for (const scheme of ["ARTIFACT", "ArTiFaCt"]) {
      using temp = TempDir.createSync("@veyyon-fork-artifact-scheme-");
      const manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
      try {
        manager.appendMessage({
          role: "user", content: `Preserve the recorded ${scheme}://0 evidence`, timestamp: Date.now(),
        });
        await manager.flush();
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
      await manager.flush();
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
