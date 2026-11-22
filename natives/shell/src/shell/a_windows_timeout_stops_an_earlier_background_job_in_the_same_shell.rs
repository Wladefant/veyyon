//! WHY: On Windows each `Shell.run` owns a job for the children it starts. An
//! ordinary background command from run A keeps its child alive after A
//! returns. When run B times out in the same persistent shell, B stopped only
//! its own job, so A's child survived the cancel. The shell must stop A's job
//! too. A second shell's background child must survive, because it lives in a
//! different job table. This does not cover a run that is cancelled while the
//! shell is being dropped by another queued run.

use std::{
	fs,
	path::Path,
	time::{Duration, Instant},
};

use windows_sys::Win32::{
	Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, GetLastError, WAIT_TIMEOUT},
	System::Threading::{
		OpenProcess, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, TerminateProcess, WaitForSingleObject,
	},
};

use super::{CancelToken, Shell, ShellRunOptions, ShellRunResult};

/// A script that starts a sleeping child, publishes its PID, then sleeps itself.
/// The script's own process is the background root; the child is the leaf.
fn write_background_script(script: &Path, pid_file: &Path) {
	let body = format!(
		"$p = Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 120' -WindowStyle Hidden -PassThru\r\nSet-Content -LiteralPath '{}' -Value $p.Id\r\nStart-Sleep -Seconds 120\r\n",
		pid_file.display()
	);
	fs::write(script, body).expect("write background script");
}

/// Forward slashes keep backslashes out of the shell's double-quoted words.
fn shell_path(path: &Path) -> String {
	path.display().to_string().replace('\\', "/")
}

fn read_child_pid(pid_file: &Path) -> Option<u32> {
	fs::read_to_string(pid_file).ok()?.trim().parse().ok()
}

/// True while `pid` names a process that has not exited.
fn process_is_alive(pid: u32) -> bool {
	// SAFETY: OpenProcess takes scalar arguments and returns an owned handle or null.
	let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
	if handle.is_null() {
		// SAFETY: GetLastError reads this thread's last-error code set by OpenProcess.
		let err = unsafe { GetLastError() };
		assert_eq!(err, ERROR_INVALID_PARAMETER, "OpenProcess(pid={pid}) failed unexpectedly");
		return false;
	}
	// SAFETY: `handle` is a valid process handle opened above and closed once here.
	let state = unsafe { WaitForSingleObject(handle, 0) };
	// SAFETY: `handle` is valid and is closed exactly once.
	unsafe {
		CloseHandle(handle);
	}
	state == WAIT_TIMEOUT
}

/// Best-effort cleanup so a failing run does not leave its sleeping child behind.
fn terminate_pid(pid: u32) {
	// SAFETY: OpenProcess takes scalar arguments; a null handle means the process is gone.
	let handle = unsafe { OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, 0, pid) };
	if handle.is_null() {
		return;
	}
	// SAFETY: `handle` is a valid process handle with PROCESS_TERMINATE and is closed once.
	unsafe {
		TerminateProcess(handle, 1);
		CloseHandle(handle);
	}
}

/// Polls `condition` until it holds or `timeout` elapses. Returns whether it held.
async fn wait_until(timeout: Duration, mut condition: impl FnMut() -> bool) -> bool {
	let deadline = Instant::now() + timeout;
	while !condition() {
		if Instant::now() >= deadline {
			return false;
		}
		tokio::time::sleep(Duration::from_millis(50)).await;
	}
	true
}

async fn run_in(shell: &Shell, command: &str, timeout_ms: Option<u32>) -> ShellRunResult {
	shell
		.run(
			ShellRunOptions { command: command.to_owned(), ..Default::default() },
			None,
			CancelToken::new(timeout_ms),
		)
		.await
		.expect("a shell run must return metadata, not an error")
}

/// Runs `script` as an ordinary background command in `shell` and returns the
/// PID its child published.
async fn start_background_child(shell: &Shell, script: &Path, pid_file: &Path) -> u32 {
	let command = format!(
		"powershell.exe -NoProfile -NonInteractive -File \"{}\" > NUL 2>&1 &",
		shell_path(script)
	);
	let launch = run_in(shell, &command, None).await;
	assert_eq!(launch.exit_code, Some(0), "the background launch must return cleanly");
	assert!(!launch.timed_out && !launch.cancelled, "the launch itself must not be stopped");

	let mut pid = None;
	let published = wait_until(Duration::from_secs(30), || {
		pid = read_child_pid(pid_file);
		pid.is_some()
	})
	.await;
	assert!(published, "the background child must publish its PID");
	pid.expect("published PID")
}

#[tokio::test(flavor = "multi_thread")]
async fn timeout_in_a_shell_stops_its_earlier_background_job() {
	let scratch = veyyon_test_scratch::scratch_dir("shell-windows-earlier-background-job");
	let shell = Shell::new(None);
	let unrelated = Shell::new(None);

	let shell_script = scratch.join("shell-child.ps1");
	let shell_pid_file = scratch.join("shell-child.pid");
	write_background_script(&shell_script, &shell_pid_file);
	let unrelated_script = scratch.join("unrelated-child.ps1");
	let unrelated_pid_file = scratch.join("unrelated-child.pid");
	write_background_script(&unrelated_script, &unrelated_pid_file);

	// Run A returns while its background child keeps running in `shell`.
	let earlier_child = start_background_child(&shell, &shell_script, &shell_pid_file).await;
	let unrelated_child =
		start_background_child(&unrelated, &unrelated_script, &unrelated_pid_file).await;
	let precondition = process_is_alive(earlier_child);

	// Run B times out in the same persistent shell after run A has returned.
	let later = run_in(
		&shell,
		"powershell.exe -NoProfile -NonInteractive -Command \"Start-Sleep -Seconds 120\"",
		Some(1_500),
	)
	.await;
	assert!(later.timed_out, "the deadline must stop run B");
	assert!(!later.cancelled, "a timeout is not a user cancel");

	let stopped = wait_until(Duration::from_secs(15), || !process_is_alive(earlier_child)).await;
	let unrelated_survived = process_is_alive(unrelated_child);

	terminate_pid(unrelated_child);
	if !stopped {
		terminate_pid(earlier_child);
	}

	assert!(precondition, "run A's child must be alive before run B times out");
	assert!(
		stopped,
		"run B's timeout must stop run A's background child (pid={earlier_child}) in the same shell"
	);
	assert!(
		unrelated_survived,
		"a timeout in one shell must not stop a background child of another shell"
	);
}
