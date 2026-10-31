import { vi } from "bun:test";
import { logger } from "@veyyon/utils";

/** One captured `logger.warn` call. */
export interface WarnEntry {
	message: string;
	fields?: Record<string, unknown>;
}

/** A live `logger.warn` capture plus its restore hook. */
export interface WarnCapture {
	entries: WarnEntry[];
	restore: () => void;
}

/** Record every `logger.warn` call in `entries` instead of writing it, until `restore`. */
export function captureWarnings(): WarnCapture {
	const entries: WarnEntry[] = [];
	const spy = vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
		entries.push({ message, fields });
	});
	return { entries, restore: () => spy.mockRestore() };
}
