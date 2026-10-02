// WHY: migration must preserve occupied targets and concurrent atomic source/target rewrites.
// Real FileSessionStorage writers race publication; source copies are deliberately retained.
import { afterEach, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { computeDefaultSessionDir } from "../../../../kernel/src/session/session-paths";
import { FileSessionStorage } from "../../../../kernel/src/session/session-storage";

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "migration-no-clobber-")));
	roots.push(root);
	vi.spyOn(os, "homedir").mockReturnValue(root);
	const cwd = path.join(root, "project");
	const sessions = path.join(root, "sessions");
	const storage = new FileSessionStorage();
	const target = computeDefaultSessionDir(cwd, storage, sessions);
	const digest = createHash("sha256").update(cwd.replaceAll("\\", "/")).digest("hex");
	const hashed = path.join(sessions, `home-project-${digest}`);
	fs.mkdirSync(hashed);
	fs.writeFileSync(path.join(hashed, "turn.jsonl"), "stale transcript\n");
	return { cwd, sessions, storage, target, hashed };
}
it("never removes a non-directory migration target", () => {
	const f = fixture();
	fs.rmdirSync(f.target);
	fs.writeFileSync(f.target, "occupied target\n");
	expect(() => computeDefaultSessionDir(f.cwd, f.storage, f.sessions)).toThrow();
	expect(fs.readFileSync(f.target, "utf8")).toBe("occupied target\n");
	expect(fs.readFileSync(path.join(f.hashed, "turn.jsonl"), "utf8")).toBe("stale transcript\n");
});
it("preserves a target atomically published immediately before exclusive copy", () => {
	const f = fixture();
	const dest = path.join(f.target, "turn.jsonl");
	const originalCopy = fs.copyFileSync;
	vi.spyOn(fs, "copyFileSync").mockImplementation((src, dst, mode) => {
		if (dst === dest) f.storage.writeTextSync(dest, "new target transcript\n");
		return originalCopy(src, dst, mode);
	});
	computeDefaultSessionDir(f.cwd, f.storage, f.sessions);
	expect(fs.readFileSync(dest, "utf8")).toBe("new target transcript\n");
	expect(fs.readFileSync(path.join(f.hashed, "turn.jsonl"), "utf8")).toBe("stale transcript\n");
});
it("retains the source after failed copy and recovers on retry", () => {
	const f = fixture();
	const copy = vi.spyOn(fs, "copyFileSync").mockImplementation(() => {
		throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
	});
	computeDefaultSessionDir(f.cwd, f.storage, f.sessions);
	expect(fs.readFileSync(path.join(f.hashed, "turn.jsonl"), "utf8")).toBe("stale transcript\n");
	expect(fs.existsSync(path.join(f.target, "turn.jsonl"))).toBe(false);
	copy.mockRestore();
	computeDefaultSessionDir(f.cwd, f.storage, f.sessions);
	expect(fs.readFileSync(path.join(f.target, "turn.jsonl"), "utf8")).toBe("stale transcript\n");
	expect(fs.readFileSync(path.join(f.hashed, "turn.jsonl"), "utf8")).toBe("stale transcript\n");
});
it("retains an atomic source rewrite after publication and on subsequent migration", () => {
	const f = fixture();
	const source = path.join(f.hashed, "turn.jsonl");
	const originalCopy = fs.copyFileSync;
	vi.spyOn(fs, "copyFileSync").mockImplementation((src, dst, mode) => {
		originalCopy(src, dst, mode);
		f.storage.writeTextSync(source, "fresh source transcript\n");
	});
	computeDefaultSessionDir(f.cwd, f.storage, f.sessions);
	expect(fs.readFileSync(source, "utf8")).toBe("fresh source transcript\n");
	expect(fs.readFileSync(path.join(f.target, "turn.jsonl"), "utf8")).toBe("stale transcript\n");
	computeDefaultSessionDir(f.cwd, f.storage, f.sessions);
	expect(fs.readFileSync(source, "utf8")).toBe("fresh source transcript\n");
});
it("copies nested artifacts without consuming their originals", () => {
	const f = fixture();
	fs.mkdirSync(path.join(f.hashed, "artifacts"));
	fs.writeFileSync(path.join(f.hashed, "artifacts", "note.txt"), "artifact\n");
	computeDefaultSessionDir(f.cwd, f.storage, f.sessions);
	expect(fs.readFileSync(path.join(f.target, "artifacts", "note.txt"), "utf8")).toBe("artifact\n");
	expect(fs.readFileSync(path.join(f.hashed, "artifacts", "note.txt"), "utf8")).toBe("artifact\n");
});
