//! WHY: Synchronous `CreateProcessW` (`command.spawn()`) on Tokio scheduler
//! workers stalls the worker pool when process creation is slow or contended.
//! Offloading Windows `spawn` onto `spawn_blocking` keeps the scheduler
//! responsive to timers and sibling tasks, cancels queued work on drop, and
//! ensures late-returning children after caller cancellation are killed rather
//! than orphaned.

use std::{
	process::Stdio,
	sync::{
		Arc, Condvar, Mutex,
		atomic::{AtomicBool, AtomicUsize, Ordering},
	},
	time::Duration,
};

use brush_core::{SourceInfo, openfiles::OpenFiles};

use super::{ShellConfig, create_session, exit_code, null_file};

fn helper_sleep_command() -> std::process::Command {
	let mut cmd = std::process::Command::new("cmd.exe");
	cmd.args(["/c", "exit", "0"])
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::null());
	cmd
}

fn helper_long_lived_command() -> std::process::Command {
	let mut cmd = std::process::Command::new("powershell.exe");
	cmd.args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"])
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::null());
	cmd
}

fn wait_for_pid_exit(pid: u32, timeout_ms: u32) -> bool {
	use windows_sys::Win32::{
		Foundation::{CloseHandle, WAIT_OBJECT_0},
		System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
	};

	// SAFETY: OpenProcess with PROCESS_SYNCHRONIZE is safe for any PID; handle is closed before return.
	let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
	if handle.is_null() {
		// Process already exited and its handle table entry is gone.
		return true;
	}
	let wait = unsafe { WaitForSingleObject(handle, timeout_ms) };
	unsafe {
		CloseHandle(handle);
	}
	wait == WAIT_OBJECT_0
}

#[test]
fn windows_spawn_does_not_block_current_thread_scheduler_heartbeat() {
	let rt = tokio::runtime::Builder::new_current_thread()
		.enable_time()
		.build()
		.expect("current_thread runtime");

	let entered = Arc::new(AtomicBool::new(false));
	let gate = Arc::new((Mutex::new(false), Condvar::new()));
	let ticks = Arc::new(AtomicUsize::new(0));

	let entered_op = Arc::clone(&entered);
	let gate_op = Arc::clone(&gate);
	let spawn_fut = brush_core::sys::tokio_process::spawn_with_op(helper_sleep_command(), move |mut cmd| {
		entered_op.store(true, Ordering::Release);
		let (lock, cvar) = &*gate_op;
		let guard = lock.lock().expect("gate mutex");
		let (guard, wait_res) = cvar
			.wait_timeout_while(guard, Duration::from_secs(6), |released| !*released)
			.expect("gate wait");
		drop(guard);
		if wait_res.timed_out() {
			return Err(std::io::Error::new(
				std::io::ErrorKind::TimedOut,
				"scheduler heartbeat never released blocking spawn gate",
			));
		}
		cmd.spawn()
	});

	let entered_hb = Arc::clone(&entered);
	let gate_hb = Arc::clone(&gate);
	let ticks_hb = Arc::clone(&ticks);
	let heartbeat_fut = async move {
		while !entered_hb.load(Ordering::Acquire) || ticks_hb.load(Ordering::Acquire) < 3 {
			tokio::time::sleep(Duration::from_millis(15)).await;
			ticks_hb.fetch_add(1, Ordering::AcqRel);
		}
		let (lock, cvar) = &*gate_hb;
		let mut released = lock.lock().expect("gate mutex");
		*released = true;
		cvar.notify_all();
	};

	let result = rt.block_on(async {
		tokio::time::timeout(Duration::from_secs(5), async {
			tokio::join!(spawn_fut, heartbeat_fut)
		})
		.await
	});

	let (spawn_res, ()) = result.expect("current_thread scheduler must progress while spawn is blocked");
	assert!(
		ticks.load(Ordering::Acquire) >= 3,
		"heartbeat must tick at least 3 times while spawn is held"
	);
	let mut child = spawn_res.expect("offloaded child spawn succeeds");
	let status = rt.block_on(child.wait()).expect("child wait");
	assert_eq!(status.code(), Some(0));
}

#[test]
fn cancelled_windows_spawn_kills_late_child_without_orphan() {
	let rt = tokio::runtime::Builder::new_current_thread()
		.enable_time()
		.build()
		.expect("current_thread runtime");

	let entered = Arc::new(AtomicBool::new(false));
	let gate = Arc::new((Mutex::new(false), Condvar::new()));
	let (pid_tx, pid_rx) = std::sync::mpsc::channel::<u32>();

	let entered_op = Arc::clone(&entered);
	let gate_op = Arc::clone(&gate);
	let spawn_fut =
		brush_core::sys::tokio_process::spawn_with_op(helper_long_lived_command(), move |mut cmd| {
			entered_op.store(true, Ordering::Release);
			let (lock, cvar) = &*gate_op;
			let guard = lock.lock().expect("gate mutex");
			let (guard, _) = cvar
				.wait_timeout_while(guard, Duration::from_secs(5), |released| !*released)
				.expect("gate wait");
			drop(guard);
			let child = cmd.spawn()?;
			if let Some(pid) = child.id() {
				let _ = pid_tx.send(pid);
			}
			Ok(child)
		});

	rt.block_on(async {
		let mut spawn_fut = std::pin::pin!(spawn_fut);
		tokio::select! {
			_ = &mut spawn_fut => panic!("spawn_fut should still be blocked on gate"),
			_ = async {
				while !entered.load(Ordering::Acquire) {
					tokio::time::sleep(Duration::from_millis(5)).await;
				}
				tokio::time::sleep(Duration::from_millis(20)).await;
			} => {
				// Dropping `spawn_fut` here cancels the caller while `op` is in flight.
			}
		}
	});

	// Release the in-flight blocking op so it spawns the child after caller cancellation.
	{
		let (lock, cvar) = &*gate;
		let mut released = lock.lock().expect("gate mutex");
		*released = true;
		cvar.notify_all();
	}

	let pid = pid_rx
		.recv_timeout(Duration::from_secs(5))
		.expect("in-flight spawn_blocking op must finish and report child PID");
	assert!(
		wait_for_pid_exit(pid, 3000),
		"late child (pid={pid}) returned after caller cancellation must be killed, not orphaned"
	);
}

#[tokio::test(flavor = "multi_thread")]
async fn real_windows_child_spawn_and_exit_smoke() {
	let scratch = veyyon_test_scratch::scratch_dir("windows-spawn-smoke");
	let stdout_path = scratch.path().join("stdout.txt");
	let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
	let mut session = create_session(&config).await.expect("shell session");
	let mut params = session.shell.default_exec_params();
	params.set_fd(OpenFiles::STDIN_FD, null_file().expect("stdin"));
	params.set_fd(
		OpenFiles::STDOUT_FD,
		std::fs::File::create(&stdout_path)
			.expect("stdout file")
			.into(),
	);
	params.set_fd(OpenFiles::STDERR_FD, null_file().expect("stderr"));

	let result = tokio::time::timeout(
		Duration::from_secs(10),
		session.shell.run_string(
			"cmd.exe /c echo windows-spawn-ok",
			&SourceInfo::from("windows-spawn-smoke"),
			&params,
		),
	)
	.await
	.expect("shell command must not hang")
	.expect("shell execution succeeds");

	assert_eq!(exit_code(&result), 0);
	let stdout = std::fs::read_to_string(&stdout_path).expect("read stdout");
	assert!(
		stdout.contains("windows-spawn-ok"),
		"expected child stdout, got: {stdout:?}"
	);
}
