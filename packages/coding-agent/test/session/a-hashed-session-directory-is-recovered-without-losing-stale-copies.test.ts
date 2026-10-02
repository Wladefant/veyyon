// WHY: hashed-layout sessions were stranded when active naming reverted. Exercise real migration,
// including existing targets and conflicting stale copies. Provider/session JSON parsing is not covered.
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { computeDefaultSessionDir } from "../../../../kernel/src/session/session-paths";
import { FileSessionStorage } from "../../../../kernel/src/session/session-storage";

let root: string;
let home: string;
let sessions: string;

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hashed-session-recovery-")));
	home = path.join(root, "home");
	sessions = path.join(root, "sessions");
	fs.mkdirSync(home);
	fs.mkdirSync(sessions);
	vi.spyOn(os, "homedir").mockReturnValue(home);
});

afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("hashed session directories remain discoverable", () => {
	for (const scope of ["home", "tmp", "abs"] as const) {
		it(`recovers stale ${scope} layout and preserves colliding transcripts`, () => {
			const cwd =
				scope === "home"
					? path.join(home, "project with spaces")
					: scope === "tmp"
						? path.join(root, "project with spaces")
						: path.join(path.parse(root).root, "unrelated-project");
			const readable = path
				.basename(cwd)
				.replace(/[^a-zA-Z0-9._-]+/g, "-")
				.replace(/^-+|-+$/g, "")
				.slice(-80);
			const digest = createHash("sha256").update(cwd.replaceAll("\\", "/")).digest("hex");
			const hashed = path.join(sessions, `${scope}-${readable}-${digest}`);
			fs.mkdirSync(hashed);
			fs.writeFileSync(path.join(hashed, "stale.jsonl"), '{"type":"session","version":1}\n');
			const storage = new FileSessionStorage();
			const target = computeDefaultSessionDir(cwd, storage, sessions);
			expect(fs.readFileSync(path.join(target, "stale.jsonl"), "utf8")).toBe('{"type":"session","version":1}\n');
			expect(fs.existsSync(hashed)).toBe(false);
			fs.mkdirSync(hashed);
			fs.writeFileSync(path.join(hashed, "stale.jsonl"), "different stale transcript\n");
			fs.writeFileSync(path.join(hashed, "second.jsonl"), "second transcript\n");
			expect(computeDefaultSessionDir(cwd, storage, sessions)).toBe(target);
			expect(fs.readFileSync(path.join(target, "stale.jsonl"), "utf8")).toBe('{"type":"session","version":1}\n');
			expect(fs.readFileSync(path.join(target, "second.jsonl"), "utf8")).toBe("second transcript\n");
			expect(fs.readFileSync(path.join(hashed, "stale.jsonl"), "utf8")).toBe("different stale transcript\n");
			expect(computeDefaultSessionDir(cwd, storage, sessions)).toBe(target);
			expect(fs.readFileSync(path.join(hashed, "stale.jsonl"), "utf8")).toBe("different stale transcript\n");
		});
	}
});
