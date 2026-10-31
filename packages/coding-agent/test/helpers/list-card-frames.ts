import { stripVTControlCharacters } from "node:util";
import { OVERLAY_SPECS } from "./overlay-specs";
import { stubStdoutGeometry } from "./stdout-geometry";

export const ARROW_DOWN = "\x1b[B";
export const ARROW_UP = "\x1b[A";

/** The plain-text frames of the overlay card `name` on a `width`x`rows` terminal before and after pressing `keys` in order. */
export async function framesAroundKeys(
	name: string,
	keys: readonly string[],
	width: number,
	rows: number,
): Promise<{ before: string; after: string }> {
	const spec = OVERLAY_SPECS.find(candidate => candidate.name === name);
	if (!spec) throw new Error(`no overlay spec named ${name}`);
	const geometry = stubStdoutGeometry({ rows, columns: width });
	const component = await spec.create(rows);
	const frame = () =>
		component
			.render(width)
			.map(line => stripVTControlCharacters(line))
			.join("\n");
	try {
		const before = frame();
		if (!("handleInput" in component) || typeof component.handleInput !== "function")
			return { before, after: before };
		for (const key of keys) component.handleInput(key);
		return { before, after: frame() };
	} finally {
		component.dispose?.();
		geometry.restore();
	}
}

/** Every overlay card whose 80x30 frame changes under one press of the down or the up arrow, in spec order. */
export async function cardsMovedByArrows(): Promise<string[]> {
	const moving: string[] = [];
	for (const spec of OVERLAY_SPECS) {
		for (const key of [ARROW_DOWN, ARROW_UP]) {
			const { before, after } = await framesAroundKeys(spec.name, [key], 80, 30);
			if (before !== after) {
				moving.push(spec.name);
				break;
			}
		}
	}
	return moving;
}
