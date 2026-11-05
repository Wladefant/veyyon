/** Whether a file's mode bits can deny this process access: root ignores them and Windows does not honour them. */
export function canRestrictAccess(): boolean {
	return process.platform !== "win32" && process.getuid?.() !== 0;
}
