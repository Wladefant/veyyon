/**
 * Holds the event loop for `ms` milliseconds of CPU work, so a stall detector or a stack profiler
 * records it. The stalled-loop suite asserts that the sampled frame starts with this function's
 * name, so a rename changes that suite's expectation.
 *
 * The result is returned so the loop has an observable value and cannot be removed as dead code.
 */
export function holdTheLoopForMs(ms: number): number {
	const until = performance.now() + ms;
	let x = 0;
	while (performance.now() < until) x += Math.sqrt(x + 1);
	return x;
}
