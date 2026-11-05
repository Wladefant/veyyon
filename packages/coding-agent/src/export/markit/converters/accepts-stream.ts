import type { StreamInfo } from "../types";

/**
 * Whether a converter for `extensions` and `mimetypes` accepts `streamInfo`:
 * the extension equals one of `extensions`, or the mimetype starts with one of
 * `mimetypes`, so a mimetype that carries parameters
 * (`application/pdf; charset=binary`) still matches.
 */
export function acceptsStream(
	streamInfo: StreamInfo,
	extensions: readonly string[],
	mimetypes: readonly string[],
): boolean {
	if (streamInfo.extension && extensions.includes(streamInfo.extension)) return true;
	const mimetype = streamInfo.mimetype;
	if (!mimetype) return false;
	return mimetypes.some(prefix => mimetype.startsWith(prefix));
}
