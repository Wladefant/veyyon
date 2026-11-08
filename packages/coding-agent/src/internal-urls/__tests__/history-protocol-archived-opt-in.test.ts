/**
 * Caller-bound archived history through the real read tool and registry.
 *
 * The opt-in route must not widen ordinary history behavior: it is a separate
 * per-read capability, and it only reaches registered archived refs in the
 * caller's exact attributed conversation scope.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import { AgentRegistry } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import type { ToolSession } from "../../tools";
import { handleInternalUrl } from "../../tools/fs/read-internal-url";
import type { ReadContext } from "../../tools/fs/read-types";
import { parseSel } from "../../tools/core/path-utils";
import { createHistoryCallerCapability, resolveHistoryCallerCapability } from "../history-caller";
import { HistoryProtocolHandler } from "../history-protocol";
import { InternalUrlRouter } from "../router";
import { registerArtifactsDir, resetRegisteredArtifactDirsForTests } from "../registry-helpers";

const ARCHIVED_UNAVAILABLE = "Archived history is unavailable for this caller and request.";

afterEach(() => {
  AgentRegistry.resetGlobalForTests();
  InternalUrlRouter.resetForTests();
  resetRegisteredArtifactDirsForTests();
});

function registerLiveRef(
  id: string,
  sessionId: string,
  scope: string | undefined,
  kind: "main" | "sub" | "advisor" = "main",
): void {
  const sessionManager = {
    getSessionId: () => sessionId,
    getArtifactsDir: () => null,
  };
  const session = { sessionManager, messages: [] } as unknown as AgentSession;
  AgentRegistry.global().register({
    id,
    displayName: id,
    kind,
    session,
    sessionFile: null,
    scope,
    status: "idle",
  });
}

function makeToolSession(
  id: string,
  getSessionId: () => string | null,
  registry: AgentRegistry = AgentRegistry.global(),
): ToolSession {
  return {
    cwd: process.cwd(),
    settings: { get: () => undefined },
    hasEditTool: false,
    getAgentId: () => id,
    getSessionId,
    agentRegistry: registry,
  } as unknown as ToolSession;
}

function makeReadContext(session: ToolSession): ReadContext {
  return {
    session,
    defaultLimit: 200,
    autoResizeImages: false,
    inspectImageEnabled: false,
  } as ReadContext;
}

async function read(session: ToolSession, url: string): Promise<string> {
  const result = await handleInternalUrl(makeReadContext(session), url, parseSel("raw"));
  return result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map(part => part.text)
    .join("\n");
}

async function archive(
  dir: string,
  id: string,
  sessionId: string,
  entries: Array<{ id: string; parentId: string | null; message: string }>,
): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, id + ".jsonl");
  const lines = [
    JSON.stringify({ type: "session", id: sessionId }),
    ...entries.map(entry => JSON.stringify({ type: "message", ...entry })),
  ];
  await fs.writeFile(file, lines.join("\n") + "\n");
  return file;
}

function registerArchivedRef(
  id: string,
  scope: string,
  sessionFile: string,
  status: "parked" | "aborted" = "parked",
  kind: "main" | "sub" | "advisor" = "sub",
): void {
  AgentRegistry.global().register({
    id,
    displayName: id,
    kind,
    session: null,
    sessionFile,
    scope,
    status,
  });
}

describe("history:// caller-bound archived opt-in", () => {
  it("reads same-scope parked/aborted entries and searches, while the index lists only same-scope parked refs", async () => {
    const temp = TempDir.createSync("@veyyon-history-archived-opt-in-");
    try {
      registerLiveRef("main:a", "session-a", "session-a");
      registerLiveRef("main:b", "session-b", "session-b");
      const caller = makeToolSession("main:a", () => "session-a");

      const scoutFile = await archive(temp.path(), "Scout", "scout-session", [
        { id: "record-one", parentId: null, message: "needle same-scope archived evidence" },
        { id: "record-two", parentId: "record-one", message: "later archived record" },
      ]);
      const abortedFile = await archive(temp.path(), "Aborted", "aborted-session", [
        { id: "aborted-entry", parentId: null, message: "aborted evidence" },
      ]);
      const foreignFile = await archive(temp.path(), "scout", "foreign-session", [
        { id: "foreign-entry", parentId: null, message: "foreign secret evidence" },
      ]);
      const liveFile = await archive(temp.path(), "Live", "live-session", [
        { id: "live-entry", parentId: null, message: "live evidence" },
      ]);
      const advisorFile = await archive(temp.path(), "Advisor", "advisor-session", [
        { id: "advisor-entry", parentId: null, message: "advisor evidence" },
      ]);
      await archive(temp.path(), "DiskOnly", "disk-only-session", [
        { id: "disk-entry", parentId: null, message: "disk-only evidence" },
      ]);
      registerArtifactsDir(temp.path());

      registerArchivedRef("Scout", "session-a", scoutFile, "parked");
      registerArchivedRef("Aborted", "session-a", abortedFile, "aborted");
      registerArchivedRef("Foreign", "session-b", foreignFile, "parked");
      registerArchivedRef("scout", "session-b", foreignFile, "parked");
      registerLiveRef("Live", "live-session", "session-a", "sub");
      AgentRegistry.global().register({
        id: "Live",
        displayName: "Live",
        kind: "sub",
        session: { sessionManager: { getSessionId: () => "live-session" }, messages: [] } as unknown as AgentSession,
        sessionFile: liveFile,
        scope: "session-a",
        status: "idle",
      });
      registerArchivedRef("Advisor", "session-a", advisorFile, "parked", "advisor");

      const exact = JSON.parse(
        await read(caller, "history://Scout?archived=1&entry=record-one&limit=1000"),
      ) as { status: string; fragment?: string; sessionId?: string };
      expect(exact.status).toBe("ok");
      expect(exact.fragment).toContain("needle same-scope archived evidence");
      expect(exact.sessionId).toBe("scout-session");

      const search = JSON.parse(await read(caller, "history://Scout?archived=1&q=needle")) as {
        status: string;
        matches: Array<{ entryId: string }>;
      };
      expect(search.status).toBe("ok");
      expect(search.matches.map(match => match.entryId)).toContain("record-one");

      const aborted = JSON.parse(
        await read(caller, "history://Aborted?archived=1&entry=aborted-entry"),
      ) as { status: string; fragment?: string };
      expect(aborted.status).toBe("ok");
      expect(aborted.fragment).toContain("aborted evidence");

      const index = await read(caller, "history://?archived=1");
      expect(index).toContain("Scout");
      expect(index).not.toContain("Aborted");
      expect(index).not.toContain("Foreign");
      expect(index).not.toContain("scout");
      expect(index).not.toContain("DiskOnly");
      expect(index).not.toContain("Live");
      expect(index).not.toContain("Advisor");

      await expect(read(caller, "history://Foreign?archived=1&entry=foreign-entry")).rejects.toThrow(
        ARCHIVED_UNAVAILABLE,
      );
      await expect(read(caller, "history://scout?archived=1&entry=foreign-entry")).rejects.toThrow(
        ARCHIVED_UNAVAILABLE,
      );
      await expect(read(caller, "history://SCOUT?archived=1&entry=record-one")).rejects.toThrow(
        ARCHIVED_UNAVAILABLE,
      );
      await expect(read(caller, "history://DiskOnly?archived=1&entry=disk-entry")).rejects.toThrow(
        ARCHIVED_UNAVAILABLE,
      );
      await expect(read(caller, "history://Live?archived=1&entry=live-entry")).rejects.toThrow(
        ARCHIVED_UNAVAILABLE,
      );
      await expect(read(caller, "history://Advisor?archived=1&entry=advisor-entry")).rejects.toThrow(
        ARCHIVED_UNAVAILABLE,
      );

      await expect(read(caller, "history://Scout?archived=1")).rejects.toThrow(ARCHIVED_UNAVAILABLE);
      await expect(read(caller, "history://?archived=1&q=needle")).rejects.toThrow(ARCHIVED_UNAVAILABLE);
      await expect(
        read(caller, "history://Scout?archived=1&entry=record-one&q=needle"),
      ).rejects.toThrow(ARCHIVED_UNAVAILABLE);
      await expect(
        read(caller, "history://Scout?archived=1&scope=session-a&entry=record-one"),
      ).rejects.toThrow(ARCHIVED_UNAVAILABLE);
      await expect(
        read(caller, "history://Scout?archived=1&actor=main%3Aa&entry=record-one"),
      ).rejects.toThrow(ARCHIVED_UNAVAILABLE);
      await expect(
        read(caller, "history://Scout?archived=1&archived=1&entry=record-one"),
      ).rejects.toThrow(ARCHIVED_UNAVAILABLE);

      // The opt-in does not relax ordinary history or context-free completions.
      await expect(read(caller, "history://Scout?entry=record-one")).rejects.toThrow(
        /conversations at once/,
      );
      expect(await new HistoryProtocolHandler().complete()).toEqual([]);
    } finally {
      await temp.remove();
    }
  });

  it("requires a live non-advisor caller bound to the exact global registry and revalidates the session", () => {
    registerLiveRef("main:a", "session-a", "session-a");
    let currentSessionId = "session-a";
    const session = makeToolSession("main:a", () => currentSessionId);
    const capability = createHistoryCallerCapability(session);
    expect(resolveHistoryCallerCapability(capability)?.scope).toBe("session-a");

    currentSessionId = "session-b";
    expect(resolveHistoryCallerCapability(capability)).toBeUndefined();

    registerLiveRef("main:mismatch", "session-mismatch", "session-mismatch");
    expect(
      createHistoryCallerCapability(makeToolSession("main:mismatch", () => "stale-session")),
    ).toBeUndefined();

    registerLiveRef("advisor:caller", "advisor-session", "session-a", "advisor");
    expect(
      createHistoryCallerCapability(makeToolSession("advisor:caller", () => "advisor-session")),
    ).toBeUndefined();

    registerLiveRef("sub:unscoped", "unscoped-session", "", "sub");
    expect(
      createHistoryCallerCapability(makeToolSession("sub:unscoped", () => "unscoped-session")),
    ).toBeUndefined();

    const nonGlobalRegistry = {} as AgentRegistry;
    expect(
      createHistoryCallerCapability(makeToolSession("main:a", () => "session-a", nonGlobalRegistry)),
    ).toBeUndefined();

    expect(resolveHistoryCallerCapability(Object.freeze({}))).toBeUndefined();
  });

  it("rejects a caller-supplied ResolveContext object that was not minted at the read seam", async () => {
    registerLiveRef("main:a", "session-a", "session-a");
    registerLiveRef("main:b", "session-b", "session-b");
    const temp = TempDir.createSync("@veyyon-history-forged-context-");
    try {
      const file = await archive(temp.path(), "Scout", "scout-session", [
        { id: "record-one", parentId: null, message: "secret" },
      ]);
      registerArchivedRef("Scout", "session-a", file);
      await expect(
        new HistoryProtocolHandler().resolve(
          new URL("history://Scout?archived=1") as never,
          { historyCaller: Object.freeze({}) as never },
        ),
      ).rejects.toThrow(ARCHIVED_UNAVAILABLE);
    } finally {
      await temp.remove();
    }
  });
});
