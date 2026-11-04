//! Signal processing utilities

pub(crate) use nix::sys::signal::Signal;

use crate::{error, sys, traps};

pub(crate) fn continue_process(pid: sys::process::ProcessId) -> Result<(), error::Error> {
	nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), nix::sys::signal::SIGCONT)
		.map_err(|_errno| error::ErrorKind::FailedToSendSignal)?;
	Ok(())
}

/// Sends a signal to a process or process group, addressed as `kill(2)`
/// addresses it: a positive `pid` names one process, `0` the caller's own
/// group, `-1` every process the caller may signal, and any other negative
/// value the group `-pid`.
///
/// This shell is embedded in a host process, so `$$` names the host rather
/// than a disposable shell. A real signal is refused when its delivery set
/// would include the host or one of its ancestors; see
/// [`signal_target_is_protected`]. Signal `0` (`EXIT`) delivers nothing and
/// only probes existence and permission, so it is never refused.
///
/// # Arguments
/// * `pid` - The process ID to send the signal to
/// * `signal` - The signal to send (a real signal, or `EXIT` for the null signal)
pub fn kill_process(
	pid: sys::process::ProcessId,
	signal: traps::TrapSignal,
) -> Result<(), error::Error> {
	let translated_signal = match signal {
		traps::TrapSignal::Signal(signal) => Some(signal),
		// Signal number 0 parses as the `EXIT` trap; for kill it is the null signal.
		traps::TrapSignal::Exit => None,
		traps::TrapSignal::Debug | traps::TrapSignal::Err | traps::TrapSignal::Return => {
			return Err(error::ErrorKind::InvalidSignal(signal.to_string()).into());
		},
	};

	if translated_signal.is_some() && signal_target_is_protected(pid) {
		return Err(error::ErrorKind::ProtectedSignalTarget(pid).into());
	}

	nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), translated_signal)
		.map_err(|_errno| error::ErrorKind::FailedToSendSignal)?;

	Ok(())
}

/// Returns whether a `kill(2)` target would reach the host process or one of
/// its ancestors.
///
/// `0` and `-1` always include the caller. A positive target is protected when
/// it names the host, an ancestor, or (on Linux) a thread of either, since a
/// thread id signals its whole thread group. A group target is protected when
/// any protected process is a member of it.
///
/// Ancestry is read at call time by walking parent links from the host. It is
/// complete only as far as the walk can see: an ancestor that has already
/// exited is no longer an ancestor (the host was reparented to init or a
/// subreaper, and that new parent is protected instead), and the walk stops at
/// the first process whose parent cannot be read, for example one hidden by
/// `/proc` `hidepid`. The host and its direct parent (`getppid`) are always
/// protected. A group whose membership cannot be read for some ancestor
/// (`getpgid` refused across sessions) is checked against the ancestors whose
/// membership can be read.
pub fn signal_target_is_protected(target: sys::process::ProcessId) -> bool {
	if target == 0 || target == -1 {
		return true;
	}
	let protected = protected_ancestry();
	if target > 0 {
		let target = thread_group_leader(target).unwrap_or(target);
		return protected.contains(&target);
	}
	// `i32::MIN` has no positive group id; the kernel rejects it.
	let Some(pgid) = target.checked_neg() else {
		return false;
	};
	protected.iter().any(|&member| {
		member == pgid
			|| nix::unistd::getpgid(Some(nix::unistd::Pid::from_raw(member)))
				.is_ok_and(|group| group.as_raw() == pgid)
	})
}

/// The host process followed by every ancestor the parent walk can read.
fn protected_ancestry() -> Vec<sys::process::ProcessId> {
	let host = nix::unistd::getpid().as_raw();
	let mut chain = vec![host];
	let mut next = Some(nix::unistd::getppid().as_raw());
	while let Some(parent) = next {
		if parent <= 0 || chain.contains(&parent) {
			break;
		}
		chain.push(parent);
		next = parent_of(parent);
	}
	chain
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn proc_status_field(pid: sys::process::ProcessId, field: &str) -> Option<sys::process::ProcessId> {
	let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
	status
		.lines()
		.find_map(|line| line.strip_prefix(field))
		.and_then(|value| value.trim().parse().ok())
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn parent_of(pid: sys::process::ProcessId) -> Option<sys::process::ProcessId> {
	proc_status_field(pid, "PPid:")
}

/// On Linux a thread id is a valid `kill(2)` target that signals the thread's
/// whole process, so a target is compared by its thread group id.
#[cfg(any(target_os = "linux", target_os = "android"))]
fn thread_group_leader(pid: sys::process::ProcessId) -> Option<sys::process::ProcessId> {
	proc_status_field(pid, "Tgid:")
}

#[cfg(target_os = "macos")]
fn parent_of(pid: sys::process::ProcessId) -> Option<sys::process::ProcessId> {
	// SAFETY: `proc_bsdinfo` is a plain C struct of integers and integer arrays,
	// so the all-zero bit pattern is a valid value.
	let mut info = unsafe { std::mem::zeroed::<nix::libc::proc_bsdinfo>() };
	let size = i32::try_from(size_of::<nix::libc::proc_bsdinfo>()).ok()?;
	// SAFETY: `info` is a writable buffer of exactly `size` bytes; libproc
	// writes at most that many bytes into it.
	let written = unsafe {
		nix::libc::proc_pidinfo(
			pid,
			nix::libc::PROC_PIDTBSDINFO,
			0,
			(&raw mut info).cast::<std::ffi::c_void>(),
			size,
		)
	};
	if written < size {
		return None;
	}
	sys::process::ProcessId::try_from(info.pbi_ppid).ok()
}

/// Without a portable parent query, the walk ends at the host's direct parent.
#[cfg(not(any(target_os = "linux", target_os = "android", target_os = "macos")))]
const fn parent_of(_pid: sys::process::ProcessId) -> Option<sys::process::ProcessId> {
	None
}

#[cfg(not(any(target_os = "linux", target_os = "android")))]
const fn thread_group_leader(_pid: sys::process::ProcessId) -> Option<sys::process::ProcessId> {
	None
}

pub(crate) fn lead_new_process_group() -> Result<(), error::Error> {
	nix::unistd::setpgid(nix::unistd::Pid::from_raw(0), nix::unistd::Pid::from_raw(0))?;
	Ok(())
}

pub(crate) fn tstp_signal_listener() -> Result<tokio::signal::unix::Signal, error::Error> {
	let signal =
		tokio::signal::unix::signal(tokio::signal::unix::SignalKind::from_raw(nix::libc::SIGTSTP))?;
	Ok(signal)
}

pub(crate) fn chld_signal_listener() -> Result<tokio::signal::unix::Signal, error::Error> {
	let signal = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::child())?;
	Ok(signal)
}

pub(crate) use tokio::signal::ctrl_c as await_ctrl_c;

pub(crate) fn mask_sigttou() -> Result<(), error::Error> {
	let ignore = nix::sys::signal::SigAction::new(
		nix::sys::signal::SigHandler::SigIgn,
		nix::sys::signal::SaFlags::empty(),
		nix::sys::signal::SigSet::empty(),
	);

	// SAFETY:
	// Setting the signal action should be safe here. The unsafe concerns
	// for calling `sigaction` are primarily around ensuring that any provided
	// signal handler functions are only performing operations that are
	// safe to do in a signal handler context. Here we are not providing
	// a custom handler, just asking the OS to ignore the signal.
	unsafe { nix::sys::signal::sigaction(nix::sys::signal::Signal::SIGTTOU, &ignore) }?;

	Ok(())
}

pub(crate) fn poll_for_stopped_children() -> Result<bool, error::Error> {
	let mut found_stopped = false;

	loop {
		let wait_status =
			waitid_all(nix::sys::wait::WaitPidFlag::WUNTRACED | nix::sys::wait::WaitPidFlag::WNOHANG);
		match wait_status {
			Ok(nix::sys::wait::WaitStatus::Stopped(_stopped_pid, _signal)) => {
				found_stopped = true;
			},
			Ok(_) => break,
			Err(nix::errno::Errno::ECHILD) => break,
			Err(e) => return Err(e.into()),
		}
	}

	Ok(found_stopped)
}

#[cfg(not(target_os = "macos"))]
fn waitid_all(
	flags: nix::sys::wait::WaitPidFlag,
) -> Result<nix::sys::wait::WaitStatus, nix::errno::Errno> {
	nix::sys::wait::waitid(nix::sys::wait::Id::All, flags)
}

//
// N.B. These functions were mostly copied from nix::sys::wait (https://github.com/nix-rust/nix, MIT license)
// to enable use of the `waitid` call on macOS. Ideally nix would expose it on
// macOS and we would remove this code.
//

#[cfg(target_os = "macos")]
fn waitid_all(
	flags: nix::sys::wait::WaitPidFlag,
) -> Result<nix::sys::wait::WaitStatus, nix::errno::Errno> {
	// SAFETY:
	// Code copied from nix::sys::wait implementation of waitid for other platforms.
	// The siginfo structure is valid when filled with zeroes. Memory is zeroed
	// rather than uninitialized, as not all platforms initialize the memory in
	// the StillAlive case.
	let mut siginfo: nix::libc::siginfo_t = unsafe { std::mem::zeroed() };

	// SAFETY:
	// Code copied from nix::sys::wait implementation of waitid for other platforms.
	nix::errno::Errno::result(unsafe {
		nix::libc::waitid(nix::libc::P_ALL, 0, &raw mut siginfo, flags.bits())
	})?;

	siginfo_to_wait_status(siginfo)
}

#[cfg(target_os = "macos")]
fn siginfo_to_wait_status(
	siginfo: nix::libc::siginfo_t,
) -> Result<nix::sys::wait::WaitStatus, nix::errno::Errno> {
	// SAFETY:
	// Code copied from nix::sys::wait implementation of waitid for other platforms.
	let si_pid = unsafe { siginfo.si_pid() };
	if si_pid == 0 {
		return Ok(nix::sys::wait::WaitStatus::StillAlive);
	}

	let pid = nix::unistd::Pid::from_raw(si_pid);

	// SAFETY:
	// Code copied from nix::sys::wait implementation of waitid for other platforms.
	let si_status = unsafe { siginfo.si_status() };

	let status = match siginfo.si_code {
		nix::libc::CLD_EXITED => nix::sys::wait::WaitStatus::Exited(pid, si_status),
		nix::libc::CLD_KILLED | nix::libc::CLD_DUMPED => nix::sys::wait::WaitStatus::Signaled(
			pid,
			nix::sys::signal::Signal::try_from(si_status)?,
			siginfo.si_code == nix::libc::CLD_DUMPED,
		),
		nix::libc::CLD_STOPPED => {
			nix::sys::wait::WaitStatus::Stopped(pid, nix::sys::signal::Signal::try_from(si_status)?)
		},
		nix::libc::CLD_CONTINUED => nix::sys::wait::WaitStatus::Continued(pid),
		_ => return Err(nix::errno::Errno::EINVAL),
	};

	Ok(status)
}
