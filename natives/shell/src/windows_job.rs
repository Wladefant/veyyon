//! Keep each run's Windows descendants together through intermediate exits.

use std::{
	io,
	os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
	ptr,
	sync::{
		OnceLock,
		atomic::{AtomicBool, Ordering},
	},
};

use brush_core::sys::tokio_process::WINDOWS_CHILD_CREATION_FLAGS;
use tokio::process::{Child, Command};
use windows_sys::Win32::{
	Foundation::INVALID_HANDLE_VALUE,
	System::{
		Diagnostics::ToolHelp::{
			CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
		},
		JobObjects::{AssignProcessToJobObject, CreateJobObjectW, TerminateJobObject},
		Threading::{
			CREATE_SUSPENDED, GetProcessIdOfThread, OpenThread, ResumeThread,
			THREAD_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME,
		},
	},
};

#[derive(Default)]
pub(crate) struct RunJob {
	job:         OnceLock<Option<OwnedHandle>>,
	stopping:    AtomicBool,
	uncontained: AtomicBool,
}

impl RunJob {
	/// Called on Brush's blocking pool. `record` pins the child and applies
	/// the session CPU budget before the run job becomes its innermost job.
	pub(crate) fn spawn(&self, mut command: Command, record: impl FnOnce(u32)) -> io::Result<Child> {
		self.check_stopping()?;
		let job = self.job.get_or_init(create_job).as_ref();
		command.creation_flags(WINDOWS_CHILD_CREATION_FLAGS | CREATE_SUSPENDED);
		let mut child = command.spawn()?;
		let result = (|| {
			let pid = child
				.id()
				.ok_or_else(|| io::Error::other("missing suspended child PID"))?;
			let handle = child
				.raw_handle()
				.ok_or_else(|| io::Error::other("missing suspended child handle"))?;
			let thread = primary_thread(pid)?;
			record(pid);
			if let Some(job) = job {
				// SAFETY: Both handles are owned here. The process handle came from
				// this spawn, and the primary thread has not resumed.
				if unsafe { AssignProcessToJobObject(job.as_raw_handle(), handle) } == 0 {
					eprintln!(
						"veyyon-shell: cannot attach child to run job: {}",
						io::Error::last_os_error()
					);
					self.uncontained.store(true, Ordering::SeqCst);
				}
			} else {
				self.uncontained.store(true, Ordering::SeqCst);
			}
			// Once stopping is published, a late spawn must not run. If this
			// check wins the race, the child is already in the job or registry.
			self.check_stopping()?;
			// SAFETY: The owned thread handle was checked against the pinned child.
			match unsafe { ResumeThread(thread.as_raw_handle()) } {
				1 => Ok(()),
				u32::MAX => Err(io::Error::last_os_error()),
				count => {
					Err(io::Error::other(format!("unexpected child thread suspend count: {count}")))
				},
			}
		})();
		if let Err(error) = result {
			let _ = child.start_kill();
			return Err(error);
		}
		Ok(child)
	}

	fn check_stopping(&self) -> io::Result<()> {
		if self.stopping.load(Ordering::SeqCst) {
			return Err(io::Error::new(io::ErrorKind::Interrupted, "shell run is stopping"));
		}
		Ok(())
	}

	/// Returns false when the caller still needs the pinned-process fallback.
	pub(crate) fn stop(&self) -> bool {
		self.stopping.store(true, Ordering::SeqCst);
		if let Some(Some(job)) = self.job.get() {
			// SAFETY: This unnamed job contains only children spawned by this run
			// and the descendants the kernel assigned to it.
			if unsafe { TerminateJobObject(job.as_raw_handle(), 1) } == 0 {
				eprintln!("veyyon-shell: cannot stop run job: {}", io::Error::last_os_error());
				return false;
			}
		}
		!self.uncontained.load(Ordering::SeqCst)
	}
}

fn create_job() -> Option<OwnedHandle> {
	// SAFETY: Null name and security attributes create a private job with a
	// non-inheritable handle. Closing it does not kill successful background work.
	let job = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
	if job.is_null() {
		eprintln!("veyyon-shell: cannot create run job: {}", io::Error::last_os_error());
		return None;
	}
	// SAFETY: Own the successful CreateJobObjectW result exactly once.
	Some(unsafe { OwnedHandle::from_raw_handle(job) })
}

fn primary_thread(pid: u32) -> io::Result<OwnedHandle> {
	// Tokio exposes the process handle, not the primary thread handle. The child
	// is suspended and its process handle stays open for this entire snapshot walk.
	// SAFETY: TH32CS_SNAPTHREAD takes no caller pointers and ignores the PID
	// argument.
	let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
	if snapshot == INVALID_HANDLE_VALUE {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: Own the successful snapshot handle exactly once.
	let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
	let mut entry =
		THREADENTRY32 { dwSize: size_of::<THREADENTRY32>() as u32, ..Default::default() };
	// SAFETY: The output struct is initialized and writable for the call.
	let mut more = unsafe { Thread32First(snapshot.as_raw_handle(), &raw mut entry) };
	while more != 0 {
		if entry.th32OwnerProcessID == pid {
			// SAFETY: OpenThread takes scalar arguments and yields an owned handle.
			let thread = unsafe {
				OpenThread(
					THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION,
					0,
					entry.th32ThreadID,
				)
			};
			if !thread.is_null() {
				// SAFETY: Own the successful OpenThread result exactly once.
				let thread = unsafe { OwnedHandle::from_raw_handle(thread) };
				// SAFETY: Verify the real thread owner in case the snapshot ID was reused.
				if unsafe { GetProcessIdOfThread(thread.as_raw_handle()) } == pid {
					return Ok(thread);
				}
			}
		}
		entry.dwSize = size_of::<THREADENTRY32>() as u32;
		// SAFETY: Both snapshot and output struct still live.
		more = unsafe { Thread32Next(snapshot.as_raw_handle(), &raw mut entry) };
	}
	Err(io::Error::other("cannot open the suspended shell child's primary thread"))
}
