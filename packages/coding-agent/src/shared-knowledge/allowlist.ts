import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Forbidden database file extensions and exact basenames.
 * SQLite WAL databases require a single host and must never be synced.
 */
const FORBIDDEN_DB_EXTENSIONS: Record<string, true> = {
	".db": true,
	".db-wal": true,
	".db-shm": true,
	".sqlite": true,
	".sqlite3": true,
	".sqlite-wal": true,
	".sqlite-shm": true,
};

const FORBIDDEN_DB_BASENAMES: Record<string, true> = {
	"agent.db": true,
	"history.db": true,
	"models.db": true,
	"stats.db": true,
	"autoqa.db": true,
	"mnemopi.db": true,
};

/**
 * Forbidden runtime and scratch extensions / patterns.
 */
const FORBIDDEN_RUNTIME_EXTENSIONS: Record<string, true> = {
	".sock": true,
	".pid": true,
	".lock": true,
	".log": true,
};

const FORBIDDEN_RUNTIME_SEGMENTS: Record<string, true> = {
	node_modules: true,
	__pycache__: true,
	".git": true,
	".wt": true,
	cache: true,
	logs: true,
	run: true,
	ipc: true,
	natives: true,
	puppeteer: true,
	"python-env": true,
};

/**
 * Secret patterns in content.
 */
const SECRET_CONTENT_PATTERNS = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/\bsk-[a-zA-Z0-9_-]{20,}\b/,
	/\bghp_[a-zA-Z0-9]{20,}\b/,
	/\bgho_[a-zA-Z0-9]{20,}\b/,
	/\bgithub_pat_[a-zA-Z0-9_-]{20,}\b/,
	/\beyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/,
	/\bbearer\s+[a-zA-Z0-9._~+/-]+=*/i,
	/['"]?(?:api[_-]?(?:token|key)|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token|password|passwd|pwd)['"]?\s*[:=]\s*\S+/i,
	/\bAKIA[A-Z0-9]{16}\b/,
];

export interface ValidationResult {
	valid: boolean;
	reason?: string;
}

/**
 * Normalizes a relative path to forward slashes and strips leading/trailing slashes.
 */
export function normalizeRelativePath(inputPath: string): string {
	return inputPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/**
 * Validates that a relative path does not attempt path traversal,
 * contains no null bytes, and is not an absolute path or UNC path.
 */
export function validateRelativePath(relPath: string): ValidationResult {
	if (!relPath || typeof relPath !== "string") {
		return { valid: false, reason: "Relative path must be a non-empty string" };
	}

	if (relPath.includes("\0")) {
		return { valid: false, reason: "Path contains forbidden null byte" };
	}

	const normalized = normalizeRelativePath(relPath);

	if (normalized.length === 0) {
		return { valid: false, reason: "Path cannot be empty" };
	}

	// Reject absolute paths and Windows drive letters
	if (path.isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath) || relPath.startsWith("//") || relPath.startsWith("\\\\")) {
		return { valid: false, reason: `Absolute or UNC paths are forbidden: ${relPath}` };
	}

	const segments = normalized.split("/");
	for (const segment of segments) {
		if (segment === ".." || segment === ".") {
			return { valid: false, reason: `Path traversal segment '${segment}' is forbidden in: ${relPath}` };
		}
		if (segment.length === 0) {
			return { valid: false, reason: `Empty path segment in: ${relPath}` };
		}
	}

	return { valid: true };
}

/**
 * Checks whether a path corresponds to a forbidden database file.
 */
export function isForbiddenDatabaseFile(relPath: string): boolean {
	const normalized = normalizeRelativePath(relPath);
	const basename = path.basename(normalized).toLowerCase();

	if (basename in FORBIDDEN_DB_BASENAMES) {
		return true;
	}

	for (const ext of Object.keys(FORBIDDEN_DB_EXTENSIONS)) {
		if (basename.endsWith(ext)) {
			return true;
		}
	}

	return false;
}

/**
 * Checks whether a path corresponds to a forbidden secret or credential file.
 */
export function isForbiddenSecretFile(relPath: string): boolean {
	const normalized = normalizeRelativePath(relPath).toLowerCase();
	const basename = path.basename(normalized);

	if (basename === ".env" || basename.startsWith(".env.")) {
		return true;
	}

	if (
		basename === "credentials" ||
		basename === "credentials.json" ||
		basename === "secret" ||
		basename === "secrets.json" ||
		basename === "id_rsa" ||
		basename === "id_ed25519" ||
		basename.endsWith(".pem") ||
		basename.endsWith(".key")
	) {
		return true;
	}

	const segments = normalized.split("/");
	if (segments.includes("shared-auth") || segments.includes(".auth") || segments.includes("credentials")) {
		return true;
	}

	return false;
}

/**
 * Checks whether a path corresponds to a forbidden runtime, cache, or transient file.
 */
export function isForbiddenRuntimeFile(relPath: string): boolean {
	const normalized = normalizeRelativePath(relPath);
	const basename = path.basename(normalized).toLowerCase();

	for (const ext of Object.keys(FORBIDDEN_RUNTIME_EXTENSIONS)) {
		if (basename.endsWith(ext)) {
			return true;
		}
	}

	if (basename.startsWith(".tmp") || basename.endsWith(".tmp")) {
		return true;
	}

	const segments = normalized.split("/");
	for (const seg of segments) {
		if (seg.toLowerCase() in FORBIDDEN_RUNTIME_SEGMENTS) {
			return true;
		}
	}

	return false;
}

/**
 * Scans file content for detected secrets or tokens.
 */
export function scanContentForSecrets(content: string): ValidationResult {
	for (const pattern of SECRET_CONTENT_PATTERNS) {
		if (pattern.test(content)) {
			return {
				valid: false,
				reason: `Content matches forbidden credential/secret pattern: ${pattern.toString()}`,
			};
		}
	}
	return { valid: true };
}

/**
 * Asynchronously verifies that a filesystem path is NOT a symbolic link.
 */
export async function assertNotSymlink(fullPath: string): Promise<ValidationResult> {
	try {
		const stat = await fs.lstat(fullPath);
		if (stat.isSymbolicLink()) {
			return { valid: false, reason: `Symbolic links are forbidden: ${fullPath}` };
		}
		return { valid: true };
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") {
			return { valid: true };
		}
		return { valid: false, reason: `Failed to stat file: ${err.message}` };
	}
}

/**
 * Validates an item for export or import against all security allowlist rules.
 */
export async function validateSecurityAllowlist(
	relPath: string,
	options: { fullPath?: string; content?: string } = {},
): Promise<ValidationResult> {
	const pathCheck = validateRelativePath(relPath);
	if (!pathCheck.valid) {
		return pathCheck;
	}

	if (isForbiddenDatabaseFile(relPath)) {
		return { valid: false, reason: `Database file rejected: ${relPath}` };
	}

	if (isForbiddenSecretFile(relPath)) {
		return { valid: false, reason: `Secret/credential file rejected: ${relPath}` };
	}

	if (isForbiddenRuntimeFile(relPath)) {
		return { valid: false, reason: `Runtime/cache file rejected: ${relPath}` };
	}

	const normalized = normalizeRelativePath(relPath);
	const segments = normalized.split("/");
	const extension = path.extname(normalized).toLowerCase();
	const category = segments[0];
	const allowed = normalized === "config/hindsight-reference.json" ||
		(normalized === "lessons/learned.md") ||
		(["skills", "managed-skills", "rules"].includes(category) && [".md", ".mdc"].includes(extension)) ||
		(category === "workflows" && [".md", ".py", ".mjs", ".sh"].includes(extension));
	if (!allowed || normalized !== relPath || !/^[a-zA-Z0-9_./-]+$/.test(normalized) ||
		segments.some(segment => segment.endsWith(".") || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) {
		return { valid: false, reason: "Path or file type is not syncable" };
	}

	if (options.fullPath) {
		const symlinkCheck = await assertNotSymlink(options.fullPath);
		if (!symlinkCheck.valid) {
			return symlinkCheck;
		}
	}

	if (options.content !== undefined) {
		const contentCheck = scanContentForSecrets(options.content);
		if (!contentCheck.valid) {
			return contentCheck;
		}
	}

	return { valid: true };
}
