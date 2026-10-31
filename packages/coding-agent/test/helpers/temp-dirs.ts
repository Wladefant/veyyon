import { afterEach } from "bun:test";
import { TempDir } from "@veyyon/utils";

/**
 * A maker of temp directories, each removed after the test that made it. Call at module or
 * `describe` scope; the returned function takes a name prefix and returns the new directory's path.
 */
export function useTempDirs(): (prefix: string) => string {
	const dirs: TempDir[] = [];
	afterEach(async () => {
		await Promise.all(dirs.splice(0).map(dir => dir.remove()));
	});
	return prefix => {
		const dir = TempDir.createSync(prefix);
		dirs.push(dir);
		return dir.path();
	};
}
