import * as path from "node:path";
import { WindowsAtomicStage } from "@veyyon/natives";


export type WindowsStage = {
	native: WindowsAtomicStage;
	directory: string;
	path: string;
	publicationState: string;
};

/** Create the protected native staging directory and payload before any bytes are written. */
export function createWindowsStage(directory: string): WindowsStage {
	const native = new WindowsAtomicStage(path.toNamespacedPath(path.resolve(directory)));
	return { native, directory: native.directory, path: native.path, publicationState: "unpublished" };
}
