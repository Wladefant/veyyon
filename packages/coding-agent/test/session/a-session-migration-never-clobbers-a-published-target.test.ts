// WHY: a migration must not delete an occupied target or overwrite a concurrent publication.
// Filesystem hooks inject real competing writes; content assertions, not spy calls, prove preservation.
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
for (const fallback of [false, true]) {
	it(`preserves a publication racing ${fallback ? "exclusive copy" : "hard link"}`, () => {
		const f = fixture();
		const dest = path.join(f.target, "turn.jsonl");
		const originalExists = fs.existsSync;
		const originalLink = fs.linkSync;
		const originalCopy = fs.copyFileSync;
		const publish = () => {
			if (!originalExists(dest)) fs.writeFileSync(dest, "new transcript\n");
		};
		vi.spyOn(fs, "existsSync").mockImplementation(p => {
			const exists = originalExists(p);
			if (p === dest && !exists) publish();
			return exists;
		});
		vi.spyOn(fs, "linkSync").mockImplementation((src, dst) => {
			if (fallback) throw Object.assign(new Error("unsupported link"), { code: "EXDEV" });
			if (dst === dest) publish();
			return originalLink(src, dst);
		});
		vi.spyOn(fs, "copyFileSync").mockImplementation((src, dst, mode) => {
			if (dst === dest) publish();
			return originalCopy(src, dst, mode);
		});
		computeDefaultSessionDir(f.cwd, f.storage, f.sessions);
		expect(fs.readFileSync(dest, "utf8")).toBe("new transcript\n");
		expect(fs.readFileSync(path.join(f.hashed, "turn.jsonl"), "utf8")).toBe("stale transcript\n");
	});
}
for (const code of ["EXDEV", "EPERM"]) {
	it(`recovers with exclusive copy when hard links fail with ${code}`, () => {
		const f = fixture();
		const failure = Object.assign(new Error("unsupported link"), { code });
		vi.spyOn(fs, "linkSync").mockImplementation(() => {
			throw failure;
		});
		vi.spyOn(fs, "renameSync").mockImplementation(() => {
			throw failure;
		});
		computeDefaultSessionDir(f.cwd, f.storage, f.sessions);
		expect(fs.readFileSync(path.join(f.target, "turn.jsonl"), "utf8")).toBe("stale transcript\n");
		expect(fs.existsSync(f.hashed)).toBe(false);
	});
}
it("retains the source after failed fallback copy and recovers on retry", () => {
	const f = fixture();
	const link = vi.spyOn(fs, "linkSync").mockImplementation(() => {
		throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
	});
	const copy = vi.spyOn(fs, "copyFileSync").mockImplementation(() => {
		throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
	});
	computeDefaultSessionDir(f.cwd, f.storage, f.sessions);
	expect(fs.readFileSync(path.join(f.hashed, "turn.jsonl"), "utf8")).toBe("stale transcript\n");
	expect(fs.existsSync(path.join(f.target, "turn.jsonl"))).toBe(false);
	link.mockRestore();
	copy.mockRestore();
	computeDefaultSessionDir(f.cwd, f.storage, f.sessions);
	expect(fs.readFileSync(path.join(f.target, "turn.jsonl"), "utf8")).toBe("stale transcript\n");
	expect(fs.existsSync(f.hashed)).toBe(false);
});
