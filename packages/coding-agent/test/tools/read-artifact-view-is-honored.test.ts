import * as path from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentToolResult } from "@veyyon/agent-core";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { InternalUrlRouter } from "@veyyon/coding-agent/internal-urls";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { ReadTool } from "@veyyon/coding-agent/tools/fs/read";
import type { ReadToolDetails, ToolSession } from "@veyyon/coding-agent/tools";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

type ReadResult = AgentToolResult<ReadToolDetails>;

type ArtifactMetadata = {
	version: number;
	status: string;
	id: string;
	sessionId: string | null;
	size?: number;
	inlineAvailable?: boolean;
};

function textOutput(result: ReadResult): string {
	return result.content.flatMap(content => content.type === "text" ? [content.text] : []).join("\n");
}

function metadataFrom(result: ReadResult): ArtifactMetadata {
	const text = result.details?.displayContent?.text;
	if (!text) throw new Error("ReadTool did not expose the metadata response");
	return JSON.parse(text) as ArtifactMetadata;
}

describe("read tool artifact view selection", () => {
	let temp: TempDir;
	let caller: SessionManager;
	let other: SessionManager;
	let tool: ReadTool;
	let sharedId: string;
	let otherOnlyId: string;

	async function owner(name: string): Promise<SessionManager> {
		const manager = SessionManager.create(temp.path(), temp.join(name));
		manager.appendMessage({ role: "user", content: name, timestamp: 0 });
		manager.appendMessage({
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "fixture",
			content: [{ type: "text", text: "Persist owner" }],
			stopReason: "stop",
			timestamp: 1,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		await manager.flush();
		AgentRegistry.global().register({
			id: name,
			displayName: name,
			kind: "main",
			scope: manager.getSessionId(),
			session: { sessionManager: manager } as AgentSession,
			sessionFile: manager.getSessionFile() ?? null,
		});
		return manager;
	}

	beforeEach(async () => {
		InternalUrlRouter.resetForTests();
		AgentRegistry.resetGlobalForTests();
		temp = TempDir.createSync("@veyyon-read-artifact-view-");
		caller = await owner("CallerA");
		other = await owner("OtherB");
		sharedId = (await caller.saveArtifact("payload from caller A", "fixture"))!;
		expect(await other.saveArtifact("payload from other B", "fixture")).toBe(sharedId);
		otherOnlyId = (await other.saveArtifact("only payload from other B", "fixture"))!;

		const session: ToolSession = {
			cwd: temp.path(),
			hasUI: false,
			getSessionFile: () => caller.getSessionFile() ?? temp.join("caller.jsonl"),
			getSessionSpawns: () => "*",
			getArtifactsDir: () => caller.getArtifactsDir(),
			localProtocolOptions: {
				getArtifactsDir: () => caller.getArtifactsDir(),
				getSessionId: () => caller.getSessionId(),
			},
			settings: Settings.isolated(),
		};
		tool = new ReadTool(session);
	});

	afterEach(async () => {
		await caller.close();
		await other.close();
		InternalUrlRouter.resetForTests();
		AgentRegistry.resetGlobalForTests();
		await temp.remove();
	});

	it("returns metadata for available, missing, and unavailable owners without artifact bytes", async () => {
		const availableResult = await tool.execute("available", {
			path: `artifact://${sharedId}?view=metadata`,
		});
		const available = metadataFrom(availableResult);
		expect(available).toMatchObject({
			version: 1,
			status: "available",
			id: sharedId,
			sessionId: caller.getSessionId(),
			inlineAvailable: true,
		});
		expect(available.size).toBeGreaterThan(0);
		expect(textOutput(availableResult)).not.toContain("payload from caller A");

		const missingResult = await tool.execute("missing", {
			path: `artifact://${otherOnlyId}?view=metadata`,
		});
		const missing = metadataFrom(missingResult);
		expect(missing).toMatchObject({
			version: 1,
			status: "missing",
			id: otherOnlyId,
			sessionId: caller.getSessionId(),
		});
		expect(textOutput(missingResult)).not.toContain("only payload from other B");

		const unavailableResult = await tool.execute("unavailable", {
			path: `artifact://${sharedId}?session=missing_owner&view=metadata`,
		});
		const unavailable = metadataFrom(unavailableResult);
		expect(unavailable).toMatchObject({
			version: 1,
			status: "unavailable",
			id: sharedId,
			sessionId: "missing_owner",
		});
		expect(textOutput(unavailableResult)).not.toContain("payload from caller A");
	});

	it("rejects unknown and repeated artifact views", async () => {
		await expect(
			tool.execute("unknown-view", { path: `artifact://${sharedId}?view=unknown` }),
		).rejects.toThrow("artifact:// view must be metadata when provided");
		await expect(
			tool.execute("duplicate-view", {
				path: `artifact://${sharedId}?view=metadata&view=metadata`,
			}),
		).rejects.toThrow("artifact:// view must be metadata when provided");
	});

	it("keeps bare IDs caller-scoped and honors an explicit source session through ReadTool", async () => {
		const bare = await tool.execute("bare", { path: `artifact://${sharedId}:raw:1-1` });
		const bareText = textOutput(bare);
		expect(bareText).toContain("payload from caller A");
		expect(bareText).not.toContain("payload from other B");

		const explicit = await tool.execute("explicit", {
			path: `artifact://${sharedId}?session=${other.getSessionId()}:raw:1-1`,
		});
		const explicitText = textOutput(explicit);
		expect(explicitText).toContain("payload from other B");
		expect(explicitText).not.toContain("payload from caller A");
	});
	it("rejects a missing bare caller artifact instead of reading another session's collision", async () => {
		const callerPath = await caller.getArtifactPath(sharedId);
		const callerArtifactsDir = caller.getArtifactsDir();
		if (!callerPath || !callerArtifactsDir) throw new Error("Expected caller artifact path and directory");
		if (path.dirname(path.resolve(callerPath)) !== path.resolve(callerArtifactsDir)) {
			throw new Error("Refusing to unlink outside the caller artifacts directory");
		}
		await fs.unlink(callerPath);

		await expect(tool.execute("missing-caller", { path: `artifact://${sharedId}:raw:1-1` })).rejects.toThrow(/not found/i);

		const explicit = await tool.execute("explicit-other-after-caller-delete", {
			path: `artifact://${sharedId}?session=${other.getSessionId()}:raw:1-1`,
		});
		const explicitText = textOutput(explicit);
		expect(explicitText).toContain("payload from other B");
		expect(explicitText).not.toContain("payload from caller A");
	});

	it("keeps owner selection when following oversized artifact remedies", async () => {
		expect(await caller.saveArtifact("caller filler", "fixture")).toBe(otherOnlyId);
		const callerMatchId = await caller.saveArtifact("payload owned only by caller A", "fixture");
		const oversizedContent = `${"B marker line\n".repeat(3000)}${"x".repeat(8 * 1024 * 1024 + 1)}`;
		const oversizedId = await other.saveArtifact(oversizedContent, "oversized");
		expect(callerMatchId).toBe(oversizedId);

		const blocked = await tool.execute("oversized", {
			path: `artifact://${oversizedId}?session=${other.getSessionId()}:raw`,
		});
		const remedy = textOutput(blocked).match(/Use (artifact:\/\/\S+:raw:1-3000)/);
		expect(remedy?.[1]).toBeDefined();
		if (!remedy?.[1]) throw new Error("Expected a bounded raw artifact remedy URL");
		const followed = await tool.execute("follow-remedy", { path: remedy[1] });
		expect(textOutput(followed)).toContain("B marker line");
		expect(textOutput(followed)).not.toContain("payload owned only by caller A");

		const handlerError = await InternalUrlRouter.instance()
			.resolve(`artifact://${oversizedId}?session=${other.getSessionId()}`)
			.then(() => undefined)
			.catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
		if (!handlerError) throw new Error("Expected artifact protocol oversized-resolution error");
		const handlerRemedy = handlerError.match(/Use read selectors such as (artifact:\/\/\S+:1-3000)/);
		expect(handlerRemedy?.[1]).toBeDefined();
		if (!handlerRemedy?.[1]) throw new Error("Expected a bounded artifact handler remedy URL");
		const handlerFollowed = await tool.execute("follow-handler-remedy", {
			path: handlerRemedy[1],
		});
		expect(textOutput(handlerFollowed)).toContain("B marker line");
		expect(textOutput(handlerFollowed)).not.toContain("payload owned only by caller A");
	});

	it("keeps path-only reads scoped to the explicitly selected source", async () => {
		const resource = await InternalUrlRouter.instance().resolve(
			`artifact://${sharedId}?session=${other.getSessionId()}`,
			{
				localProtocolOptions: {
					getArtifactsDir: () => caller.getArtifactsDir(),
					getSessionId: () => caller.getSessionId(),
				},
				pathOnly: true,
			},
		);
		expect(resource.content).toBe("");
		const artifactPath = await other.getArtifactPath(sharedId);
		if (!artifactPath) throw new Error("Expected the explicitly selected artifact path");
		expect(resource.sourcePath).toBe(artifactPath);
	});
});
