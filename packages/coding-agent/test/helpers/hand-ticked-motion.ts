import { beforeEach } from "bun:test";
import { motionClock } from "@veyyon/utils/motion";
import { useSpyTeardown } from "./spy-teardown";

const FRAME_MS = 1000 / 60;
/** MOTION.hover is 90ms; 30 frames is half a second, so a settle loop that runs out of them is a hang. */
const DEFAULT_SETTLE_FRAMES = 30;

/** The process-wide motion clock, advanced by hand. */
export interface HandTickedMotion {
	/** Move time forward by `ms` and tick the shared clock once. */
	advance(ms: number): void;
	/** Tick frame by frame until nothing is animating and return the frames it took. Throws past `maxFrames`. */
	settle(maxFrames?: number): number;
}

/**
 * Drive the process-wide `motionClock` frame by frame, with `performance.now()` pinned to the time
 * this harness has advanced to.
 *
 * The clock reads `performance.now()` when an animation registers and measures the first frame from
 * that reading. A harness that ticks from a wall-clock anchor of its own, taken after the
 * registration, hands that first frame every millisecond the test spent rendering in between. On a
 * loaded runner that exceeds a 90ms fade, the fade lands in one step, and a mid-fade frame reads as
 * the settled one. Pinned, a frame advances by the milliseconds the test names, and the clock's own
 * interval, which reads the same pinned time, advances nothing.
 *
 * Every test starts on an idle clock: an animation another suite left live keeps the ticker's base
 * at a wall-clock time this harness never set.
 *
 * Call at module scope, above the file's own `afterEach` hooks, so the spy is restored before them.
 */
export function useHandTickedMotion(): HandTickedMotion {
	const teardown = useSpyTeardown();
	let now = 0;
	beforeEach(() => {
		motionClock.clear();
		now = performance.now();
		teardown.spy(performance, "now").mockImplementation(() => now);
	});
	const advance = (ms: number): void => {
		now += ms;
		motionClock.tick(now);
	};
	return {
		advance,
		settle(maxFrames = DEFAULT_SETTLE_FRAMES) {
			for (let frame = 1; frame <= maxFrames; frame++) {
				advance(FRAME_MS);
				if (motionClock.liveCount === 0) return frame;
			}
			throw new Error(`motion still live after ${maxFrames} frames`);
		},
	};
}
