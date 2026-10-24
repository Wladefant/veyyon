//! Command execution utilities.

pub use std::os::unix::process::{CommandExt, ExitStatusExt};

use command_fds::{CommandFdExt, FdMapping};

use crate::{ShellFd, error, openfiles};

/// Extension trait for injecting file descriptors into commands.
pub trait CommandFdInjectionExt {
	/// Injects the given open files as file descriptors into the command.
	///
	/// # Arguments
	///
	/// * `open_files` - A mapping of child file descriptors to open files.
	fn inject_fds(
		&mut self,
		open_files: impl Iterator<Item = (ShellFd, openfiles::OpenFile)>,
	) -> Result<(), error::Error>;
}

impl CommandFdInjectionExt for std::process::Command {
	fn inject_fds(
		&mut self,
		open_files: impl Iterator<Item = (ShellFd, openfiles::OpenFile)>,
	) -> Result<(), error::Error> {
		let fd_mappings: Vec<FdMapping> = open_files
			.map(|(child_fd, open_file)| -> Result<FdMapping, error::Error> {
				let parent_fd = open_file.try_clone_to_owned()?;
				Ok(FdMapping { child_fd, parent_fd })
			})
			.collect::<Result<Vec<_>, _>>()?;

		// `fd_mappings` registers a `pre_exec` hook even for an empty mapping,
		// and any `pre_exec` hook makes `std` fork instead of `posix_spawn`.
		if fd_mappings.is_empty() {
			return Ok(());
		}

		self
			.fd_mappings(fd_mappings)
			.map_err(|_e| error::ErrorKind::ChildCreationFailure)?;

		Ok(())
	}
}

/// Extension trait for arranging for commands to take the foreground.
pub trait CommandFgControlExt {
	/// Arranges for the command to take the foreground when it is executed.
	fn take_foreground(&mut self);
	/// Arranges for the command to become a session leader when it is executed.
	fn lead_session(&mut self);
}

impl CommandFgControlExt for std::process::Command {
	fn take_foreground(&mut self) {
		// SAFETY:
		// This arranges for a provided function to run in the context of
		// the forked process before it exec's the target command. In general,
		// rust can't guarantee safety of code running in such a context.
		unsafe {
			self.pre_exec(pre_exec_take_foreground);
		}
	}

	fn lead_session(&mut self) {
		// SAFETY:
		// This arranges for a provided function to run in the context of
		// the forked process before it exec's the target command. In general,
		// rust can't guarantee safety of code running in such a context.
		unsafe {
			self.pre_exec(pre_exec_lead_session);
		}
	}
}

/// Extension trait for detaching commands from the parent's controlling terminal.
pub trait CommandSessionExt {
	/// Arranges for the command to run in a new POSIX session with no controlling terminal.
	fn detach_session(&mut self);
	/// Like [`CommandSessionExt::detach_session`], but additionally double-forks
	/// so the spawned process reparents to init (PID 1) and leaves the caller's
	/// descendant tree.
	fn detach_session_reparent(&mut self);
}

impl CommandSessionExt for std::process::Command {
	fn detach_session(&mut self) {
		// `std` applies `setsid` through `posix_spawn` (`POSIX_SPAWN_SETSID`) on
		// Linux with glibc, and through setsid(2) after fork elsewhere. The child
		// is never a process group leader here: a detached child is given no
		// `process_group`, so setsid(2) cannot fail with EPERM.
		if posix_spawn_accepts_setsid() {
			self.setsid(true);
		} else {
			// SAFETY: the hook runs in the forked child before exec and calls
			// only setsid(2), which is async-signal-safe.
			unsafe {
				self.pre_exec(pre_exec_detach_session);
			}
		}
	}

	fn detach_session_reparent(&mut self) {
		// SAFETY:
		// This arranges for a provided function to run in the forked child before
		// exec. Only async-signal-safe calls (`setsid`, `fork`, `_exit`) are used.
		unsafe {
			self.pre_exec(pre_exec_detach_session_reparent);
		}
	}
}

/// Whether `std` can start a child in a new session without failing the
/// spawn. glibc before 2.26 rejects `POSIX_SPAWN_SETSID` with EINVAL, and
/// `std` passes the flag on every glibc from 2.24, so a 2.24 or 2.25 host takes
/// the `pre_exec` hook instead. Other platforms fork when `setsid` is set.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn posix_spawn_accepts_setsid() -> bool {
	static ACCEPTS: std::sync::LazyLock<bool> = std::sync::LazyLock::new(|| {
		// SAFETY: glibc returns a pointer to a static NUL-terminated string.
		let version = unsafe { std::ffi::CStr::from_ptr(libc::gnu_get_libc_version()) };
		let mut parts = version.to_str().unwrap_or("").split('.').map(|part| part.parse::<u32>().unwrap_or(0));
		(parts.next().unwrap_or(0), parts.next().unwrap_or(0)) >= (2, 26)
	});
	*ACCEPTS
}

#[cfg(not(all(target_os = "linux", target_env = "gnu")))]
const fn posix_spawn_accepts_setsid() -> bool {
	true
}

fn pre_exec_detach_session() -> Result<(), std::io::Error> {
	match nix::unistd::setsid() {
		Ok(_) | Err(nix::errno::Errno::EPERM) => Ok(()),
		Err(errno) => Err(std::io::Error::from_raw_os_error(errno as i32)),
	}
}

fn pre_exec_take_foreground() -> Result<(), std::io::Error> {
	use crate::sys;

	sys::terminal::move_self_to_foreground()?;
	Ok(())
}

fn pre_exec_lead_session() -> Result<(), std::io::Error> {
	if let Err(e) = nix::unistd::setsid() {
		return Err(std::io::Error::other(format!("failed to become session leader: {e}")));
	}

	#[cfg(not(target_os = "macos"))]
	let control = libc::TIOCSCTTY;
	#[cfg(target_os = "macos")]
	let control: u64 = libc::TIOCSCTTY.into();

	// SAFETY:
	// This is calling a libc function to set the controlling terminal.
	let result = unsafe { libc::ioctl(0, control, 0) };
	if result != 0 {
		return Err(std::io::Error::other("failed to set controlling terminal"));
	}

	Ok(())
}

fn pre_exec_detach_session_reparent() -> Result<(), std::io::Error> {
	// New session first: drop any controlling terminal. Ignore EPERM, which means
	// the child is already a session leader from an outer policy.
	match nix::unistd::setsid() {
		Ok(_) | Err(nix::errno::Errno::EPERM) => {},
		Err(errno) => return Err(std::io::Error::from_raw_os_error(errno as i32)),
	}

	// Double-fork: the intermediate child — the pid the parent's spawn machinery
	// tracks — exits immediately, so the grandchild that goes on to `exec` the
	// operand reparents to init (PID 1) and is no longer a descendant of the
	// shell. This is what lets `nohup cmd &` survive the host's descendant-walk
	// teardown without relying on an external `setsid(1)` binary.
	//
	// SAFETY: the post-`fork` child here is single-threaded, and only
	// async-signal-safe primitives (`fork`, `_exit`) run before `exec`.
	let pid = unsafe { libc::fork() };
	if pid < 0 {
		return Err(std::io::Error::last_os_error());
	}
	if pid > 0 {
		// Intermediate parent: exit now to orphan the grandchild. `_exit` avoids
		// running atexit handlers or flushing inherited buffers in the fork.
		unsafe { libc::_exit(0) };
	}
	Ok(())
}
