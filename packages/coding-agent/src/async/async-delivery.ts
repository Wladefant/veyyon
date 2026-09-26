import { errorMessage, logger } from "@veyyon/utils";
import { truncateMiddle } from "../session/streaming-output";
import type { OutputMeta } from "../tools/core/output-meta";

export const ASYNC_INLINE_RESULT_MAX_CHARS = 12_000;
export const ASYNC_PREVIEW_MAX_CHARS = 4_000;
/**
 * Tail share of the preview when the link points at a raw capture: tools append
 * notices (wall time, exit code, timeout) after the captured stream.
 */
export const ASYNC_PREVIEW_TAIL_CHARS = 1_000;

export interface ArtifactAllocator {
	allocateArtifactPath(toolType: string): Promise<{ id?: string; path?: string }>;
}

export async function formatAsyncResultForFollowUp(
	result: string,
	meta?: OutputMeta,
	allocator?: ArtifactAllocator,
): Promise<string> {
	if (result.length <= ASYNC_INLINE_RESULT_MAX_CHARS) {
		return result;
	}

	// The producing tool's output sink already mirrored the raw stream to an
	// artifact; `result` is its elided inline body, so link the raw capture.
	// The capture lacks notices the tool appended after the stream (exit code,
	// wall time, timeout), so the preview keeps `result`'s tail as well.
	const rawArtifactId = meta?.truncation?.artifactId ?? meta?.limits?.columnTruncated?.artifactId;
	if (rawArtifactId) {
		const headTail = truncateMiddle(result, {
			maxBytes: ASYNC_PREVIEW_MAX_CHARS,
			maxHeadBytes: ASYNC_PREVIEW_MAX_CHARS - ASYNC_PREVIEW_TAIL_CHARS,
		}).content;
		return `${headTail}\nFull output: artifact://${rawArtifactId}`;
	}

	const preview = `${result.slice(0, ASYNC_PREVIEW_MAX_CHARS)}\n\n[Output truncated. Showing first ${ASYNC_PREVIEW_MAX_CHARS.toLocaleString()} characters.]`;
	if (allocator) {
		try {
			const { path: artifactPath, id: artifactId } = await allocator.allocateArtifactPath("async");
			if (artifactPath && artifactId) {
				await Bun.write(artifactPath, result);
				return `${preview}\nFull output: artifact://${artifactId}`;
			}
		} catch (error) {
			logger.warn("Failed to persist async follow-up artifact", {
				error: errorMessage(error),
			});
		}
	}

	return preview;
}
