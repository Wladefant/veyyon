/**
 * The base name of the per-user private temp directory: `veyyon-<uid>`, or `veyyon` where the platform has
 * no uid. `privateTempDir()` creates it under the system temp directory. The module imports nothing, so the
 * test temp-directory janitor, which loads before `node:os` may be imported, reads the same name and never
 * removes the directory every process of the user shares.
 */
export function privateTempDirName(uid: number | undefined): string {
	return uid === undefined ? "veyyon" : `veyyon-${uid}`;
}
