import { heapStats } from "bun:jsc";

/**
 * Bytes the JavaScriptCore heap holds after one full collection: its cells plus the memory those
 * cells own outside the heap. Taken on both sides of a step, the difference is what the step left
 * live.
 */
export function liveHeapBytes(): number {
	Bun.gc(true);
	const stats = heapStats();
	return stats.heapSize + stats.extraMemorySize;
}
