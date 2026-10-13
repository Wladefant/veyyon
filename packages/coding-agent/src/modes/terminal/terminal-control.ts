import { serveTerminalControl } from "../../launch/terminal-control";
import type { TerminalControlTarget } from "../../launch/terminal-control";

export function startTerminalControl(target: TerminalControlTarget): Promise<() => void> {
	return serveTerminalControl(target);
}

