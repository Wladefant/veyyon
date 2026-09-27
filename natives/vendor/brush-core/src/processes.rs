//! Process management

use futures::FutureExt;
use std::io::Write;

#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};

use tokio_util::sync::CancellationToken;

use crate::{error, openfiles::OpenFile, sys};

struct CompletionMarker {
	output:            OpenFile,
	end_marker_prefix: String,
	end_marker_suffix: String,
}

/// A waitable future that will yield the results of a child process's
/// execution.
pub(crate) type WaitableChildProcess = std::pin::Pin<
	Box<dyn futures::Future<Output = Result<std::process::Output, std::io::Error>> + Send + Sync>,
>;

/// Tracks a child process being awaited.
pub struct ChildProcess {
	/// A waitable future that will yield the results of a child process's
	/// execution.
	exec_future: WaitableChildProcess,
	/// Tracks whether this process has already been reaped.
	reaped:      bool,
	/// If available, the process ID of the child.
	pid:         Option<sys::process::ProcessId>,
	/// If available, the process group ID of the child.
	pgid:        Option<sys::process::ProcessId>,
	/// Windows handle duplicated from the child process for safe termination.
	#[cfg(windows)]
	kill_handle: Option<OwnedHandle>,
	/// Linux pidfd opened while the child was known to be ours and unreaped, so
	/// a kill can never reach a process that later receives the same PID.
	#[cfg(target_os = "linux")]
	kill_pidfd: Option<std::os::fd::OwnedFd>,
	completion_marker: Option<CompletionMarker>,
}

impl ChildProcess {
	/// Wraps a child process and its future.
	pub fn new(
		child: sys::process::Child,
		pid: Option<sys::process::ProcessId>,
		pgid: Option<sys::process::ProcessId>,
	) -> Self {
		#[cfg(windows)]
		let kill_handle = child.raw_handle().and_then(duplicate_handle);
		#[cfg(target_os = "linux")]
		let kill_pidfd = pid.filter(|&pid| is_unreaped_child(pid)).and_then(open_pidfd);

		Self {
			exec_future: Box::pin(child.wait_with_output()),
			pid,
			pgid,
			reaped: false,
			#[cfg(windows)]
			kill_handle,
			#[cfg(target_os = "linux")]
			kill_pidfd,
			completion_marker: None,
		}
	}

	/// Returns the process's ID.
	pub const fn pid(&self) -> Option<sys::process::ProcessId> {
		self.pid
	}

	/// Returns the process's group ID.
	pub const fn pgid(&self) -> Option<sys::process::ProcessId> {
		self.pgid
	}

	/// Duplicates the process handle for termination use on Windows.
	#[cfg(windows)]
	pub fn duplicate_kill_handle(&self) -> Option<OwnedHandle> {
		let handle = self.kill_handle.as_ref()?;
		duplicate_handle(handle.as_raw_handle())
	}

	pub(crate) fn set_completion_marker(
		&mut self,
		output: OpenFile,
		end_marker_prefix: String,
		end_marker_suffix: String,
	) {
		self.completion_marker =
			Some(CompletionMarker { output, end_marker_prefix, end_marker_suffix });
	}

	/// Waits for the process to exit.
	///
	/// If a cancellation token is provided and triggered, the process will be killed.
	pub async fn wait(
		&mut self,
		cancel_token: Option<CancellationToken>,
	) -> Result<ProcessWaitResult, error::Error> {
		#[allow(unused_mut, reason = "only mutated on some platforms")]
		let mut sigtstp = sys::signal::tstp_signal_listener()?;
		#[allow(unused_mut, reason = "only mutated on some platforms")]
		let mut sigchld = sys::signal::chld_signal_listener()?;

		let cancelled = async {
			match &cancel_token {
				Some(token) => token.cancelled().await,
				None => std::future::pending().await,
			}
		};
		tokio::pin!(cancelled);

		#[allow(clippy::ignored_unit_patterns)]
		loop {
			tokio::select! {
				output = &mut self.exec_future => {
					let output = output?;
					let marker_exit_code = completion_exit_code(&output.status);
					self.reaped = true;
					self.write_completion_marker(marker_exit_code);
					break Ok(ProcessWaitResult::Completed(output))
				},
				_ = &mut cancelled => {
					self.kill();
					self.write_completion_marker(130);
					break Ok(ProcessWaitResult::Cancelled)
				},
				_ = sigtstp.recv() => {
					break Ok(ProcessWaitResult::Stopped)
				},
				_ = sigchld.recv() => {
					if sys::signal::poll_for_stopped_children()? {
						break Ok(ProcessWaitResult::Stopped);
					}
				},
				_ = sys::signal::await_ctrl_c() => {
					// SIGINT got thrown. Handle it and continue looping. The child should
					// have received it as well, and either handled it or ended up getting
					// terminated (in which case we'll see the child exit).
				},
			}
		}
	}

	/// Sends a kill signal if the process has not already been reaped.
	fn kill(&mut self) {
		if self.reaped {
			return;
		}
		#[cfg(unix)]
		{
			// `reaped` only records reaping observed through `exec_future`. The PID
			// is also freed when anything else in the host reaps the child (a
			// `waitpid(-1)` elsewhere, `SIGCHLD` ignored, or a failed wait), after
			// which it may name an unrelated process. Signal through the pinned
			// pidfd where one exists, otherwise only while the PID is still an
			// unreaped child of this process.
			#[cfg(target_os = "linux")]
			if let Some(pidfd) = &self.kill_pidfd {
				let _ = pidfd_kill(pidfd);
				return;
			}
			let Some(pid) = self.pid else { return };
			if is_unreaped_child(pid) {
				let _ = nix::sys::signal::kill(
					nix::unistd::Pid::from_raw(pid),
					nix::sys::signal::Signal::SIGKILL,
				);
			}
		}

		#[cfg(windows)]
		{
			if let Some(handle) = &self.kill_handle {
				let _ = terminate_raw_handle(handle.as_raw_handle());
			}
			// Never reopen an unpinned PID during cancellation or Drop: the child
			// may have exited and its PID may now identify the host or another run.
		}
	}

	fn write_completion_marker(&mut self, exit_code: i32) {
		if let Some(mut marker) = self.completion_marker.take() {
			let _ = write!(
				marker.output,
				"{}{}{}",
				marker.end_marker_prefix, exit_code, marker.end_marker_suffix
			);
			let _ = marker.output.flush();
		}
	}

	pub(crate) fn poll(&mut self) -> Option<Result<std::process::Output, error::Error>> {
		let result = self.exec_future.as_mut().now_or_never()?;
		Some(match result {
			Ok(output) => {
				let marker_exit_code = completion_exit_code(&output.status);
				self.reaped = true;
				self.write_completion_marker(marker_exit_code);
				Ok(output)
			},
			Err(err) => Err(err.into()),
		})
	}
}

impl Drop for ChildProcess {
	fn drop(&mut self) {
		// Ensure we do not leave an unreaped child running when the handle is dropped.
		self.kill();
	}
}

/// Whether `pid` is a child of this process that has not been reaped. Only
/// then is the PID guaranteed to still name that child: the kernel never
/// reuses the PID of an unreaped child. `WNOWAIT` leaves an exited child
/// waitable for its owner.
#[cfg(unix)]
fn is_unreaped_child(pid: sys::process::ProcessId) -> bool {
	let Ok(id) = nix::libc::id_t::try_from(pid) else {
		return false;
	};
	loop {
		// SAFETY: `siginfo_t` is a plain C struct; all-zero is a valid value.
		let mut info = unsafe { std::mem::zeroed::<nix::libc::siginfo_t>() };
		// SAFETY: `info` is a valid, writable `siginfo_t`; the other arguments are
		// scalars. `WNOWAIT` leaves the child's state unconsumed.
		let rc = unsafe {
			nix::libc::waitid(
				nix::libc::P_PID,
				id,
				&raw mut info,
				nix::libc::WEXITED | nix::libc::WNOHANG | nix::libc::WNOWAIT,
			)
		};
		if rc == 0 {
			return true;
		}
		if nix::errno::Errno::last() != nix::errno::Errno::EINTR {
			return false;
		}
	}
}

#[cfg(target_os = "linux")]
fn open_pidfd(pid: sys::process::ProcessId) -> Option<std::os::fd::OwnedFd> {
	use std::os::fd::FromRawFd;
	// SAFETY: `pidfd_open(pid, 0)` takes two scalars and returns a new file
	// descriptor or -1; it touches no caller memory.
	let fd = unsafe { nix::libc::syscall(nix::libc::SYS_pidfd_open, pid, 0) };
	let fd = std::os::fd::RawFd::try_from(fd).ok().filter(|fd| *fd >= 0)?;
	// SAFETY: `fd` was just returned by `pidfd_open` and is owned by no one else.
	Some(unsafe { std::os::fd::OwnedFd::from_raw_fd(fd) })
}

#[cfg(target_os = "linux")]
fn pidfd_kill(pidfd: &std::os::fd::OwnedFd) -> bool {
	use std::os::fd::AsRawFd;
	// SAFETY: the pidfd is open for the lifetime of the borrow; a null `info`
	// with zero flags is the documented plain-`kill` form of the call.
	let rc = unsafe {
		nix::libc::syscall(
			nix::libc::SYS_pidfd_send_signal,
			pidfd.as_raw_fd(),
			nix::libc::SIGKILL,
			std::ptr::null::<nix::libc::siginfo_t>(),
			0,
		)
	};
	rc == 0
}

#[cfg(windows)]
fn duplicate_handle(handle: RawHandle) -> Option<OwnedHandle> {
	use windows_sys::Win32::{
		Foundation::{DUPLICATE_SAME_ACCESS, DuplicateHandle},
		System::Threading::GetCurrentProcess,
	};

	// SAFETY: GetCurrentProcess returns a pseudo-handle for the current process
	// and has no preconditions.
	let current = unsafe { GetCurrentProcess() };
	let mut out_handle = std::ptr::null_mut();
	// SAFETY: `current` is a valid current-process pseudo-handle, `handle` is
	// an OS process handle owned by Tokio's child process object, and
	// `out_handle` is a valid out pointer checked below before ownership is
	// transferred to OwnedHandle.
	let ok = unsafe {
		DuplicateHandle(
			current,
			handle,
			current,
			&mut out_handle,
			0,
			0,
			DUPLICATE_SAME_ACCESS,
		)
	};
	if ok == 0 || out_handle.is_null() {
		return None;
	}

	// SAFETY: DuplicateHandle succeeded and returned a non-null owned duplicate
	// in `out_handle`, so transferring ownership to OwnedHandle is valid.
	Some(unsafe { OwnedHandle::from_raw_handle(out_handle) })
}

#[cfg(windows)]
fn terminate_raw_handle(handle: RawHandle) -> bool {
	use windows_sys::Win32::System::Threading::{GetProcessId, TerminateProcess};

	// SAFETY: the caller owns a valid process handle for this entire call.
	let pid = unsafe { GetProcessId(handle) };
	if termination_target_is_protected(pid) {
		return false;
	}

	// SAFETY: The caller provides a process handle opened/duplicated for process
	// termination. The handle remains owned by its original owner.
	unsafe { TerminateProcess(handle, 1) != 0 }
}

/// Capture the host's discoverable ancestor PIDs from one Windows snapshot.
///
/// Snapshot failure or a missing host returns `None` (refuse termination).
/// A missing intermediate ancestor ends the walk: Windows may retain its PID
/// after exit, but ancestors above that gap cannot be discovered from this snapshot.
#[cfg(windows)]
pub fn protected_ancestor_pids() -> Option<std::collections::HashSet<u32>> {
	use std::collections::HashMap;
	use windows_sys::Win32::{
		Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
		System::Diagnostics::ToolHelp::{
			CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
			TH32CS_SNAPPROCESS,
		},
	};
	// SAFETY: snapshot creation has no pointer arguments.
	let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
	if snapshot == INVALID_HANDLE_VALUE {
		return None;
	}
	// SAFETY: PROCESSENTRY32W is plain Win32 data; dwSize is set before use.
	let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
	entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
	let mut parents = HashMap::new();
	// SAFETY: snapshot is valid and entry is writable with the correct size.
	let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) };
	while ok != 0 {
		parents.insert(entry.th32ProcessID, entry.th32ParentProcessID);
		// SAFETY: same live snapshot and initialized entry.
		ok = unsafe { Process32NextW(snapshot, &mut entry) };
	}
	// SAFETY: close the snapshot once after enumeration.
	unsafe { CloseHandle(snapshot) };
	ancestors_from_snapshot(std::process::id(), &parents)
}

#[cfg(windows)]
fn ancestors_from_snapshot(
	host: u32,
	parents: &std::collections::HashMap<u32, u32>,
) -> Option<std::collections::HashSet<u32>> {
	if !parents.contains_key(&host) {
		return None;
	}
	let mut cursor = host;
	let mut seen = std::collections::HashSet::new();
	while cursor != 0 && seen.insert(cursor) {
		let Some(parent) = parents.get(&cursor) else {
			break;
		};
		cursor = *parent;
	}
	Some(seen)
}

#[cfg(windows)]
fn termination_target_is_protected(pid: u32) -> bool {
	let refused = pid == 0
		|| protected_ancestor_pids().is_none_or(|ancestors| ancestors.contains(&pid));
	if refused {
		tracing::warn!(pid, "refusing termination of self/ancestor or unverified target");
	}
	refused
}

#[cfg(all(test, windows))]
mod ancestry_tests {
	use super::ancestors_from_snapshot;
	use std::collections::{HashMap, HashSet};

	#[test]
	fn absent_host_refuses_snapshot() {
		assert!(ancestors_from_snapshot(42, &HashMap::new()).is_none());
	}

	#[test]
	fn exited_parent_ends_chain_without_blocking_unrelated_children() {
		let ancestors = ancestors_from_snapshot(42, &HashMap::from([(42, 41), (43, 42)]));
		assert_eq!(ancestors, Some(HashSet::from([42, 41])));
	}

	#[test]
	fn ancestry_cycle_is_bounded() {
		assert_eq!(
			ancestors_from_snapshot(42, &HashMap::from([(42, 41), (41, 42)])),
			Some(HashSet::from([42, 41])),
		);
	}
}

fn completion_exit_code(status: &std::process::ExitStatus) -> i32 {
	if let Some(code) = status.code() {
		return code;
	}

	#[cfg(unix)]
	{
		use std::os::unix::process::ExitStatusExt as _;
		if let Some(signal) = status.signal() {
			return 128 + signal;
		}
	}

	127
}

/// Represents the result of waiting for an executing process.
pub enum ProcessWaitResult {
	/// The process completed.
	Completed(std::process::Output),
	/// The process stopped and has not yet completed.
	Stopped,
	/// The process was killed due to cancellation.
	Cancelled,
}
