import * as path from "node:path";
import { parseYaml } from "./yaml-sync";

/**
 * Parse a config file's text as YAML or JSON, choosing by its extension.
 *
 * It lives in its own module rather than in `json.ts` because `json.ts` is on the collab web client's
 * import graph, and YAML parsing reaches for `Bun.YAML`, which a browser bundle does not have. Splitting
 * it keeps the JSON helpers usable in a browser and costs the two config readers one import path.
 *
 * Every config surface in the product accepts both spellings, so every reader needs this one decision.
 * The LSP and DAP config readers each had a byte-identical private copy of it, which is a spelling of
 * "both files accept `.yaml`, `.yml` and everything else as JSON" that nothing kept in agreement.
 *
 * Parse errors are NOT swallowed. A malformed config must reach the caller so it can name the file and
 * the line: a reader that returned null here would silently ignore a config the user is looking at.
 * {@link parseYaml} states a YAML syntax error with its line and column.
 */
export function parseJsonOrYamlByExtension(content: string, filePath: string): unknown {
	const extension = path.extname(filePath).toLowerCase();
	if (extension === ".yaml" || extension === ".yml") {
		return parseYaml(content);
	}
	return JSON.parse(content) as unknown;
}
