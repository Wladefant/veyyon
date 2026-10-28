//! WHY: the embedded shell runs in the host process, and three things a
//! command reached resolved against that process instead of the command:
//!
//! - A path naming a descriptor (`/dev/stdin`, `/dev/stdout`, `/dev/stderr`,
//!   `/dev/fd/N`, `/proc/self/fd/N`) opened the HOST's descriptor. In an
//!   in-process builtin, `cat <(echo a)` failed with `/dev/fd/63: No such file
//!   or directory`, `cat /dev/stdin` read the host's terminal until the run
//!   timed out, `tee /dev/stdout` wrote into the host's terminal past the
//!   captured output, and `cat /dev/fd/N` read a file the host held open. A
//!   redirection (`echo x > /dev/stdout`, `cat < /dev/fd/N`) did the same.
//! - A descriptor the host held open without close-on-exec reached every
//!   external child, and anything the child left running.
//! - A child a builtin started (`find -exec`, `xargs`, `sed s///e`, `rg --pre`,
//!   `sort --compress-program`) wrote to the host's stdout, saw the host's
//!   environment rather than the shell's exported one, and was looked up on the
//!   host's `PATH`.
//!
//! The class closed: whatever a command reaches through a descriptor path, an
//! inherited descriptor or a child it starts is the command's own. Every
//! descriptor spelling is swept for every descriptor a command holds, over
//! readers and writers that are builtins, a redirection, and an external
//! program. Every builtin that starts a child is run with a probe program that
//! reports the environment, directory and descriptors it received.
//!
//! What it does not catch: a builtin outside the reader and writer lists that
//! opens its operands without `veyyon_uutils_ctx::resolve`, and a new builtin
//! that starts a child without `veyyon_uutils_ctx::child_command`; each list
//! has to grow with the builtin. A descriptor another thread opens between the
//! close-on-exec sweep and the spawn still reaches that one child.
#![cfg(unix)]

use std::{
	collections::HashMap,
	ffi::CString,
	os::unix::{ffi::OsStrExt, fs::PermissionsExt},
	path::Path,
	sync::LazyLock,
};

use veyyon_shell::{Shell, ShellRunOptions, cancel::CancelToken};
use veyyon_test_scratch::scratch_dir;

/// What the host's private file holds; no command may print it.
const SECRET: &str = "host-private-descriptor-contents";

/// The number the host's private file is open under, without close-on-exec.
const HOST_FD: i32 = 77;

/// The variable the shell exports and the host process does not have.
const SHELL_ONLY: &str = "ZZ_SHELL_ONLY";

/// The host's private file, open under [`HOST_FD`] once for the test binary.
/// The descriptor keeps the file readable after its scratch directory is
/// removed, so no directory outlives the run.
static HOST_DESCRIPTOR: LazyLock<i32> = LazyLock::new(|| {
	let tree = scratch_dir("host-descriptor");
	let file = tree.join("secret.txt");
	std::fs::write(&file, format!("{SECRET}\n")).expect("write secret");
	let path = CString::new(file.as_os_str().as_bytes()).expect("path");
	// SAFETY: `path` is NUL-terminated and outlives the call.
	let fd = unsafe { libc::open(path.as_ptr(), libc::O_RDONLY) };
	assert!(fd >= 0, "open secret: {}", std::io::Error::last_os_error());
	// SAFETY: both descriptors are plain numbers; the result is checked.
	assert_eq!(unsafe { libc::dup2(fd, HOST_FD) }, HOST_FD, "dup2 secret");
	// SAFETY: `fd` was opened above and is closed once.
	unsafe { libc::close(fd) };
	HOST_FD
});

/// Held for the whole of each test: the tests share [`HOST_FD`], and one
/// test clearing its close-on-exec flag between another test's sweep and
/// spawn would leak it into that test's child.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Clears close-on-exec on [`HOST_FD`], the state a runtime that opens files
/// without `O_CLOEXEC` leaves it in. Every run starts from it, so one run's
/// sweep cannot hide a later run that skips the sweep.
fn reopen_host_descriptor_for_inheritance() {
	let fd = *HOST_DESCRIPTOR;
	// SAFETY: `fcntl` on a descriptor number this binary holds open.
	assert_eq!(unsafe { libc::fcntl(fd, libc::F_SETFD, 0) }, 0, "clear FD_CLOEXEC");
}

struct Run {
	exit:      Option<i32>,
	timed_out: bool,
	output:    String,
}

async fn run(shell: &Shell, command: &str, cwd: &Path, path: &str) -> Run {
	reopen_host_descriptor_for_inheritance();
	let (tx, rx) = flume::unbounded::<String>();
	let options = ShellRunOptions {
		command: command.to_owned(),
		cwd: Some(cwd.to_string_lossy().into_owned()),
		env: Some(HashMap::from([("PATH".to_owned(), path.to_owned())])),
		timeout_ms: Some(10_000),
		..ShellRunOptions::default()
	};
	let result = shell
		.run(options, Some(tx), CancelToken::default())
		.await
		.unwrap_or_else(|error| panic!("`{command}`: {error}"));
	let output: String = rx.drain().collect();
	Run { exit: result.exit_code, timed_out: result.timed_out, output }
}

/// Every spelling that names descriptor `fd` of a command.
fn spellings(fd: i32) -> Vec<String> {
	let mut names = vec![format!("/dev/fd/{fd}")];
	if cfg!(target_os = "linux") {
		names.push(format!("/proc/self/fd/{fd}"));
	}
	match fd {
		0 => names.push("/dev/stdin".to_owned()),
		1 => names.push("/dev/stdout".to_owned()),
		2 => names.push("/dev/stderr".to_owned()),
		_ => {},
	}
	names
}

/// Builtins and one external program that print a file operand's content.
const READERS: [&str; 11] = [
	"cat",
	"head -n 5",
	"tail -n 5",
	"sort",
	"uniq",
	"tac",
	"cut -c1-",
	"paste",
	"grep ''",
	"sed -n p",
	"/bin/cat",
];

fn system_path() -> String {
	"/usr/bin:/bin".to_owned()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_descriptor_path_names_the_commands_descriptor() {
	let _serial = SERIAL.lock().await;
	let tree = scratch_dir("descriptor-paths");
	let shell = Shell::new(None);
	let path = system_path();
	let mut failures = Vec::new();
	let mut check = |command: String, run: Run, ok: bool, want: &str| {
		if run.timed_out || !ok {
			failures.push(format!(
				"`{command}`: want {want}, got exit {:?} timed_out {} output {:?}",
				run.exit, run.timed_out, run.output
			));
		}
	};

	for spelling in spellings(0) {
		for reader in READERS {
			let command = format!("printf 'piped\\n' | {reader} {spelling}");
			let run = run(&shell, &command, &tree, &path).await;
			let ok = run.exit == Some(0) && run.output == "piped\n";
			check(command, run, ok, "the piped line");
		}
		// Nothing piped: stdin is the null device, never the host's terminal.
		let command = format!("grep x {spelling}");
		let run = run(&shell, &command, &tree, &path).await;
		let ok = run.exit == Some(1) && run.output.is_empty();
		check(command, run, ok, "no match from an empty stdin");
	}

	for fd in [1, 2] {
		for spelling in spellings(fd) {
			for (command, want) in [
				(format!("printf 'w\\n' | tee {spelling}"), "w\nw\n"),
				(format!("printf 'b\\na\\n' | sort -o {spelling}"), "a\nb\n"),
				(format!("echo r > {spelling}"), "r\n"),
				(format!("/bin/sh -c 'echo e' > {spelling}"), "e\n"),
			] {
				let run = run(&shell, &command, &tree, &path).await;
				let ok = run.exit == Some(0) && run.output == want;
				check(command, run, ok, &format!("{want:?} in the captured output"));
			}
		}
	}

	for (command, want) in [
		("cat <(echo a)", "a\n"),
		("sort <(printf 'z\\ny\\n')", "y\nz\n"),
		("comm <(printf 'a\\nb\\n') <(printf 'b\\nc\\n')", "a\n\t\tb\n\tc\n"),
		("paste <(echo l) <(echo r)", "l\tr\n"),
		("/bin/cat <(echo ext)", "ext\n"),
		("wc -l < <(printf '1\\n2\\n')", "2\n"),
	] {
		let run = run(&shell, command, &tree, &path).await;
		let ok = run.exit == Some(0) && run.output == want;
		check(command.to_owned(), run, ok, &format!("{want:?}"));
	}
	// A substitution is a pipe and reads once: comparing sizes and then
	// reading it again saw two empty inputs and reported no difference.
	let command = "diff <(printf 'a\\n') <(printf 'b\\n')";
	let run_diff = run(&shell, command, &tree, &path).await;
	let ok = run_diff.exit == Some(1)
		&& run_diff.output == "--- /dev/fd/63\n+++ /dev/fd/62\n@@ -1 +1 @@\n-a\n+b\n";
	check(command.to_owned(), run_diff, ok, "the difference between the two substitutions");

	for spelling in spellings(HOST_FD) {
		for reader in ["cat", "head -n 5", "sort", "/bin/cat"] {
			let command = format!("{reader} {spelling}");
			let run = run(&shell, &command, &tree, &path).await;
			let ok = run.exit.is_some_and(|code| code != 0) && !run.output.contains(SECRET);
			check(command, run, ok, "a failure without the host's file");
		}
		let command = format!("cat < {spelling}");
		let run = run(&shell, &command, &tree, &path).await;
		let ok = run.exit.is_some_and(|code| code != 0) && !run.output.contains(SECRET);
		check(command, run, ok, "a failed redirection without the host's file");
	}

	assert!(failures.is_empty(), "{} commands escaped:\n{}", failures.len(), failures.join("\n"));
}

/// Writes an executable script into `dir`.
fn script(dir: &Path, name: &str, body: &str) {
	let file = dir.join(name);
	std::fs::write(&file, format!("#!/bin/sh\n{body}")).expect("write script");
	std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).expect("chmod script");
}

/// What a child reports when it ran from `dir` with the shell's environment and
/// without the host's descriptor.
fn clean_probe(dir: &Path) -> String {
	let dir = dir.canonicalize().expect("canonical dir");
	format!("probe env=from-shell cwd={} leak=no\n", dir.display())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_builtin_starts_its_child_the_way_the_shell_would() {
	let _serial = SERIAL.lock().await;
	let tree = scratch_dir("builtin-children");
	let bin = tree.join("bin");
	let sub = tree.join("sub");
	std::fs::create_dir_all(&bin).expect("bin");
	std::fs::create_dir_all(&sub).expect("sub");
	std::fs::write(sub.join("leaf"), "leaf\n").expect("leaf");
	std::fs::write(tree.join("data.txt"), "data\n").expect("data");
	let leak_check = format!("if [ -e /dev/fd/{HOST_FD} ]; then leak=yes; else leak=no; fi\n");
	// Found only through the shell's PATH; reports what the child received.
	script(
		&bin,
		"zz-probe",
		&format!(
			"{leak_check}printf 'probe env=%s cwd=%s leak=%s\\n' \"${SHELL_ONLY}\" \"$(pwd -P)\" \
			 \"$leak\"\n"
		),
	);
	// An identity compressor that records what each invocation received.
	script(
		&bin,
		"zz-compress",
		&format!(
			"{leak_check}printf 'env=%s leak=%s\\n' \"${SHELL_ONLY}\" \"$leak\" >> sort-probe\nexec \
			 cat\n"
		),
	);
	let shell = Shell::new(None);
	let path = format!("{}:{}", bin.display(), system_path());
	let prefix = format!("export {SHELL_ONLY}=from-shell; ");

	let in_tree = clean_probe(&tree);
	let in_sub = clean_probe(&sub);
	let cases: [(&str, &String); 7] = [
		("find . -maxdepth 0 -exec zz-probe {} \\;", &in_tree),
		("find . -maxdepth 0 -exec zz-probe {} +", &in_tree),
		("find sub -name leaf -execdir zz-probe {} \\;", &in_sub),
		("find sub -name leaf -execdir zz-probe {} +", &in_sub),
		("echo arg | xargs zz-probe", &in_tree),
		("echo x | sed 's/.*/zz-probe/e'", &in_tree),
		("rg --pre zz-probe probe data.txt", &in_tree),
	];
	let mut failures = Vec::new();
	for (command, want) in cases {
		let run = run(&shell, &format!("{prefix}{command}"), &tree, &path).await;
		if run.exit != Some(0) || run.timed_out || run.output != *want {
			failures.push(format!(
				"`{command}`: want {want:?}, got exit {:?} timed_out {} output {:?}",
				run.exit, run.timed_out, run.output
			));
		}
	}

	let command = "seq 20000 | sort -n -S 1K --compress-program=zz-compress | tail -n 1";
	let sorted = run(&shell, &format!("{prefix}{command}"), &tree, &path).await;
	let probes = std::fs::read_to_string(tree.join("sort-probe")).unwrap_or_default();
	if sorted.exit != Some(0)
		|| sorted.output != "20000\n"
		|| probes.is_empty()
		|| probes.lines().any(|line| line != "env=from-shell leak=no")
	{
		failures.push(format!(
			"`{command}`: want 20000 and clean compressor probes, got exit {:?} output {:?} probes \
			 {probes:?}",
			sorted.exit, sorted.output
		));
	}

	assert!(failures.is_empty(), "{} children escaped:\n{}", failures.len(), failures.join("\n"));
}
