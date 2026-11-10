/**
 * Caller-bound archived history through the real read tool and registry.
 *
 * The opt-in route must not widen ordinary history behavior: it is a separate
 * per-read capability, and it only reaches registered archived refs in the
 * caller's exact attributed conversation scope.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import { AgentRegistry } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import type { CreateAgentSessionResult } from "../../session/factory-options";
import { BUILTIN_TOOLS, createAgentSession } from "../../sdk";
import type { ToolSession } from "../../tools";
import { handleInternalUrl } from "../../tools/fs/read-internal-url";
import type { ReadContext } from "../../tools/fs/read-types";
import { parseSel } from "../../tools/core/path-utils";
import { createHistoryCallerCapability, resolveHistoryCallerCapability } from "../history-caller";
import { HistoryProtocolHandler } from "../history-protocol";
import { parseInternalUrl } from "../parse";
import { InternalUrlRouter } from "../router";
import { registerArtifactsDir, resetRegisteredArtifactDirsForTests } from "../registry-helpers";

const ARCHIVED_UNAVAILABLE = "Archived history is unavailable for this caller and request.";
const archivedFixtureSessionIds = new Map<string, string>();

afterEach(() => {
  archivedFixtureSessionIds.clear();
  AgentRegistry.resetGlobalForTests();
  InternalUrlRouter.resetForTests();
  resetRegisteredArtifactDirsForTests();
});

function registerLiveRef(
  id: string,
  sessionId: string,
  scope: string | undefined,
  kind: "main" | "sub" | "advisor" = "main",
  isDisposed: () => boolean = () => false,
): void {
  const sessionManager = {
    getSessionId: () => sessionId,
    getArtifactsDir: () => null,
  };
  const session = {
    sessionManager,
    messages: [],
    get isDisposed() {
      return isDisposed();
    },
  } as unknown as AgentSession;
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
  const ownerSession = registry.get?.(id)?.session ?? undefined;
  return {
    cwd: process.cwd(),
    settings: { get: () => undefined },
    hasEditTool: false,
    getAgentId: () => id,
    getSessionId,
    getOwningAgentSession: () => ownerSession,
    agentRegistry: registry,
  } as unknown as ToolSession;
}

interface SessionWithReadTool {
  result: CreateAgentSessionResult;
  toolSession: ToolSession;
  agentId: string;
}

async function createSessionWithReadTool(
  cwd: string,
  agentDir: string,
  authStorage: AuthStorage,
  sessionManager: SessionManager,
): Promise<SessionWithReadTool> {
  const captured: ToolSession[] = [];
  const buildRead = BUILTIN_TOOLS.read;
  const readFactory = spyOn(BUILTIN_TOOLS, "read").mockImplementation(session => {
    captured.push(session);
    return buildRead(session);
  });
  let result: CreateAgentSessionResult | undefined;
  try {
    const settings = Settings.isolated({ "async.enabled": false, "advisor.enabled": false });
    result = await createAgentSession({
      cwd,
      agentDir,
      sessionManager,
      authStorage,
      modelRegistry: new ModelRegistry(authStorage),
      settings,
      model: getBundledModel("openai", "gpt-4o-mini"),
      disableExtensionDiscovery: true,
      skills: [],
      contextFiles: [],
      workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
      promptTemplates: [],
      slashCommands: [],
      enableMCP: false,
      enableLsp: false,
    });
    const ref = AgentRegistry.global().list().find(candidate => candidate.session === result?.session);
    const toolSession = ref && captured.find(candidate => candidate.getAgentId?.() === ref.id);
    if (!ref || !toolSession) throw new Error("createAgentSession built no primary read ToolSession");
    return { result, toolSession, agentId: ref.id };
  } catch (error) {
    if (result) await result.session.dispose();
    throw error;
  } finally {
    readFactory.mockRestore();
  }
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
  archivedFixtureSessionIds.set(file, sessionId);
  archivedFixtureSessionIds.set(path.resolve(file), sessionId);
  const lines = [
    JSON.stringify({ type: "session", id: sessionId }),
    ...entries.map(entry =>
      JSON.stringify({
        type: "message",
        id: entry.id,
        parentId: entry.parentId,
        message: { role: "user", content: [{ type: "text", text: entry.message }] },
      }),
    ),
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
  const sessionId =
    archivedFixtureSessionIds.get(sessionFile) ??
    archivedFixtureSessionIds.get(path.resolve(sessionFile));
  if (sessionId) {
    const sessionManager = {
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
    };
    const session = { sessionManager } as unknown as AgentSession;
    AgentRegistry.global().register({
      id,
      displayName: id,
      kind,
      session,
      sessionFile,
      scope,
      status: "idle",
    });
    AgentRegistry.global().detachSession(id);
    AgentRegistry.global().setStatus(id, status);
  } else {
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

      const namespacedFile = await archive(temp.path(), "Namespaced", "sub-session", [
        { id: "namespaced-entry", parentId: null, message: "namespaced target evidence" },
      ]);
      registerArchivedRef("sub:session-a", "session-a", namespacedFile, "parked", "sub");
      const namespaced = JSON.parse(
        await read(caller, "history://sub:session-a?archived=1&entry=namespaced-entry"),
      ) as { status: string; fragment?: string };
      expect(namespaced.status).toBe("ok");
      expect(namespaced.fragment).toContain("namespaced target evidence");

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

  it("rejects unscoped refs for archived opt-in while preserving legacy single-scope history", async () => {
    const temp = TempDir.createSync("@veyyon-history-unscoped-compat-");
    try {
      registerLiveRef("main:a", "session-a", "session-a");
      const caller = makeToolSession("main:a", () => "session-a");
      const sessionFile = await archive(temp.path(), "LegacyUnscoped", "legacy-session", [
        { id: "legacy-entry", parentId: null, message: "needle legacy unscoped evidence" },
      ]);

      // An unattributed registry ref is not eligible for the caller-bound
      // archived route, even when it is the only parked transcript on disk.
      AgentRegistry.global().register({
        id: "LegacyUnscoped",
        displayName: "LegacyUnscoped",
        kind: "sub",
        session: null,
        sessionFile,
        status: "parked",
      });
      await expect(
        read(caller, "history://LegacyUnscoped?archived=1&entry=legacy-entry"),
      ).rejects.toThrow(ARCHIVED_UNAVAILABLE);
      const archivedIndex = await read(caller, "history://?archived=1");
      expect(archivedIndex).not.toContain("LegacyUnscoped");

      // Until #774 makes an explicit compatibility decision, the ordinary
      // single-known-scope route keeps its historical index/overview/exact
      // behavior rather than silently denying or inventing this ref's scope.
      const legacyIndex = await read(caller, "history://");
      expect(legacyIndex).toContain("LegacyUnscoped");
      const legacyOverview = await read(caller, "history://LegacyUnscoped");
      expect(legacyOverview).toContain("legacy unscoped evidence");
      const legacyExact = JSON.parse(
        await read(caller, "history://LegacyUnscoped?entry=legacy-entry"),
      ) as { status: string; fragment?: string };
      expect(legacyExact.status).toBe("ok");
      expect(legacyExact.fragment).toContain("legacy unscoped evidence");
    } finally {
      await temp.remove();
    }
  });

  it("paginates a bounded archived index and rejects stale continuation cursors", async () => {
    registerLiveRef("main:a", "session-a", "session-a");
    const caller = makeToolSession("main:a", () => "session-a");
    for (let i = 0; i < 205; i++) {
      const id = "Archived-" + String(i).padStart(3, "0");
      registerArchivedRef(id, "session-a", "/synthetic/" + id + ".jsonl");
    }

    const first = await read(caller, "history://?archived=1&limit=100");
    expect(Buffer.byteLength(first, "utf-8")).toBeLessThanOrEqual(24_000);
    expect(first).toContain('`"Archived-000"`');
    expect(first).toContain('`"Archived-099"`');
    expect(first).not.toContain('`"Archived-100"`');
    const firstNext = first.match(/history:\/\/\?archived=1&offset=(\d+)&limit=100&revision=([a-f0-9]{64})/);
    expect(firstNext).toBeDefined();
    const secondOffset = Number(firstNext?.[1]);
    const revision = firstNext?.[2];
    expect(secondOffset).toBe(100);
    expect(revision).toBeDefined();

    const second = await read(
      caller,
      "history://?archived=1&offset=" + secondOffset + "&limit=100&revision=" + revision,
    );
    expect(second).toContain('`"Archived-100"`');
    expect(second).toContain('`"Archived-199"`');
    expect(second).not.toContain('`"Archived-200"`');
    const secondNext = second.match(/history:\/\/\?archived=1&offset=(\d+)&limit=100&revision=([a-f0-9]{64})/);
    expect(secondNext).toBeDefined();
    expect(Number(secondNext?.[1])).toBe(200);
    expect(secondNext?.[2]).toBe(revision);

    const third = await read(
      caller,
      "history://?archived=1&offset=200&limit=100&revision=" + revision,
    );
    expect(third).toContain('`"Archived-200"`');
    expect(third).toContain('`"Archived-204"`');
    expect(third).not.toMatch(/Next page:/);

    const combined = first + "\n" + second + "\n" + third;
    const ids = [...combined.matchAll(/- `("Archived-\d{3}")` —/g)].map(match => JSON.parse(match[1]!));
    expect(ids).toHaveLength(205);
    expect(new Set(ids).size).toBe(205);

    registerArchivedRef("Archived-205", "session-a", "/synthetic/Archived-205.jsonl");
    await expect(
      read(caller, "history://?archived=1&offset=100&limit=100&revision=" + revision),
    ).rejects.toThrow(ARCHIVED_UNAVAILABLE);
    await expect(read(caller, "history://?archived=1&offset=100&limit=100")).rejects.toThrow(
      ARCHIVED_UNAVAILABLE,
    );
    await expect(read(caller, "history://?archived=1&limit=101")).rejects.toThrow(ARCHIVED_UNAVAILABLE);
  });

  it("caps archived index pages by UTF-8 bytes for long registered IDs", async () => {
    registerLiveRef("main:a", "session-a", "session-a");
    const caller = makeToolSession("main:a", () => "session-a");
    const expectedIds = Array.from(
      { length: 50 },
      (_, i) => "Long-" + String(i).padStart(2, "0") + "-" + "x".repeat(900),
    );
    for (const [i, id] of expectedIds.entries()) {
      registerArchivedRef(id, "session-a", "/synthetic/long-" + i + ".jsonl");
    }

    let offset = 0;
    let revision: string | undefined;
    let pageCount = 0;
    const actualIds: string[] = [];
    for (let pageIndex = 0; pageIndex < 50; pageIndex++) {
      const request =
        "history://?archived=1&offset=" +
        offset +
        "&limit=100" +
        (revision === undefined ? "" : "&revision=" + revision);
      const page = await read(caller, request);
      pageCount++;
      expect(Buffer.byteLength(page, "utf-8")).toBeLessThanOrEqual(24_000);

      const pageRevision = page.match(/^Revision: .([a-f0-9]{64}).$/m)?.[1];
      expect(pageRevision).toBeDefined();
      if (revision !== undefined) expect(pageRevision).toBe(revision);
      else revision = pageRevision;

      const summary = page.match(/Showing (\d+) of 50 parked agents \(offset (\d+)\)/);
      expect(summary).toBeDefined();
      const shown = Number(summary?.[1]);
      expect(Number(summary?.[2])).toBe(offset);
      expect(shown).toBeGreaterThan(0);

      const ids = [...page.matchAll(/- .("Long-\d{2}-x+"). —/g)].map(match => JSON.parse(match[1]!));
      expect(ids).toHaveLength(shown);
      actualIds.push(...ids);

      const next = page.match(
        /Next page: .history:\/\/\?archived=1&offset=(\d+)&limit=(\d+)&revision=([a-f0-9]{64})./,
      );
      if (!next) {
        expect(offset + shown).toBe(50);
        break;
      }

      const nextOffset = Number(next[1]);
      expect(nextOffset).toBe(offset + shown);
      expect(Number(next[2])).toBe(100);
      expect(next[3]).toBe(revision!);
      offset = nextOffset;
    }

    expect(pageCount).toBeGreaterThan(1);
    expect(actualIds).toHaveLength(50);
    expect(new Set(actualIds).size).toBe(50);
    expect(new Set(actualIds)).toEqual(new Set(expectedIds));

    registerArchivedRef("z".repeat(1_025), "session-a", "/synthetic/oversized-id.jsonl");
    await expect(read(caller, "history://?archived=1")).rejects.toThrow(ARCHIVED_UNAVAILABLE);
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

    let disposed = true;
    registerLiveRef("main:disposed", "disposed-session", "session-a", "main", () => disposed);
    expect(
      createHistoryCallerCapability(makeToolSession("main:disposed", () => "disposed-session")),
    ).toBeUndefined();

    let disposing = false;
    registerLiveRef(
      "main:disposing",
      "disposing-session",
      "session-a",
      "main",
      () => disposing,
    );
    const disposingSession = makeToolSession("main:disposing", () => "disposing-session");
    const disposingCapability = createHistoryCallerCapability(disposingSession);
    expect(disposingCapability).toBeDefined();
    disposing = true;
    expect(resolveHistoryCallerCapability(disposingCapability)).toBeUndefined();

    const nonGlobalRegistry = {} as AgentRegistry;
    expect(
      createHistoryCallerCapability(makeToolSession("main:a", () => "session-a", nonGlobalRegistry)),
    ).toBeUndefined();

    expect(resolveHistoryCallerCapability(Object.freeze({}))).toBeUndefined();
  });

  it("does not let a stale ToolSession mint archived authority after same-transcript revival", async () => {
    const temp = TempDir.createSync("@veyyon-history-stale-tool-session-");
    let authStorage: AuthStorage | undefined;
    let first: SessionWithReadTool | undefined;
    let revived: SessionWithReadTool | undefined;
    try {
      const cwd = temp.join("project");
      await Bun.write(`${cwd}/.keep`, "");
      authStorage = await AuthStorage.create(temp.join("testauth.db"));
      authStorage.setRuntimeApiKey("openai", "test-key");

      const sessionFile = SessionManager.createEmptySessionFile(cwd);
      first = await createSessionWithReadTool(
        cwd,
        temp.path(),
        authStorage,
        await SessionManager.open(sessionFile, undefined, undefined, {
          initialCwd: cwd,
          suppressBreadcrumb: true,
        }),
      );
      const sessionId = first.result.session.sessionManager.getSessionId();
      expect(first.result.session.sessionManager.getSessionFile()).toBe(sessionFile);
      expect(sessionId).toBeTruthy();
      expect(sessionFile).toBeTruthy();
      expect(first.toolSession.getOwningAgentSession?.()).toBe(first.result.session);
      first.result.session.sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "same-transcript revival marker" }],
        timestamp: Date.now(),
      });
      await first.result.session.sessionManager.flush();
      const beforeRevival = createHistoryCallerCapability(first.toolSession);
      expect(beforeRevival).toBeDefined();

      // The same transcript and stable IDs are reopened under a new AgentSession.
      await first.result.session.dispose();
      const reopened = await SessionManager.open(sessionFile!, undefined, undefined, {
        initialCwd: cwd,
        suppressBreadcrumb: true,
      });
      revived = await createSessionWithReadTool(cwd, temp.path(), authStorage, reopened);
      expect(revived.agentId).toBe(first.agentId);
      expect(revived.result.session.sessionManager.getSessionId()).toBe(sessionId);
      expect(revived.toolSession.getOwningAgentSession?.()).toBe(revived.result.session);
      expect(revived.toolSession.getOwningAgentSession?.()).not.toBe(first.toolSession.getOwningAgentSession?.());

      const archivedFile = await archive(temp.path(), "Scout", "archived-session", [
        { id: "record-one", parentId: null, message: "same-transcript revival evidence" },
      ]);
      registerArtifactsDir(temp.path());
      registerArchivedRef("Scout", sessionId, archivedFile);

      // Stable IDs now resolve to the replacement actor, never to the disposed ToolSession owner.
      expect(createHistoryCallerCapability(first.toolSession)).toBeUndefined();
      expect(resolveHistoryCallerCapability(beforeRevival)).toBeUndefined();
      await expect(
        read(first.toolSession, "history://Scout?archived=1&entry=record-one"),
      ).rejects.toThrow(ARCHIVED_UNAVAILABLE);

      const current = JSON.parse(
        await read(revived.toolSession, "history://Scout?archived=1&entry=record-one"),
      ) as { status: string; fragment?: string };
      expect(current.status).toBe("ok");
      expect(current.fragment).toContain("same-transcript revival evidence");
    } finally {
      if (revived) await revived.result.session.dispose();
      if (first) await first.result.session.dispose();
      authStorage?.close();
      await temp.remove();
    }
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
      const handler = new HistoryProtocolHandler();
      const url = parseInternalUrl("history://Scout?archived=1&entry=record-one");
      const validCapability = createHistoryCallerCapability(makeToolSession("main:a", () => "session-a"));
      expect(validCapability).toBeDefined();
      const valid = await handler.resolve(url, { historyCaller: validCapability });
      expect(valid.content).toContain("secret");

      await expect(
        handler.resolve(url, { historyCaller: Object.freeze({}) as never }),
      ).rejects.toThrow(ARCHIVED_UNAVAILABLE);
    } finally {
      await temp.remove();
    }
  });
  it("refuses a case-fold alias that becomes ambiguous during an archived scan but keeps exact IDs usable", async () => {
    const temp = TempDir.createSync("@veyyon-history-alias-race-");
    try {
      registerLiveRef("main:a", "session-a", "session-a");
      const caller = makeToolSession("main:a", () => "session-a");
      const targetDir = path.join(temp.path(), "target");
      const foreignDir = path.join(temp.path(), "foreign");
      const targetFile = await archive(targetDir, "Scout", "scout-session", [
        { id: "record-one", parentId: null, message: "same-scope evidence" },
      ]);
      const foreignFile = await archive(foreignDir, "SCOUT", "foreign-session", [
        { id: "foreign-entry", parentId: null, message: "foreign evidence" },
      ]);
      registerArchivedRef("Scout", "session-a", targetFile);

      // Positive control: exact lookup succeeds before collision is injected
      const exactInitial = JSON.parse(
        await read(caller, "history://Scout?archived=1&entry=record-one"),
      ) as { status: string; fragment?: string };
      expect(exactInitial.status).toBe("ok");
      expect(exactInitial.fragment).toContain("same-scope evidence");
      // Inject colliding SCOUT identity during real handle.read via fs.open spy.
      // The initial alias lookup sees one target; post-scan revalidation must see the collision.
      let collisionHookFired = false;
      const originalFsOpen = fs.open;
      const aliasOpenSpy = spyOn(fs, "open").mockImplementation(async (...openArgs) => {
        const handle = await originalFsOpen(...openArgs);
        const originalRead = handle.read.bind(handle);
        handle.read = async function (...readArgs) {
          if (!collisionHookFired) {
            collisionHookFired = true;
            registerArchivedRef("SCOUT", "session-b", foreignFile);
          }
          return Reflect.apply(originalRead, handle, readArgs);
        };
        return handle;
      });
      try {
        await expect(
          read(caller, "history://scout?archived=1&entry=record-one"),
        ).rejects.toThrow(ARCHIVED_UNAVAILABLE);
      } finally {
        aliasOpenSpy.mockRestore();
      }

      expect(collisionHookFired).toBe(true);
      // An exact same-scope ID remains usable despite a foreign case-fold alias.
      const exact = JSON.parse(
        await read(caller, "history://Scout?archived=1&entry=record-one"),
      ) as { status: string; fragment?: string };
      expect(exact.status).toBe("ok");
      expect(exact.fragment).toContain("same-scope evidence");
    } finally {
      await temp.remove();
    }
  });

  it("accepts an exact limit roster of 100,000 eligible parked same-scope refs", async () => {
    registerLiveRef("main:a", "session-a", "session-a");
    const caller = makeToolSession("main:a", () => "session-a");

    for (let i = 0; i < 100_000; i++) {
      registerArchivedRef("Archived-" + String(i).padStart(6, "0"), "session-a", "/synthetic/" + i + ".jsonl");
    }

    const firstPage = await read(caller, "history://?archived=1");
    expect(firstPage).toContain("Showing 50 of 100000 parked agents (offset 0).");
  });

  it("rejects a roster with 100,001 eligible parked same-scope refs before sorting/digest and forbids eager registry.list", async () => {
    registerLiveRef("main:a", "session-a", "session-a");
    const caller = makeToolSession("main:a", () => "session-a");

    for (let i = 0; i < 100_001; i++) {
      registerArchivedRef("Archived-" + String(i).padStart(6, "0"), "session-a", "/synthetic/" + i + ".jsonl");
    }
    const firstRef = AgentRegistry.global().get("Archived-000000")!;
    Object.defineProperty(firstRef, "lastActivity", {
      get() {
        throw new Error("Overflow roster hashed before refusal");
      },
    });
    const localeCompareSpy = spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("Overflow roster sorted before refusal");
    });

    const poisonRef = AgentRegistry.global().register({
      id: "zzz-poison-tail",
      displayName: "zzz-poison-tail",
      kind: "sub",
      session: null,
      sessionFile: "/synthetic/poison.jsonl",
      scope: "session-a",
      status: "parked",
    });
    for (const prop of ["kind", "status", "scope", "sessionFile", "id", "lastActivity"] as const) {
      Object.defineProperty(poisonRef, prop, {
        get() {
          throw new Error(`Poison-tail ref inspected property '${prop}' after cap`);
        },
      });
    }

    const listSpy = spyOn(AgentRegistry.prototype, "list").mockImplementation(() => {
      throw new Error("Eager registry.list() snapshot is forbidden; use lazy iteration");
    });

    try {
      await expect(read(caller, "history://?archived=1")).rejects.toThrow(ARCHIVED_UNAVAILABLE);
    } finally {
      localeCompareSpy.mockRestore();
      listSpy.mockRestore();
    }
  });
  it("refuses an eligible parked same-scope ref with oversized ID before sort or digest", async () => {
    registerLiveRef("main:a", "session-a", "session-a");
    const caller = makeToolSession("main:a", () => "session-a");

    registerArchivedRef("Archived-valid", "session-a", "/synthetic/valid.jsonl");
    const oversizedId = "Archived-" + "x".repeat(1025);
    const oversizedRef = AgentRegistry.global().register({
      id: oversizedId,
      displayName: oversizedId,
      kind: "sub",
      session: null,
      sessionFile: "/synthetic/oversized.jsonl",
      scope: "session-a",
      status: "parked",
    });

    Object.defineProperty(oversizedRef, "lastActivity", {
      get() {
        throw new Error("Oversized ID hashed before refusal");
      },
    });

    const localeCompareSpy = spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("Oversized ID sorted before refusal");
    });

    try {
      await expect(read(caller, "history://?archived=1")).rejects.toThrow(ARCHIVED_UNAVAILABLE);
    } finally {
      localeCompareSpy.mockRestore();
    }
  });

  it("refuses an incoming host ID exceeding 1024 UTF-8 bytes before registry lookup", async () => {
    const temp = TempDir.createSync("@veyyon-history-oversized-host-");
    try {
      registerLiveRef("main:a", "session-a", "session-a");
      const caller = makeToolSession("main:a", () => "session-a");
      const oversizedId = "Archived-" + "y".repeat(1025);
      const targetFile = await archive(temp.path(), "oversized-target", "oversized-session", [
        { id: "record-one", parentId: null, message: "oversized record" },
      ]);
      registerArchivedRef(oversizedId, "session-a", targetFile);

      let getCalledForOversized = false;
      const originalGet = AgentRegistry.prototype.get;
      const getSpy = spyOn(AgentRegistry.prototype, "get").mockImplementation(function (this: AgentRegistry, id: string) {
        if (Buffer.byteLength(id, "utf-8") > 1024) {
          getCalledForOversized = true;
          throw new Error("registry.get called for oversized incoming agentId");
        }
        return originalGet.call(this, id);
      });

      try {
        await expect(
          read(caller, `history://${oversizedId}?archived=1&entry=record-one`),
        ).rejects.toThrow(ARCHIVED_UNAVAILABLE);
      } finally {
        getSpy.mockRestore();
      }

      expect(getCalledForOversized).toBe(false);
    } finally {
      await temp.remove();
    }
  });

  it("never calls registry.list for large missing or ambiguous alias lookups and enforces scan bounds", async () => {
    registerLiveRef("main:a", "session-a", "session-a");
    const caller = makeToolSession("main:a", () => "session-a");

    for (let i = 0; i < 100_001; i++) {
      registerArchivedRef("Archived-" + String(i).padStart(6, "0"), "session-a", "/synthetic/" + i + ".jsonl");
    }
    registerArchivedRef("Ambiguous-Target", "session-a", "/synthetic/ambig1.jsonl");
    registerArchivedRef("AMBIGUOUS-TARGET", "session-a", "/synthetic/ambig2.jsonl");

    const listSpy = spyOn(AgentRegistry.prototype, "list").mockImplementation(() => {
      throw new Error("registry.list() must not be called during alias lookup");
    });

    try {
      await expect(
        read(caller, "history://missing-agent-alias?archived=1&entry=record-one"),
      ).rejects.toThrow(ARCHIVED_UNAVAILABLE);

      await expect(
        read(caller, "history://ambiguous-target?archived=1&entry=record-one"),
      ).rejects.toThrow(ARCHIVED_UNAVAILABLE);
    } finally {
      listSpy.mockRestore();
    }
  });

  it("enforces provenance: rejects overwritten header ID, symlinks, foreign path, restored ref with no live identity, and async race mutations", async () => {
    const temp = TempDir.createSync("@veyyon-history-p1-provenance-");
    try {
      registerLiveRef("main:a", "session-a", "session-a");
      const caller = makeToolSession("main:a", () => "session-a");

      const validDir = path.join(temp.path(), "trusted");
      const validFile = await archive(validDir, "Target", "trusted-session", [
        { id: "record-1", parentId: null, message: "trusted content needle" },
      ]);
      registerArchivedRef("Target", "session-a", validFile, "parked");

      // Positive controls: exact and search work before any mutation
      const exactBefore = JSON.parse(
        await read(caller, "history://Target?archived=1&entry=record-1"),
      ) as { status: string; fragment?: string; sessionId?: string };
      expect(exactBefore.status).toBe("ok");
      expect(exactBefore.fragment).toContain("trusted content needle");
      expect(exactBefore.sessionId).toBe("trusted-session");

      const searchBefore = JSON.parse(
        await read(caller, "history://Target?archived=1&q=needle"),
      ) as { status: string; matches: Array<{ entryId: string }> };
      expect(searchBefore.status).toBe("ok");
      expect(searchBefore.matches.map(m => m.entryId)).toContain("record-1");

      // 1. Overwrite header with foreign ID (both exact and search must fail)
      const overwrittenFile = await archive(path.join(temp.path(), "overwritten"), "Overwritten", "trusted-session", [
        { id: "record-1", parentId: null, message: "needle content" },
      ]);
      registerArchivedRef("Overwritten", "session-a", overwrittenFile, "parked");
      const content = await fs.readFile(overwrittenFile, "utf-8");
      const lines = content.split("\n");
      lines[0] = JSON.stringify({ type: "session", id: "foreign-session-id" });
      await fs.writeFile(overwrittenFile, lines.join("\n"));

      await expect(
        read(caller, "history://Overwritten?archived=1&entry=record-1"),
      ).rejects.toThrow(ARCHIVED_UNAVAILABLE);
      await expect(
        read(caller, "history://Overwritten?archived=1&q=needle"),
      ).rejects.toThrow(ARCHIVED_UNAVAILABLE);


      // 2. Replace file with symlink to foreign file
      const foreignDir = path.join(temp.path(), "foreign");
      const foreignFile = await archive(foreignDir, "Foreign", "foreign-session", [
        { id: "record-foreign", parentId: null, message: "foreign needle" },
      ]);
      const symlinkTargetFile = await archive(path.join(temp.path(), "symlink-src"), "SymlinkTarget", "symlink-session", [
        { id: "record-1", parentId: null, message: "symlink needle" },
      ]);
      registerArchivedRef("SymlinkTarget", "session-a", symlinkTargetFile, "parked");

      let symlinkCreated = false;
      try {
        await fs.unlink(symlinkTargetFile);
        await fs.symlink(foreignFile, symlinkTargetFile);
        symlinkCreated = true;
      } catch (err: unknown) {
        let isPermissionDenial = false;
        if (typeof err === "object" && err !== null && "code" in err) {
          const code = Reflect.get(err, "code");
          if (code === "EPERM" || code === "EACCES") {
            isPermissionDenial = true;
          }
        }
        if (!isPermissionDenial) {
          throw err;
        }
      }
      if (symlinkCreated) {
        await expect(
          read(caller, "history://SymlinkTarget?archived=1&entry=record-foreign"),
        ).rejects.toThrow(ARCHIVED_UNAVAILABLE);
        await expect(
          read(caller, "history://SymlinkTarget?archived=1&q=needle"),
        ).rejects.toThrow(ARCHIVED_UNAVAILABLE);
      } else {
        // Unprivileged Windows environments without Developer Mode cannot create symlinks
        expect(process.platform).toBe("win32");
      }

      // 3. Path string changed to foreign directory
      const foreignPathFile = await archive(path.join(temp.path(), "orig-dir"), "ForeignPathTarget", "foreign-path-session", [
        { id: "record-1", parentId: null, message: "foreign path needle" },
      ]);
      registerArchivedRef("ForeignPathTarget", "session-a", foreignPathFile, "parked");
      const targetRef = AgentRegistry.global().get("ForeignPathTarget")!;
      targetRef.sessionFile = foreignFile;
      await expect(
        read(caller, "history://ForeignPathTarget?archived=1&entry=record-foreign"),
      ).rejects.toThrow(ARCHIVED_UNAVAILABLE);

      // 4. Restored ref with no live identity refused
      const restoredFile = await archive(path.join(temp.path(), "restored"), "RestoredNoLive", "restored-session", [
        { id: "record-1", parentId: null, message: "restored needle" },
      ]);
      AgentRegistry.global().register({
        id: "RestoredNoLive",
        displayName: "RestoredNoLive",
        kind: "sub",
        session: null,
        sessionFile: restoredFile,
        scope: "session-a",
        status: "parked",
      });
      await expect(
        read(caller, "history://RestoredNoLive?archived=1&entry=record-1"),
      ).rejects.toThrow(ARCHIVED_UNAVAILABLE);

      // 5. Deterministic async race revalidation:
      // Use spy fs.open to wrap handle.read once and unregister/replace target during real suspended read,
      // asserting generic refusal for both exact and search.
      const raceFile = await archive(path.join(temp.path(), "race"), "RaceTarget", "race-session", [
        { id: "record-1", parentId: null, message: "race needle" },
      ]);
      registerArchivedRef("RaceTarget", "session-a", raceFile, "parked");

      // 5a. Exact: unregister target during real suspended handle.read
      let exactRaceHookActive = true;
      const originalFsOpen = fs.open;
      const exactOpenSpy = spyOn(fs, "open").mockImplementation(async (...openArgs) => {
        const handle = await originalFsOpen(...openArgs);
        if (exactRaceHookActive) {
          const originalRead = handle.read.bind(handle);
          handle.read = async function (...readArgs) {
            if (exactRaceHookActive) {
              exactRaceHookActive = false;
              AgentRegistry.global().unregister("RaceTarget");
            }
            return Reflect.apply(originalRead, handle, readArgs);
          };
        }
        return handle;
      });
      try {
        await expect(
          read(caller, "history://RaceTarget?archived=1&entry=record-1"),
        ).rejects.toThrow(ARCHIVED_UNAVAILABLE);
      } finally {
        exactOpenSpy.mockRestore();
      }

      // 5b. Search: mutate target status to running via mirrorStatus during real suspended handle.read
      registerArchivedRef("RaceSearchTarget", "session-a", raceFile, "parked");
      let searchRaceHookActive = true;
      let searchHookFired = false;
      const searchOpenSpy = spyOn(fs, "open").mockImplementation(async (...openArgs) => {
        const handle = await originalFsOpen(...openArgs);
        if (searchRaceHookActive) {
          const originalRead = handle.read.bind(handle);
          handle.read = async function (...readArgs) {
            if (searchRaceHookActive) {
              searchRaceHookActive = false;
              searchHookFired = true;
              AgentRegistry.global().mirrorStatus("RaceSearchTarget", "running");
            }
            return Reflect.apply(originalRead, handle, readArgs);
          };
        }
        return handle;
      });
      try {
        await expect(
          read(caller, "history://RaceSearchTarget?archived=1&q=needle"),
        ).rejects.toThrow(ARCHIVED_UNAVAILABLE);
        expect(searchHookFired).toBe(true);
        expect(AgentRegistry.global().get("RaceSearchTarget")?.status).toBe("running");
      } finally {
        searchOpenSpy.mockRestore();
      }
    } finally {
      await temp.remove();
    }
  });

  it("rejects same-directory substitution when mutated parked ref points to replacement file with matching session ID", async () => {
    const temp = TempDir.createSync("@veyyon-history-same-dir-sub-");
    try {
      registerLiveRef("main:a", "session-a", "session-a");
      const caller = makeToolSession("main:a", () => "session-a");
      const validDir = path.join(temp.path(), "trusted");

      const origFile = await archive(validDir, "SameDirSub", "same-dir-session", [
        { id: "orig-entry", parentId: null, message: "orig needle" },
      ]);
      registerArchivedRef("SameDirSub", "session-a", origFile, "parked");

      // Assert positive control for original file before mutation
      const sameDirExactBefore = JSON.parse(
        await read(caller, "history://SameDirSub?archived=1&entry=orig-entry"),
      ) as { status: string; fragment?: string };
      expect(sameDirExactBefore.status).toBe("ok");
      expect(sameDirExactBefore.fragment).toContain("orig needle");
      const sameDirSearchBefore = JSON.parse(
        await read(caller, "history://SameDirSub?archived=1&q=orig"),
      ) as { status: string; matches: Array<{ entryId: string }> };
      expect(sameDirSearchBefore.status).toBe("ok");
      expect(sameDirSearchBefore.matches.map(m => m.entryId)).toContain("orig-entry");

      // Replacement file in the same directory sharing the exact same session header ID
      const replacementFile = await archive(validDir, "SameDirReplacement", "same-dir-session", [
        { id: "replacement-entry", parentId: null, message: "replacement needle" },
      ]);
      // Mutate the parked ref's sessionFile to point to replacement file
      const sameDirRef = AgentRegistry.global().get("SameDirSub")!;
      sameDirRef.sessionFile = replacementFile;

      await expect(
        read(caller, "history://SameDirSub?archived=1&entry=replacement-entry"),
      ).rejects.toThrow(ARCHIVED_UNAVAILABLE);
      await expect(
        read(caller, "history://SameDirSub?archived=1&q=needle"),
      ).rejects.toThrow(ARCHIVED_UNAVAILABLE);
    } finally {
      await temp.remove();
    }
  });

  it("rejects archived session files with malformed or duplicate-key prefix lines before valid session header", async () => {
    const temp = TempDir.createSync("@veyyon-history-prefix-corrupt-");
    try {
      registerLiveRef("main:a", "session-a", "session-a");
      const caller = makeToolSession("main:a", () => "session-a");

      // 1. Malformed prefix before valid session header (both exact and search must fail closed)
      const malformedPrefixFile = path.join(temp.path(), "malformed-prefix.jsonl");
      archivedFixtureSessionIds.set(malformedPrefixFile, "prefix-session-1");
      await fs.writeFile(
        malformedPrefixFile,
        [
          "{ malformed json prefix line",
          JSON.stringify({ type: "session", id: "prefix-session-1" }),
          JSON.stringify({
            type: "message",
            id: "prefix-entry-1",
            parentId: null,
            message: { role: "user", content: [{ type: "text", text: "needle in prefix 1" }] },
          }),
        ].join("\n") + "\n",
      );
      registerArchivedRef("MalformedPrefix", "session-a", malformedPrefixFile, "parked");
      await expect(
        read(caller, "history://MalformedPrefix?archived=1&entry=prefix-entry-1"),
      ).rejects.toThrow(ARCHIVED_UNAVAILABLE);
      await expect(
        read(caller, "history://MalformedPrefix?archived=1&q=needle"),
      ).rejects.toThrow(ARCHIVED_UNAVAILABLE);

      // 2. Duplicate-key prefix before valid session header (both exact and search must fail closed)
      const dupKeyPrefixFile = path.join(temp.path(), "dup-key-prefix.jsonl");
      archivedFixtureSessionIds.set(dupKeyPrefixFile, "prefix-session-2");
      await fs.writeFile(
        dupKeyPrefixFile,
        [
          '{"key": 1, "key": 2}',
          JSON.stringify({ type: "session", id: "prefix-session-2" }),
          JSON.stringify({
            type: "message",
            id: "prefix-entry-2",
            parentId: null,
            message: { role: "user", content: [{ type: "text", text: "needle in prefix 2" }] },
          }),
        ].join("\n") + "\n",
      );
      registerArchivedRef("DupKeyPrefix", "session-a", dupKeyPrefixFile, "parked");
      await expect(
        read(caller, "history://DupKeyPrefix?archived=1&entry=prefix-entry-2"),
      ).rejects.toThrow(ARCHIVED_UNAVAILABLE);
      await expect(
        read(caller, "history://DupKeyPrefix?archived=1&q=needle"),
      ).rejects.toThrow(ARCHIVED_UNAVAILABLE);
    } finally {
      await temp.remove();
    }
  });
});
