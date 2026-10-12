import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheckpointCommand } from "../src/cli/checkpoint-cli";
import { Settings } from "../src/config/settings";

test("separate CLI invocations on one host use independent lease owners", async () => {
	const root = await mkdtemp(join(tmpdir(), "checkpoint-cli-"));
	const file = join(root, "session.jsonl");
	await writeFile(file, `${JSON.stringify({ type: "session", id: "same-host", cwd: root })}\n`);
	await Settings.init({ inMemory: true, overrides: { "checkpoints.enabled": true } });
	const previousFetch = globalThis.fetch;
	const previousEnv = {
		url: process.env.VEYYON_CHECKPOINT_URL,
		token: process.env.VEYYON_CHECKPOINT_TOKEN,
		key: process.env.VEYYON_CHECKPOINT_KEY,
	};
	process.env.VEYYON_CHECKPOINT_URL = "https://checkpoint.invalid";
	process.env.VEYYON_CHECKPOINT_TOKEN = "test";
	process.env.VEYYON_CHECKPOINT_KEY = Buffer.alloc(32).toString("base64");
	const owners: string[] = [];
	globalThis.fetch = async (input, init) => {
		const path = new URL(String(input)).pathname;
		if (path.endsWith("/lease")) {
			const body: unknown = JSON.parse(String(init?.body));
			if (!body || typeof body !== "object" || !("ownerNode" in body) || typeof body.ownerNode !== "string")
				throw new Error("Missing lease owner");
			owners.push(body.ownerNode);
			return Response.json({
				ownerNode: body.ownerNode,
				epoch: owners.length,
				expiresAt: "2099-01-01T00:00:00Z",
				headSequence: 0,
				manifestHash: "",
			});
		}
		if (path.includes("/objects/")) return new Response(null, { status: 201 });
		if (path.endsWith("/head")) return Response.json(null);
		return Response.json({ committed: true });
	};
	try {
		await runCheckpointCommand({ action: "export", sessionFile: file });
		await runCheckpointCommand({ action: "export", sessionFile: file });
		expect(owners).toHaveLength(2);
		expect(owners[0]).not.toBe(owners[1]);
	} finally {
		globalThis.fetch = previousFetch;
		for (const [key, value] of Object.entries({
			VEYYON_CHECKPOINT_URL: previousEnv.url,
			VEYYON_CHECKPOINT_TOKEN: previousEnv.token,
			VEYYON_CHECKPOINT_KEY: previousEnv.key,
		})) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await Settings.init({ inMemory: true });
		await rm(root, { recursive: true, force: true });
	}
});
