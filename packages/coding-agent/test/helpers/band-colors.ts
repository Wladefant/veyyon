/** An RGB triple, each channel 0–255. */
export type Rgb = [number, number, number];

/** The first truecolor background (`48;2;r;g;b`) a rendered row paints, or `null` when it paints none. */
export function bandRgb(row: string): Rgb | null {
	const match = /\x1b\[[0-9;]*?48;2;(\d+);(\d+);(\d+)/.exec(row);
	if (match === null) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** The channels of a `#rrggbb` colour. */
export function hexRgb(hex: string): Rgb {
	return [
		Number.parseInt(hex.slice(1, 3), 16),
		Number.parseInt(hex.slice(3, 5), 16),
		Number.parseInt(hex.slice(5, 7), 16),
	];
}

/** The sum of the per-channel differences between two colours. */
export function rgbDistance(a: Rgb, b: Rgb): number {
	return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}
