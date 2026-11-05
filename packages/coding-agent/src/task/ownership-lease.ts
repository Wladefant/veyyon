import path from "node:path";
import { canonicalIsolationPath } from "./isolation-ownership";

export interface OwnershipLeaseRequest {
	paths: string[];
	expiresAt: string;
}

export interface OwnershipLease extends OwnershipLeaseRequest {
	version: 1;
	grantor: string;
	owner: string;
	worktree: string;
}

/** Coordination authority only: this record never changes filesystem permissions. */
export async function createOwnershipLease(
	request: OwnershipLeaseRequest,
	grantor: string,
	owner: string,
	cwd: string,
): Promise<OwnershipLease> {
	const expiry = Date.parse(request.expiresAt);
	if (!Number.isFinite(expiry) || expiry <= Date.now()) {
		throw new Error("expiry must be a future timestamp");
	}
	if (request.paths.length === 0) throw new Error("at least one path is required");
	const worktree = await canonicalIsolationPath(cwd);
	const paths: string[] = [];
	for (const requested of request.paths) {
		if (!requested.trim()) throw new Error("paths must not be empty");
		const granted = await canonicalIsolationPath(path.resolve(worktree, requested));
		const relative = path.relative(worktree, granted);
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
			throw new Error("path is outside the child's worktree");
		}
		paths.push(granted);
	}
	if (expiry <= Date.now()) throw new Error("lease expired while resolving paths");
	return { version: 1, grantor, owner, worktree, paths, expiresAt: new Date(expiry).toISOString() };
}
