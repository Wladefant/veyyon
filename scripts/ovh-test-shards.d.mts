export interface TestShard {
	index: number;
	durationMs: number;
	files: string[];
}

export interface TestShardPlan {
	targetDurationMs: number;
	shardCount: number;
	shards: TestShard[];
}

export const MAX_SHARDS: number;
export const DEFAULT_TARGET_MS: number;

export function planShards(
	files: string[],
	durations: Record<string, number>,
	targetMs?: number,
	unknownDurationMs?: number,
): TestShardPlan;
export function parseSelectedLines(text: string): string[];
export function verifyShardFile(file: string, expected: number): Promise<number>;
export function runCli(args?: string[], env?: NodeJS.ProcessEnv): Promise<TestShardPlan | number>;
