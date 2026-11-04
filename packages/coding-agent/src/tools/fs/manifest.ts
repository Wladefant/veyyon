/**
 * What the filesystem domain contributes.
 *
 * The tools that read, write and navigate a working tree, plus the two that undo a session's writes.
 * Every factory pulls its implementation in on first use, so a host that never activates `write`
 * never parses the write tool, the conflict detector or the snapshot store behind them.
 *
 * The read codec rides on the manifest rather than the tool: a session that is resumed restores its
 * read cards before any read runs, so how a read result is stored cannot wait for the tool to load.
 */
import type { ToolDomainManifest } from "@veyyon/kernel/registry/tool-domain";
import type { BuiltinToolName } from "../core/builtin-names";
import type { ToolFactory } from "../index";
import { readResultCodec } from "./read-display";

export const fsTools = {
	read: async s => new (await import("./read")).ReadTool(s),
	write: async s => new (await import("./write")).WriteTool(s),
	set_cwd: async s => new (await import("./set-cwd")).SetCwdTool(s),
	inspect_image: async s => new (await import("./inspect-image")).InspectImageTool(s),
	checkpoint: async s => (await import("./checkpoint")).CheckpointTool.createIf(s),
	rewind: async s => (await import("./checkpoint")).RewindTool.createIf(s),
} satisfies Partial<Record<BuiltinToolName, ToolFactory>>;

export const fsDomain = {
	domain: "fs",
	tools: fsTools,
	resultCodecs: [readResultCodec],
} satisfies ToolDomainManifest<ToolFactory>;
