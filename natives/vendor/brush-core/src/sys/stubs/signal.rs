//! Signal processing utilities

use crate::{error, sys, traps};

/// A stub enum representing system signals on unsupported platforms.
#[cfg(not(windows))]
#[allow(unnameable_types)]
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Signal {}

/// Minimal signal representation for Windows.
#[cfg(windows)]
#[allow(unnameable_types)]
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Signal {
	/// Terminate signal.
	Terminate = 15,
	/// Kill signal.
	Kill = 9,
	/// Interrupt signal.
	Interrupt = 2,
}

impl Signal {
	/// Returns an iterator over all possible signals.
	#[cfg(windows)]
	pub fn iterator() -> impl Iterator<Item = Self> {
		[Self::Terminate, Self::Kill, Self::Interrupt].into_iter()
	}

	/// Returns an iterator over all possible signals.
	#[cfg(not(windows))]
	pub fn iterator() -> impl Iterator<Item = Self> {
		std::iter::empty()
	}

	/// Converts the signal into its corresponding name as a `&'static str`.
	#[cfg(windows)]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Terminate => "TERM",
			Self::Kill => "KILL",
			Self::Interrupt => "INT",
		}
	}

	/// Converts the signal into its corresponding name as a `&'static str`.
	#[cfg(not(windows))]
	pub const fn as_str(self) -> &'static str {
		""
	}

	/// Creates a `Signal` from a string representation.
	#[cfg(windows)]
	pub fn from_str(s: &str) -> Result<Self, error::Error> {
		match s.to_ascii_uppercase().as_str() {
			"TERM" | "SIGTERM" => Ok(Self::Terminate),
			"KILL" | "SIGKILL" => Ok(Self::Kill),
			"INT" | "SIGINT" => Ok(Self::Interrupt),
			_ => Err(error::ErrorKind::InvalidSignal(s.into()).into()),
		}
	}

	/// Creates a `Signal` from a string representation.
	#[cfg(not(windows))]
	pub fn from_str(s: &str) -> Result<Self, error::Error> {
		Err(error::ErrorKind::InvalidSignal(s.into()).into())
	}
}

impl TryFrom<i32> for Signal {
	type Error = error::Error;

	fn try_from(value: i32) -> Result<Self, Self::Error> {
		#[cfg(windows)]
		match value {
			15 => Ok(Self::Terminate),
			9 => Ok(Self::Kill),
			2 => Ok(Self::Interrupt),
			_ => Err(error::ErrorKind::InvalidSignal(value.to_string()).into()),
		}
		#[cfg(not(windows))]
		Err(error::ErrorKind::InvalidSignal(value.to_string()).into())
	}
}

pub(crate) fn continue_process(_pid: sys::process::ProcessId) -> Result<(), error::Error> {
	Err(error::ErrorKind::NotSupportedOnThisPlatform("continuing process").into())
}

/// Sends a signal to a specific process.
///
/// Windows protects host ancestry and supports non-delivering signal-zero probes;
/// other unsupported platforms return an error.
pub fn kill_process(
	_pid: sys::process::ProcessId,
	_signal: traps::TrapSignal,
) -> Result<(), error::Error> {
	#[cfg(windows)]
	{
		use windows_sys::Win32::Foundation::CloseHandle;
		use windows_sys::Win32::System::Threading::{
			OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE, TerminateProcess,
		};

		let pid = u32::try_from(_pid).map_err(|_| error::ErrorKind::FailedToSendSignal)?;
		let deliver = match _signal {
			traps::TrapSignal::Signal(_) => true,
			traps::TrapSignal::Exit => false,
			_ => return Err(error::ErrorKind::InvalidSignal(_signal.to_string()).into()),
		};
		if deliver && crate::processes::termination_target_is_protected(pid) {
			return Err(error::ErrorKind::ProtectedSignalTarget(_pid).into());
		}
		// SAFETY: the access mask permits only the requested operation. A null
		// handle is checked before use; signal zero never opens termination access.
		let access = if deliver { PROCESS_TERMINATE } else { PROCESS_QUERY_LIMITED_INFORMATION };
		let handle = unsafe { OpenProcess(access, 0, pid) };
		if handle.is_null() {
			return Err(error::ErrorKind::FailedToSendSignal.into());
		}

		// SAFETY: the live handle has termination access when delivering a signal.
		let ok = if deliver { unsafe { TerminateProcess(handle, 1) } } else { 1 };
		// SAFETY: The handle was returned by OpenProcess and is closed exactly once here.
		let _close_result = unsafe { CloseHandle(handle) };
		if ok == 0 {
			return Err(error::ErrorKind::FailedToSendSignal.into());
		}

		Ok(())
	}
	#[cfg(not(windows))]
	Err(error::ErrorKind::NotSupportedOnThisPlatform("killing process").into())
}

pub(crate) fn lead_new_process_group() -> Result<(), error::Error> {
	Ok(())
}

pub(crate) struct FakeSignal {}

impl FakeSignal {
	fn new() -> Self {
		Self {}
	}

	pub async fn recv(&self) {
		futures::future::pending::<()>().await;
	}
}

pub(crate) fn tstp_signal_listener() -> Result<FakeSignal, error::Error> {
	Ok(FakeSignal::new())
}

pub(crate) fn chld_signal_listener() -> Result<FakeSignal, error::Error> {
	Ok(FakeSignal::new())
}

pub(crate) async fn await_ctrl_c() -> std::io::Result<()> {
	FakeSignal::new().recv().await;
	Ok(())
}

pub(crate) fn mask_sigttou() -> Result<(), error::Error> {
	Ok(())
}

pub(crate) fn poll_for_stopped_children() -> Result<bool, error::Error> {
	Ok(false)
}
