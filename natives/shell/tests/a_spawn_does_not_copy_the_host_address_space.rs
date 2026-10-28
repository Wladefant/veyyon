//! WHY: every external program the embedded shell started was created with
//! fork(2). brush registered a `pre_exec` hook for each one, setsid(2) for a
//! detached child and a descriptor-mapping hook that `command-fds` installs
//! even when there is nothing to map, and any `pre_exec` hook makes
//! `std::process::Command` fork instead of calling `posix_spawn`. A fork copies
//! the host's page tables and write-protects every private page, so one
//! `/usr/bin/true` took 0.8 ms in a 41 MB host and 58 ms in a 2 GB one, and the
//! host then took a copy-on-write fault on each page it wrote next.
//!
//! The class closed: no route by which a command line starts a program marks
//! the host's pages copy-on-write. Each route runs while the test process holds
//! a ballast of small private pages, and the minor faults the process takes
//! rewriting the ballast afterwards count the pages the spawn write-protected:
//! all of them after a fork, none after `posix_spawn`, whose child shares the
//! parent's memory until it executes. Every route also proves it started its
//! program, so a route that silently starts nothing cannot pass.
//!
//! Two routes still fork, pinned by exact equality in [`FORKING`]: a program
//! given a descriptor above 2, which `std` can only map in a `pre_exec` hook,
//! and `nohup cmd &`, whose second fork has to run in the child. Their faults
//! also prove the measurement detects a fork.
//!
//! What it does not catch: a route missing from [`ROUTES`], and a spawn that
//! avoids fork but is slow for another reason.
#![cfg(all(target_os = "linux", target_env = "gnu"))]

use std::{
	collections::HashMap,
	os::unix::fs::PermissionsExt,
	path::Path,
	time::{Duration, Instant},
};

use veyyon_shell::{Shell, ShellRunOptions, cancel::CancelToken};
use veyyon_test_scratch::scratch_dir;

/// Private memory the test process holds while each route runs.
const BALLAST_BYTES: usize = 64 << 20;

/// Every route by which a command line starts a program. `@MARK@` is the
/// absolute path of a program that records that it ran and then copies its
/// input to its output; `zz-mark` is the same program found on `PATH`.
const ROUTES: [(&str, &str); 18] = [
	("an absolute program", "@MARK@"),
	("a program found on PATH", "zz-mark"),
	("redirected output", "@MARK@ > out.txt 2>&1"),
	("a pipeline stage", "echo x | @MARK@ | cat"),
	("a command substitution", "x=$(@MARK@)"),
	("a subshell", "( @MARK@ )"),
	("a background job", "@MARK@ & wait"),
	("the command builtin", "command @MARK@"),
	("the timeout builtin", "timeout 5 @MARK@"),
	("find -exec ;", "find . -maxdepth 0 -exec @MARK@ \\;"),
	("find -exec +", "find . -maxdepth 0 -exec @MARK@ {} +"),
	("find -execdir", "find sub -name leaf -execdir @MARK@ \\;"),
	("xargs", "echo arg | xargs @MARK@"),
	("sed s///e", "echo x | sed 's|.*|@MARK@|e'"),
	("rg --pre", "rg --pre @MARK@ data data.txt"),
	("sort --compress-program", "seq 20000 | sort -n -S 1K --compress-program=@MARK@ | tail -n 1"),
	("a descriptor above 2", "@MARK@ 3< data.txt"),
	("nohup in the background", "nohup @MARK@ &"),
];

/// The routes that fork, and why, in the module documentation.
const FORKING: [&str; 2] = ["a descriptor above 2", "nohup in the background"];

/// Small private pages the test process writes before and after each route.
struct Ballast {
	base: usize,
	page: usize,
}

impl Ballast {
	fn new() -> Self {
		// SAFETY: `sysconf` reads a constant of the running system.
		let page = usize::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) }).expect("page size");
		// SAFETY: an anonymous private mapping names no file; the result is checked.
		let base = unsafe {
			libc::mmap(
				std::ptr::null_mut(),
				BALLAST_BYTES,
				libc::PROT_READ | libc::PROT_WRITE,
				libc::MAP_PRIVATE | libc::MAP_ANONYMOUS,
				-1,
				0,
			)
		};
		assert_ne!(base, libc::MAP_FAILED, "mmap: {}", std::io::Error::last_os_error());
		// A fork write-protects a huge page as one entry, one fault where small
		// pages take one each.
		// SAFETY: the range was mapped above.
		let advised = unsafe { libc::madvise(base, BALLAST_BYTES, libc::MADV_NOHUGEPAGE) };
		assert_eq!(advised, 0, "madvise: {}", std::io::Error::last_os_error());
		let ballast = Self { base: base as usize, page };
		ballast.write_every_page();
		ballast
	}

	const fn pages(&self) -> usize {
		BALLAST_BYTES / self.page
	}

	fn write_every_page(&self) {
		for offset in (0..BALLAST_BYTES).step_by(self.page) {
			// SAFETY: `offset` is inside the writable mapping made in `new`.
			unsafe { ((self.base + offset) as *mut u8).write_volatile(1) };
		}
	}
}

impl Drop for Ballast {
	fn drop(&mut self) {
		// SAFETY: unmaps the range `new` mapped, once.
		unsafe { libc::munmap(self.base as *mut libc::c_void, BALLAST_BYTES) };
	}
}

/// The minor faults this process has taken so far.
fn minor_faults() -> i64 {
	let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
	// SAFETY: `usage` is a valid out-pointer for one `rusage`.
	assert_eq!(unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) }, 0, "getrusage");
	// SAFETY: `getrusage` filled `usage`.
	unsafe { usage.assume_init() }.ru_minflt
}

/// Waits for the marker program to record a run, up to five seconds: the
/// operand of `nohup cmd &` is reparented and nothing waits for it.
async fn wait_for_mark(log: &Path) -> bool {
	let deadline = Instant::now() + Duration::from_secs(5);
	loop {
		if std::fs::read_to_string(log).is_ok_and(|ran| ran.contains("ran")) {
			return true;
		}
		if Instant::now() >= deadline {
			return false;
		}
		tokio::time::sleep(Duration::from_millis(20)).await;
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn no_route_that_starts_a_program_copies_the_host_address_space() {
	let tree = scratch_dir("spawn-address-space");
	let bin = tree.join("bin");
	let sub = tree.join("sub");
	std::fs::create_dir_all(&bin).expect("bin");
	std::fs::create_dir_all(&sub).expect("sub");
	std::fs::write(sub.join("leaf"), "leaf\n").expect("leaf");
	std::fs::write(tree.join("data.txt"), "data\n").expect("data");
	let log = tree.join("ran.log");
	let mark = bin.join("zz-mark");
	std::fs::write(&mark, format!("#!/bin/sh\nprintf 'ran\\n' >> '{}'\nexec cat\n", log.display()))
		.expect("write marker");
	std::fs::set_permissions(&mark, std::fs::Permissions::from_mode(0o755)).expect("chmod marker");

	let shell = Shell::new(None);
	let path = format!("{}:/usr/bin:/bin", bin.display());
	let ballast = Ballast::new();
	let mut forking = Vec::new();
	let mut failures = Vec::new();
	for (route, template) in ROUTES {
		let command = template.replace("@MARK@", &mark.to_string_lossy());
		let _ = std::fs::remove_file(&log);
		ballast.write_every_page();
		let options = ShellRunOptions {
			command: command.clone(),
			cwd: Some(tree.to_string_lossy().into_owned()),
			env: Some(HashMap::from([("PATH".to_owned(), path.clone())])),
			timeout_ms: Some(10_000),
			..ShellRunOptions::default()
		};
		let result = shell
			.run(options, None, CancelToken::default())
			.await
			.unwrap_or_else(|error| panic!("{route}: `{command}`: {error}"));
		let before = minor_faults();
		ballast.write_every_page();
		let faults = minor_faults() - before;
		if result.timed_out || !wait_for_mark(&log).await {
			failures.push(format!(
				"{route}: `{command}` did not start its program (exit {:?}, timed out {})",
				result.exit_code, result.timed_out
			));
		}
		if faults >= i64::try_from(ballast.pages() / 2).expect("page count") {
			forking.push(route);
		}
	}
	assert!(failures.is_empty(), "{}", failures.join("\n"));
	assert_eq!(forking, FORKING, "routes whose spawn write-protected the host's pages");
}
