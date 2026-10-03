import { afterEach, describe, expect, test, vi } from "bun:test";
import * as connectionManager from "@veyyon/coding-agent/ssh/connection-manager";
import * as sshfsMount from "@veyyon/coding-agent/ssh/sshfs-mount";
import { formatOutputNotice } from "@veyyon/coding-agent/tools/core/output-meta";
import { SshTool } from "@veyyon/coding-agent/tools/shell/ssh";
import { type ChildProcess, ptree } from "@veyyon/utils";
import { useIsolatedAgentDir } from "./helpers/isolated-agent-dir";
import { makeToolSession } from "./helpers/tool-session";

useIsolatedAgentDir({ globalSettings: true });
afterEach(() => vi.restoreAllMocks());

function createTool(exitCode?: number) {
	vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue();
	vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
		version: 4,
		os: "linux",
		shell: "bash",
		compatEnabled: false,
	});
	vi.spyOn(connectionManager, "buildRemoteCommand").mockResolvedValue(["remote", "printf text"]);
	vi.spyOn(sshfsMount, "hasSshfs").mockReturnValue(false);
	const pendingExit = Promise.withResolvers<number>();
	const child = {
		stdout: new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(`MARK\n${"x".repeat(200_000)}`));
				if (exitCode !== undefined) controller.close();
			},
		}),
		stderr: undefined,
		exited: exitCode === undefined ? pendingExit.promise : Promise.resolve(exitCode),
		[Symbol.dispose]() {},
	} as unknown as ChildProcess<"pipe">;
	vi.spyOn(ptree, "spawn").mockImplementation(() => child);
	const host = { name: "remote", host: "remote" };
	const session = makeToolSession({
		cwd: process.cwd(),
		hasUI: false,
		settings: { get: () => undefined },
		allocateOutputArtifact: async () => ({ path: "/dev/full", id: "unusable-ssh" }),
		getSessionFile: () => null,
	});
	return new SshTool(session, [host.name], new Map([[host.name, host]]), "test transport");
}

function expectCaptureWarning(text: string) {
	expect(text).toContain("Full output was not saved completely");
	expect(text.match(/Full output was not saved completely/g)).toHaveLength(1);
	expect(text).not.toContain("unusable-ssh");
}

describe("SSH artifact errors reach the model", () => {
	for (const exitCode of [0, 1]) {
		test(`keeps the capture warning when SSH exits ${exitCode}`, async () => {
			const tool = createTool(exitCode);
			let text: string;
			if (exitCode === 0) {
				const result = await tool.execute("ssh-capture", { host: "remote", command: "printf text", timeout: 30 });
				text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
				text += formatOutputNotice(result.details?.meta);
			} else {
				const error = await tool
					.execute("ssh-capture", { host: "remote", command: "printf text", timeout: 30 })
					.then(() => undefined, error => error);
				expect(error).toBeInstanceOf(Error);
				text = (error as Error).message;
				expect(text).toContain("code 1");
			}
			expectCaptureWarning(text);
		});
	}

	test("keeps the capture warning when SSH is cancelled after output starts", async () => {
		const tool = createTool();
		const controller = new AbortController();
		const streamed = Promise.withResolvers<void>();
		const execution = tool.execute(
			"ssh-cancel",
			{ host: "remote", command: "printf text", timeout: 30 },
			controller.signal,
			() => streamed.resolve(),
		);
		const rejected = execution.then(() => undefined, error => error);
		await streamed.promise;
		controller.abort("user interrupt");
		const error = await rejected;
		expect(error).toBeInstanceOf(Error);
		const text = (error as Error).message;
		expect(text).toContain("Command aborted");
		expectCaptureWarning(text);
	});
});
