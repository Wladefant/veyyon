//! Process management utilities

pub(crate) type ProcessId = i32;
pub(crate) use tokio::process::Child;

/// Spawns a child process, offloading the synchronous OS process-creation
/// call onto Tokio's blocking pool on Windows so scheduler workers are never
/// stalled inside `CreateProcessW`.
#[cfg_attr(
	not(windows),
	allow(
		clippy::unused_async,
		reason = "async offload is Windows-only; API stays uniform across platforms"
	)
)]
pub(crate) async fn spawn(command: std::process::Command) -> std::io::Result<Child> {
	#[cfg(windows)]
	{
		spawn_with_op(command, |mut cmd| cmd.spawn()).await
	}
	#[cfg(not(windows))]
	{
		let mut command = tokio::process::Command::from(command);
		command.spawn()
	}
}

#[cfg(windows)]
struct AbortOnDrop<T>(Option<tokio::task::JoinHandle<T>>);

#[cfg(windows)]
impl<T> Drop for AbortOnDrop<T> {
	fn drop(&mut self) {
		if let Some(handle) = self.0.take() {
			handle.abort();
		}
	}
}

/// Applies Windows child isolation flags (`kill_on_drop(true)`,
/// `CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW`) and executes `op` on Tokio's
/// blocking pool (`tokio::task::spawn_blocking`).
///
/// Cancellation aborts queued work that has not started yet, but cannot
/// interrupt an already-running `CreateProcessW` syscall. Because
/// `kill_on_drop(true)` is set before `op` runs, any `Child` returned after the
/// caller drops this future is dropped and terminated rather than orphaned.
///
/// # Errors
///
/// Returns any `std::io::Error` produced by `op`, or an explicit
/// `std::io::Error` if the `spawn_blocking` task fails to join (cancelled or
/// panicked).
#[cfg(windows)]
pub async fn spawn_with_op<F>(command: std::process::Command, op: F) -> std::io::Result<Child>
where
	F: FnOnce(tokio::process::Command) -> std::io::Result<Child> + Send + 'static,
{
	let mut command = tokio::process::Command::from(command);
	// On Unix, `ChildProcess`'s drop does the kill and first proves the PID
	// still names the child; tokio's kill-on-drop signals the bare numeric PID,
	// which a child reaped elsewhere in the host may already have handed to an
	// unrelated process. Windows kills through the child's own handle.
	command.kill_on_drop(true);
	// Isolate every external child from the host's console:
	//
	// - `CREATE_NO_WINDOW` gives the child its own *invisible* console instead
	//   of attaching it to ours. Console-sharing children can mutate shared
	//   console state behind the host's back — most notably the output
	//   codepage (PHP >=7.1 CLI issues the equivalent of `chcp` and skips the
	//   restore when killed; php.net request #73716), which degraded every
	//   non-ASCII glyph a hosting TUI painted into CP437 mojibake (`Γöé`).
	//   Inherited stdio handles are unaffected (handle-routed, not
	//   console-routed); interactive commands belong to the PTY path, which
	//   provisions a dedicated ConPTY anyway.
	// - `CREATE_NEW_PROCESS_GROUP` makes the child a ctrl-event group root.
	//   Windows cannot join an existing group, so this is applied uniformly
	//   here rather than per-command (`creation_flags` replaces rather than
	//   ORs; the `sys::windows::commands` ext traits intentionally leave
	//   creation flags alone).
	{
		use windows_sys::Win32::System::Threading::{CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW};
		command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
	}
	let mut guard = AbortOnDrop(Some(tokio::task::spawn_blocking(move || op(command))));
	let handle = guard
		.0
		.as_mut()
		.ok_or_else(|| std::io::Error::other("spawn_blocking handle missing"))?;
	let join_result = handle.await;
	guard.0 = None;

	match join_result {
		Ok(spawn_result) => spawn_result,
		Err(join_err) if join_err.is_cancelled() => Err(std::io::Error::new(
			std::io::ErrorKind::Interrupted,
			format!("process spawn task cancelled: {join_err}"),
		)),
		Err(join_err) => Err(std::io::Error::other(format!(
			"process spawn task panicked: {join_err}"
		))),
	}
}
