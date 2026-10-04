//! WHY: Windows `kill` bypassed the process-termination ancestry guard and
//! treated signal zero as termination. Real signals must refuse the host and
//! its ancestors, probes must leave them alive, and unrelated children must
//! remain terminable. Every target here is a re-executed test-owned process.
//! PID-reuse classification is covered separately in brush-core; inaccessible
//! creation timestamps and external kill programs are not exercised here.

use std::{path::PathBuf, process::Stdio, time::Duration};

use brush_core::{SourceInfo, openfiles::OpenFiles};

use super::{ShellConfig, create_session, exit_code, null_file};

const ENTRY: &str = "shell::a_windows_signal_preserves_its_host_and_ancestry::windows_signal_host";
const BOUND: Duration = Duration::from_secs(20);

fn host_command() -> tokio::process::Command {
	let mut command =
		tokio::process::Command::new(std::env::current_exe().expect("test executable"));
	command
		.args(["--exact", ENTRY, "--ignored", "--test-threads=1", "--quiet"])
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::null())
		.kill_on_drop(true);
	command
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "test-owned subprocess entry; invoked only by the signal suite"]
async fn windows_signal_host() {
	if std::env::var_os("VEYYON_SIGNAL_WAIT").is_some() {
		tokio::time::sleep(Duration::from_secs(30)).await;
		return;
	}
	let Ok(mut script) = std::env::var("VEYYON_SIGNAL_SCRIPT") else {
		return;
	};
	if std::env::var_os("VEYYON_SIGNAL_RELAY").is_some() {
		let status =
			tokio::time::timeout(BOUND, host_command().env_remove("VEYYON_SIGNAL_RELAY").status())
				.await
				.expect("nested host terminates")
				.expect("nested status");
		assert!(status.success(), "nested host survived its signal");
		return;
	}
	let result_path = PathBuf::from(std::env::var("VEYYON_SIGNAL_RESULT").expect("result path"));
	script = script.replace("%self%", &std::process::id().to_string());
	let mut bystander = if script.contains("%child%") {
		let child = host_command()
			.env("VEYYON_SIGNAL_WAIT", "1")
			.spawn()
			.expect("bystander");
		script = script.replace("%child%", &child.id().expect("child pid").to_string());
		Some(child)
	} else {
		None
	};
	let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
	let mut session = create_session(&config).await.expect("shell session");
	let mut params = session.shell.default_exec_params();
	params.set_fd(OpenFiles::STDIN_FD, null_file().expect("stdin"));
	params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("stdout"));
	params.set_fd(
		OpenFiles::STDERR_FD,
		std::fs::File::create(result_path.with_extension("stderr"))
			.expect("stderr")
			.into(),
	);
	let result = session
		.shell
		.run_string(script, &SourceInfo::from("windows-signal-guard"), &params)
		.await
		.expect("run builtin");
	if let Some(child) = bystander.as_mut() {
		let status = tokio::time::timeout(Duration::from_secs(5), child.wait())
			.await
			.expect("bystander was terminated")
			.expect("child status");
		assert_eq!(status.code(), Some(1), "real signal terminated only the bystander");
	}
	std::fs::write(result_path, exit_code(&result).to_string()).expect("publish builtin status");
}

#[tokio::test(flavor = "multi_thread")]
async fn windows_real_signals_refuse_ancestry_while_zero_only_probes() {
	let scratch = veyyon_test_scratch::scratch_dir("windows-signal-guard");
	let ancestor = std::process::id();
	for (index, (script, expected, relay)) in [
		("kill -TERM %self%".to_string(), 1, false),
		("kill -KILL %self%".to_string(), 1, false),
		("kill -INT %self%".to_string(), 1, false),
		("kill -15 %self%".to_string(), 1, false),
		("kill -9 %self%".to_string(), 1, false),
		("kill -2 %self%".to_string(), 1, false),
		("kill %self%".to_string(), 1, false),
		(format!("kill -TERM {ancestor}"), 1, false),
		(format!("kill -KILL {ancestor}"), 1, true),
		("kill -0 %self%".to_string(), 0, false),
		(format!("kill -0 {ancestor}"), 0, false),
		("kill -TERM %child%".to_string(), 0, false),
	]
	.into_iter()
	.enumerate()
	{
		let result_path = scratch.join(format!("result-{index}"));
		let mut command = host_command();
		command
			.env("VEYYON_SIGNAL_SCRIPT", &script)
			.env("VEYYON_SIGNAL_RESULT", &result_path);
		if relay {
			command.env("VEYYON_SIGNAL_RELAY", "1");
		}
		let status = tokio::time::timeout(BOUND, command.status())
			.await
			.expect("host finishes within bound")
			.expect("host status");
		assert!(status.success(), "host remains alive: {script}");
		let code = std::fs::read_to_string(&result_path).expect("host published status");
		assert_eq!(code, expected.to_string(), "builtin status: {script}");
		let stderr = std::fs::read_to_string(result_path.with_extension("stderr")).expect("stderr");
		if expected == 1 {
			assert!(stderr.contains("refusing to signal"), "refusal is explicit: {stderr}");
		} else {
			assert!(stderr.is_empty(), "successful signal operation: {stderr}");
		}
	}
}
