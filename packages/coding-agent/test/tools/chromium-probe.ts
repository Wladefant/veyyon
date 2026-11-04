import { chromiumCanLaunch } from "../helpers/chromium-can-launch";

let probe: Promise<boolean> | undefined;

/**
 * Gate for tests that launch a real Chromium:
 *
 *     const CHROMIUM_AVAILABLE = await chromiumAvailable();
 *     describe.skipIf(!CHROMIUM_AVAILABLE)(…);
 *
 * The result is a promise rather than an awaited `export const`. A module whose
 * exports are initialized by top-level await hands the test runner a binding
 * that is still in its temporal dead zone when a second test file in the same
 * process imports it, and that file dies during registration with "Cannot
 * access 'CHROMIUM_AVAILABLE' before initialization". Awaiting in the importer
 * makes the wait part of that file's own evaluation, which the runner does
 * sequence. The probe runs once per process.
 */
export function chromiumAvailable(): Promise<boolean> {
	probe ??= chromiumCanLaunch();
	return probe;
}
