//! WHY: the embedded shell runs inside its host process, so on Unix `$$` is
//! the host. Before <https://github.com/Wladefant/veyyon/issues/106> the `kill`
//! builtin forwarded any target to `kill(2)`: `kill -TERM <host>`, a signal to
//! a host thread, to an ancestor, to `0`, or to a group holding an ancestor
//! terminated the host or its parents. Child cancellation sent `SIGKILL` to the
//! child's numeric PID even after something else had reaped it, when that PID
//! may already name an unrelated process.
//!
//! The class closed: every `kill(2)` target shape (pid, thread id, `0`, group)
//! that reaches the host or an ancestor is refused for a real signal, signal 0
//! still probes, legitimate targets are still signalled, and cancellation only
//! signals a PID proven to still be the unreaped child.
//!
//! Every signal lands on a test-owned process. The refusal cases run the real
//! builtin in a re-executed copy of this test binary (the "host"), under two
//! test-owned `sh` ancestors that trap SIGTERM and record it, each in its own
//! process group, so a regression kills only those processes.
//!
//! Not caught here: `kill -1` is checked through the classifier only, because a
//! regression would signal every process the user owns. Ancestors hidden from
//! the parent walk (`/proc` `hidepid`) are not exercised, and the window
//! between the unreaped-child check and `kill` on platforms without pidfd is
//! not deterministically reproducible.

use std::{io::Read, path::PathBuf, process::Stdio, time::Duration};

use brush_core::{SourceInfo, openfiles::OpenFiles, processes::ChildProcess};

use super::{ShellConfig, create_session, exit_code, null_file};

const HOST_TEST: &str =
	"shell::a_signal_never_reaches_the_host_or_its_ancestors::kill_guard_host_entry";
const BOUND: Duration = Duration::from_secs(20);

/// Records its SIGTERM in `$KG_MARK_OUTER`, exports its pid, then runs the
/// inner ancestor in the background so the trap fires even while it waits.
const OUTER_SH: &str = "KG_OUTER_PID=$$; export KG_OUTER_PID; trap ': > \"$KG_MARK_OUTER\"; exit \
                        42' TERM; sh -c \"$KG_INNER\" & wait $!";
/// The host's direct parent: records its SIGTERM, then runs the host.
const INNER_SH: &str = "trap ': > \"$KG_MARK_INNER\"; exit 43' TERM; \"$KG_EXE\" --exact \
                        \"$KG_TEST\" --ignored --test-threads=1 --quiet & wait $!";

/// Subprocess entry for this suite: runs `VEYYON_KILL_GUARD_SCRIPT` in a real
/// embedded shell and records the script's exit code and stderr.
#[test]
#[ignore = "host process for the kill guard tests; they spawn it, it does nothing alone"]
fn kill_guard_host_entry() {
	let Ok(script) = std::env::var("VEYYON_KILL_GUARD_SCRIPT") else {
		return;
	};
	let result_path = PathBuf::from(std::env::var("VEYYON_KILL_GUARD_RESULT").expect("result"));
	if std::env::var_os("VEYYON_KILL_GUARD_OWN_GROUP").is_some() {
		// SAFETY: `setpgid(0, 0)` moves only this process into a new group.
		assert_eq!(unsafe { libc::setpgid(0, 0) }, 0, "host leaves its ancestors' group");
	}
	let (tid_tx, tid_rx) = std::sync::mpsc::channel();
	std::thread::spawn(move || {
		let _ = tid_tx.send(current_thread_id());
		std::thread::park();
	});
	let thread = tid_rx.recv().expect("host thread id");
	// SAFETY: `getppid` has no preconditions.
	let parent = unsafe { libc::getppid() };
	let grandparent = std::env::var("KG_OUTER_PID").unwrap_or_default();
	let script = script
		.replace("%self%", &std::process::id().to_string())
		.replace("%thread%", &thread.to_string())
		.replace("%parent%", &parent.to_string())
		.replace("%grandparent%", &grandparent);
	let stderr_path = result_path.with_extension("stderr");

	let runtime = tokio::runtime::Builder::new_multi_thread()
		.enable_all()
		.build()
		.expect("runtime");
	let code = runtime.block_on(async {
		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null stdin"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null stdout"));
		params.set_fd(
			OpenFiles::STDERR_FD,
			std::fs::File::create(&stderr_path)
				.expect("stderr file")
				.into(),
		);
		let result = session
			.shell
			.run_string(script, &SourceInfo::from("kill-guard"), &params)
			.await
			.expect("run script");
		exit_code(&result)
	});
	let staged = result_path.with_extension("tmp");
	std::fs::write(&staged, code.to_string()).expect("write result");
	std::fs::rename(&staged, &result_path).expect("publish result");
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn current_thread_id() -> i64 {
	// SAFETY: `gettid` has no preconditions.
	i64::from(unsafe { libc::gettid() })
}

#[cfg(not(any(target_os = "linux", target_os = "android")))]
const fn current_thread_id() -> i64 {
	0
}

/// What one host run observed.
#[derive(Debug)]
struct HostRun {
	/// Exit code of the outer ancestor: the host's own exit code unless an
	/// ancestor was signalled (42 outer, 43 inner) or the host died (143).
	chain_exit:      Option<i32>,
	/// Exit code of the host's `kill` script, if the host lived to record it.
	script_exit:     Option<i32>,
	stderr:          String,
	outer_signalled: bool,
	inner_signalled: bool,
}

enum HostGroup {
	/// The host stays in its ancestors' process group.
	Shared,
	/// The host leads its own process group.
	Own,
}

async fn run_host(
	name: &str,
	script: &str,
	host_group: HostGroup,
	ancestor_group: Option<u32>,
) -> HostRun {
	let dir = veyyon_test_scratch::scratch_dir(name);
	let mark_outer = dir.join("outer-signalled");
	let mark_inner = dir.join("inner-signalled");
	let result = dir.join("result");
	let exe = std::env::current_exe().expect("test binary");

	let mut outer = tokio::process::Command::new("sh");
	outer
		.args(["-c", OUTER_SH])
		.env("KG_MARK_OUTER", &mark_outer)
		.env("KG_MARK_INNER", &mark_inner)
		.env("KG_INNER", INNER_SH)
		.env("KG_EXE", &exe)
		.env("KG_TEST", HOST_TEST)
		.env("VEYYON_KILL_GUARD_SCRIPT", script)
		.env("VEYYON_KILL_GUARD_RESULT", &result)
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::null())
		// Keep every ancestor out of the test runner's group, so a regressed
		// group signal cannot reach the runner.
		.process_group(ancestor_group.map_or(0, |group| group as i32))
		.kill_on_drop(true);
	if matches!(host_group, HostGroup::Own) {
		outer.env("VEYYON_KILL_GUARD_OWN_GROUP", "1");
	}
	let mut outer = outer.spawn().expect("spawn outer ancestor");
	let status = tokio::time::timeout(BOUND, outer.wait())
		.await
		.expect("the ancestor chain ends within the bound")
		.expect("wait for outer ancestor");

	let script_exit = tokio::time::timeout(Duration::from_secs(5), async {
		loop {
			if let Ok(text) = std::fs::read_to_string(&result) {
				return text.trim().parse::<i32>().ok();
			}
			tokio::time::sleep(Duration::from_millis(20)).await;
		}
	})
	.await
	.ok()
	.flatten();

	HostRun {
		chain_exit: status.code(),
		script_exit,
		stderr: std::fs::read_to_string(result.with_extension("stderr")).unwrap_or_default(),
		outer_signalled: mark_outer.exists(),
		inner_signalled: mark_inner.exists(),
	}
}

fn assert_refused(run: &HostRun, what: &str) {
	assert!(!run.outer_signalled, "{what}: the outer ancestor received SIGTERM: {run:?}");
	assert!(!run.inner_signalled, "{what}: the host's parent received SIGTERM: {run:?}");
	assert_eq!(
		run.chain_exit,
		Some(0),
		"{what}: the host and its ancestors run to completion: {run:?}"
	);
	assert_eq!(run.script_exit, Some(1), "{what}: kill reports failure: {run:?}");
	assert!(run.stderr.contains("refusing to signal"), "{what}: kill says why: {run:?}");
}

/// A test-owned `sleep` in its own group, outside the host's ancestry.
fn spawn_bystander() -> tokio::process::Child {
	tokio::process::Command::new("sleep")
		.arg("30")
		.stdin(Stdio::null())
		.process_group(0)
		.kill_on_drop(true)
		.spawn()
		.expect("spawn bystander")
}

#[tokio::test(flavor = "multi_thread")]
async fn the_host_refuses_to_signal_itself() {
	let run = run_host("kill-guard-self", "kill -TERM %self%", HostGroup::Shared, None).await;
	assert_refused(&run, "kill -TERM <host>");
}

#[cfg(any(target_os = "linux", target_os = "android"))]
#[tokio::test(flavor = "multi_thread")]
async fn a_host_thread_id_counts_as_the_host() {
	let run = run_host("kill-guard-thread", "kill -TERM %thread%", HostGroup::Shared, None).await;
	assert_refused(&run, "kill -TERM <host thread>");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_host_refuses_to_signal_its_parent() {
	let run = run_host("kill-guard-parent", "kill -TERM %parent%", HostGroup::Shared, None).await;
	assert_refused(&run, "kill -TERM <parent>");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_host_refuses_to_signal_an_ancestor_above_its_parent() {
	let run =
		run_host("kill-guard-grandparent", "kill -KILL %grandparent%", HostGroup::Shared, None).await;
	// SIGKILL cannot be trapped, so the outer ancestor proves itself alive by
	// exiting with the host's status rather than by the absence of a marker.
	assert_refused(&run, "kill -KILL <grandparent>");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_host_refuses_its_own_process_group() {
	let run = run_host("kill-guard-group-zero", "kill -TERM 0", HostGroup::Own, None).await;
	assert_refused(&run, "kill -TERM 0");
	let run = run_host("kill-guard-own-group", "kill -TERM -- -%self%", HostGroup::Own, None).await;
	assert_refused(&run, "kill -TERM -- -<host group>");
}

/// The group's leader is a bystander, not an ancestor, so the group is refused
/// only because an ancestor is a member of it.
#[tokio::test(flavor = "multi_thread")]
async fn the_host_refuses_a_group_that_holds_an_ancestor() {
	let mut leader = spawn_bystander();
	let group = leader.id().expect("leader pid");
	let run = run_host(
		"kill-guard-ancestor-group",
		&format!("kill -TERM -- -{group}"),
		HostGroup::Own,
		Some(group),
	)
	.await;
	let leader_alive = leader.try_wait().expect("poll leader").is_none();
	let _ = leader.start_kill();
	let _ = leader.wait().await;
	assert_refused(&run, "kill -TERM -- -<group holding an ancestor>");
	assert!(leader_alive, "the group's leader was signalled");
}

#[tokio::test(flavor = "multi_thread")]
async fn signal_zero_still_probes_the_host_and_its_parent() {
	let run =
		run_host("kill-guard-probe", "kill -0 %self% && kill -0 %parent%", HostGroup::Shared, None)
			.await;
	assert_eq!(run.script_exit, Some(0), "signal 0 probes succeed: {run:?}");
	assert_eq!(run.chain_exit, Some(0), "probing delivers nothing: {run:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_process_outside_the_ancestry_is_still_signalled() {
	let mut bystander = spawn_bystander();
	let pid = bystander.id().expect("bystander pid");
	let run =
		run_host("kill-guard-bystander", &format!("kill -TERM {pid}"), HostGroup::Shared, None).await;
	let status = tokio::time::timeout(Duration::from_secs(5), bystander.wait()).await;
	let terminated = matches!(
		&status,
		Ok(Ok(status)) if std::os::unix::process::ExitStatusExt::signal(status) == Some(libc::SIGTERM)
	);
	if !terminated {
		let _ = bystander.start_kill();
		let _ = bystander.wait().await;
	}
	assert_eq!(run.script_exit, Some(0), "kill of a bystander succeeds: {run:?}");
	assert!(terminated, "the bystander ended by SIGTERM within the bound: {status:?}");
}

/// `kill -1` would reach every process the user owns if the guard regressed,
/// so its refusal is asserted without delivering anything.
#[test]
fn every_target_shape_that_holds_the_host_is_protected() {
	use brush_core::sys::signal::signal_target_is_protected;

	let host = std::process::id() as i32;
	// SAFETY: `getpgid(0)` and `getppid` query this process and have no
	// preconditions.
	let (host_group, parent) = unsafe { (libc::getpgid(0), libc::getppid()) };
	assert!(signal_target_is_protected(-1), "-1 reaches every process");
	assert!(signal_target_is_protected(0), "0 is the caller's group");
	assert!(signal_target_is_protected(host), "the host itself");
	assert!(signal_target_is_protected(parent), "the host's parent");
	assert!(signal_target_is_protected(-host_group), "the host's group");
	assert!(!signal_target_is_protected(i32::MIN), "no group has id i32::MIN negated");
}

/// A pipe whose write end only `holder` keeps open: EOF on the read end means
/// `holder` exited.
fn liveness_pipe() -> (std::io::PipeReader, std::io::PipeWriter) {
	std::io::pipe().expect("pipe")
}

/// Whether the pipe's last writer is gone within `wait`.
async fn writer_gone_within(reader: std::io::PipeReader, wait: Duration) -> bool {
	let read = tokio::task::spawn_blocking(move || {
		let mut reader = reader;
		let mut sink = Vec::new();
		reader.read_to_end(&mut sink).map(|_| ())
	});
	tokio::time::timeout(wait, read).await.is_ok()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dropped_child_is_killed_within_the_bound() {
	let (reader, writer) = liveness_pipe();
	let child = tokio::process::Command::new("sleep")
		.arg("30")
		.stdin(Stdio::null())
		.stdout(writer)
		.spawn()
		.expect("spawn child");
	let pid = child.id().map(|pid| pid as i32);
	drop(ChildProcess::new(child, pid, None));
	assert!(
		writer_gone_within(reader, Duration::from_secs(5)).await,
		"dropping the tracked child kills it"
	);
}

/// Simulates a recycled PID: the tracked PID names a live process that is not
/// this process's child, as happens once the real child is reaped elsewhere
/// and the kernel hands its PID out again.
#[tokio::test(flavor = "multi_thread")]
async fn cancellation_never_signals_a_pid_that_is_no_longer_the_child() {
	let (reader, writer) = liveness_pipe();
	// `sh` starts the stranger and exits, so the stranger is reparented away
	// from this process while holding the liveness pipe as its stderr.
	// `output()` would replace that stderr with its own pipe.
	let launcher = tokio::process::Command::new("sh")
		.args(["-c", "sleep 30 </dev/null >/dev/null & echo $!"])
		.stdin(Stdio::null())
		.stdout(Stdio::piped())
		.stderr(writer)
		.spawn()
		.expect("spawn launcher")
		.wait_with_output()
		.await
		.expect("launch stranger");
	let stranger: i32 = String::from_utf8_lossy(&launcher.stdout)
		.trim()
		.parse()
		.expect("stranger pid");

	let child = tokio::process::Command::new("sleep")
		.arg("30")
		.stdin(Stdio::null())
		.spawn()
		.expect("spawn child");
	let child_pid = child.id().expect("child pid") as i32;
	drop(ChildProcess::new(child, Some(stranger), None));

	let (reader, stranger_alive) = {
		let probe = reader.try_clone().expect("clone reader");
		(reader, !writer_gone_within(probe, Duration::from_millis(500)).await)
	};
	// SAFETY: `child_pid` is this process's unreaped child, so its PID cannot
	// have been reused. `stranger` is signalled only while it is known to be
	// alive, still holding the pipe.
	unsafe {
		libc::kill(child_pid, libc::SIGKILL);
		if stranger_alive {
			libc::kill(stranger, libc::SIGKILL);
		}
	}
	assert!(stranger_alive, "cancellation signalled a PID that is not the child");
	assert!(
		writer_gone_within(reader, Duration::from_secs(5)).await,
		"the stranger ends within the bound once the test kills it"
	);
}
