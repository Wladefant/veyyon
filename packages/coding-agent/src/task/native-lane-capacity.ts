const MAX_NATIVE_LANES = 100;
const activeLanes = new Map<string, number>();

/** A retained turn can borrow its own active lane, but never waits for another lane to finish. */
export function reserveNativeLane(agentId: string, transcript: string): () => void {
	const key = `${agentId}\0${transcript}`;
	const holders = activeLanes.get(key) ?? 0;
	if (holders === 0 && activeLanes.size >= MAX_NATIVE_LANES) {
		throw new Error(`This Veyyon process already has ${MAX_NATIVE_LANES} active native agent lanes`);
	}
	activeLanes.set(key, holders + 1);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const remaining = activeLanes.get(key)! - 1;
		if (remaining === 0) activeLanes.delete(key);
		else activeLanes.set(key, remaining);
	};
}
