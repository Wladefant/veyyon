import { restoreProperty } from "./restore-global";

/**
 * `process.platform` for a suite that exercises another operating system's branch. The descriptor
 * is captured when this module loads, before any suite in the process replaces it, so
 * `restorePlatform` puts back the real platform whatever a suite set in between.
 */
const REAL_PLATFORM = Object.getOwnPropertyDescriptor(process, "platform");

/** Reports `value` as `process.platform` until `restorePlatform` runs. */
export function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}

/** Puts back the real `process.platform`. */
export function restorePlatform(): void {
	restoreProperty(process, "platform", REAL_PLATFORM);
}

/**
 * Runs `run` with `process.platform` reporting `value`, then restores it, including when `run`
 * throws. `run` is synchronous: the platform is restored when it returns.
 */
export function withPlatform(value: NodeJS.Platform, run: () => void): void {
	setPlatform(value);
	try {
		run();
	} finally {
		restorePlatform();
	}
}
