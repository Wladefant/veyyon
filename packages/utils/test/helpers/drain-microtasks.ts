/**
 * Lets `ticks` rounds of queued promise continuations run, advancing no timer. A suite passes the
 * depth of the promise chain it waits on, so the count at the call site states how many hops the
 * code under test takes before the state the suite asserts.
 */
export async function drainMicrotasks(ticks: number): Promise<void> {
	for (let i = 0; i < ticks; i++) await Promise.resolve();
}
