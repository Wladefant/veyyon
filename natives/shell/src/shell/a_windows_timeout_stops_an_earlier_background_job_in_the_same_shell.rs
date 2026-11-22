//! WHY: On Windows each `Shell.run` owns a job for the children it starts. An
//! ordinary background command from run A keeps its child alive after A
//! returns. When run B times out in the same persistent shell, B stopped only
//! its own job, so A's child survived the cancel. The shell must stop A's job
//! too. A second shell's background child must survive, because it lives in a
//! different job table. This does not cover a run that is cancelled while the
//! shell is being dropped by another queued run.

use std::{
	fs,
	future::{Future, poll_fn},
	path::Path,
	task::Poll,
	time::{Duration, Instant},
};

use super::{AbortReason, CancelToken, Shell, ShellRunOptions, ShellRunResult, process};
use process::{Process, ProcessStatus};
use tokio::{sync::oneshot, time::timeout};

/// A script that starts a sleeping child, publishes its PID, then sleeps itself.
/// The script's own process is the background root; the child is the leaf.
fn write_background_script(script: &Path, pid_file: &Path) {
	let body = format!(
		"$info = [Diagnostics.ProcessStartInfo]::new('powershell.exe', '-NoProfile -NonInteractive -Command Start-Sleep -Seconds 120')\r\n$info.UseShellExecute = $false\r\n$info.CreateNoWindow = $true\r\n$p = [Diagnostics.Process]::Start($info)\r\nSet-Content -LiteralPath '{}' -Value \"$PID $($p.Id)\"\r\nStart-Sleep -Seconds 120\r\n",
		pid_file.display()
	);
	fs::write(script, body).expect("write background script");
}

/// Forward slashes keep backslashes out of the shell's double-quoted words.
fn shell_path(path: &Path) -> String {
	path.display().to_string().replace('\\', "/")
}

struct BackgroundChild {
	root: Process,
	leaf: Process,
}

impl Drop for BackgroundChild {
	fn drop(&mut self) {
		let _ = self.leaf.kill_tree(None);
		let _ = self.root.kill_tree(None);
	}
}

fn pin_children(pid_file: &Path) -> Option<BackgroundChild> {
	let contents = fs::read_to_string(pid_file).ok()?;
	let mut pids = contents.split_whitespace();
	let root = pids.next()?.parse().ok()?;
	let leaf = pids.next()?.parse().ok()?;
	Some(BackgroundChild { root: Process::from_pid(root)?, leaf: Process::from_pid(leaf)? })
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

fn background_command(script: &Path) -> String {
	format!(
		"powershell.exe -NoProfile -NonInteractive -File \"{}\" > NUL 2>&1 &",
		shell_path(script)
	)
}

/// Runs `script` as an ordinary background command in `shell` and returns the
/// PID its child published.
async fn start_background_child(shell: &Shell, script: &Path, pid_file: &Path) -> BackgroundChild {
	let launch = run_in(shell, &background_command(script), None).await;
	assert_eq!(launch.exit_code, Some(0), "the background launch must return cleanly");
	assert!(!launch.timed_out && !launch.cancelled, "the launch itself must not be stopped");

	let mut children = None;
	let published = wait_until(Duration::from_secs(30), || {
		children = pin_children(pid_file);
		children.is_some()
	})
	.await;
	assert!(published, "the background root and leaf must publish their PIDs");
	children.expect("pin the published processes")
}

#[tokio::test(flavor = "multi_thread")]
async fn timeout_in_a_shell_stops_its_earlier_background_job() {
	let scratch = veyyon_test_scratch::scratch_dir("shell-windows-earlier-background-job");
	let scratch = scratch.path();
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
	assert_ne!(earlier_child.leaf.status(), ProcessStatus::Exited);
	assert_ne!(unrelated_child.leaf.status(), ProcessStatus::Exited);

	// Run B times out in the same persistent shell after run A has returned.
	let later = run_in(
		&shell,
		"powershell.exe -NoProfile -NonInteractive -Command \"Start-Sleep -Seconds 120\"",
		Some(1_500),
	)
	.await;
	assert!(later.timed_out, "the deadline must stop run B");
	assert!(!later.cancelled, "a timeout is not a user cancel");

	assert!(
		earlier_child.leaf
			.wait_for_exit(Some(Duration::from_secs(15)), CancelToken::default())
			.await
			.unwrap(),
		"run B's timeout must stop run A's background child in the same shell"
	);
	assert!(
		unrelated_child.leaf.status() != ProcessStatus::Exited,
		"a timeout in one shell must not stop a background child of another shell"
	);
}

#[tokio::test]
async fn timeout_during_drain_stops_prior_jobs_but_not_the_queued_run() {
	let scratch = veyyon_test_scratch::scratch_dir("shell-windows-timeout-during-drain");
	let shell = Shell::new(None);
	let earlier_script = scratch.path().join("earlier.ps1");
	let earlier_pid = scratch.path().join("earlier.pid");
	write_background_script(&earlier_script, &earlier_pid);
	let earlier = start_background_child(&shell, &earlier_script, &earlier_pid).await;
	assert_ne!(earlier.leaf.status(), ProcessStatus::Exited);

	let (b_entered, b_in_drain) = oneshot::channel();
	let (resume_b, b_resume) = oneshot::channel();
	let (c_entered, c_in_drain) = oneshot::channel();
	let (resume_c, c_resume) = oneshot::channel();
	shell.session.lock().await.as_mut().unwrap().drain_pauses =
		[(b_entered, b_resume), (c_entered, c_resume)].into();

	let mut token = CancelToken::default();
	let deadline = token.emplace_abort_token();
	let mut b = std::pin::pin!(shell.run(
		ShellRunOptions { command: "true".to_owned(), ..Default::default() },
		None,
		token,
	));
	let mut b_in_drain = std::pin::pin!(timeout(Duration::from_secs(30), b_in_drain));
	tokio::select! {
		result = &mut b => panic!("B returned before output drain: {result:?}"),
		entered = &mut b_in_drain => entered.expect("B reaches output drain").unwrap(),
	}

	let queued_script = scratch.path().join("queued.ps1");
	let queued_pid = scratch.path().join("queued.pid");
	write_background_script(&queued_script, &queued_pid);
	let queued_command = background_command(&queued_script);
	let mut c = std::pin::pin!(run_in(&shell, &queued_command, None));
	poll_fn(|cx| {
		assert!(c.as_mut().poll(cx).is_pending(), "C waits while B holds the session");
		Poll::Ready(())
	})
	.await;

	// Deliver the deadline at the drain boundary, rather than racing a timer.
	// Poll B once so it starts cancellation while its command task is paused.
	deadline.abort(AbortReason::Timeout);
	poll_fn(|cx| {
		assert!(b.as_mut().poll(cx).is_pending(), "B waits for its command task");
		Poll::Ready(())
	})
	.await;
	resume_b.send(()).unwrap();

	// Do not poll B's caller again until C holds the session lock. This forces
	// the old timeout path's try_lock to fail.
	tokio::select! {
		result = &mut c => panic!("C returned before output drain: {result:?}"),
		entered = timeout(Duration::from_secs(30), c_in_drain) => {
			entered.expect("C acquires the session from B").unwrap();
		}
	}
	let mut queued = None;
	assert!(
		wait_until(Duration::from_secs(30), || {
			queued = pin_children(&queued_pid);
			queued.is_some()
		})
		.await,
		"C's background job starts before B's caller resumes"
	);
	let queued = queued.unwrap();

	let stopped = timeout(Duration::from_secs(30), &mut b).await.unwrap().unwrap();
	assert!(stopped.timed_out && !stopped.cancelled, "B reports a timeout");
	assert!(
		earlier
			.leaf
			.wait_for_exit(Some(Duration::from_secs(5)), CancelToken::default())
			.await
			.unwrap(),
		"B's timeout must stop A's background job even while C holds the session"
	);
	assert_ne!(queued.leaf.status(), ProcessStatus::Exited, "B must not stop C's job");
	resume_c.send(()).unwrap();
	assert_eq!(timeout(Duration::from_secs(30), &mut c).await.unwrap().exit_code, Some(0));
}
