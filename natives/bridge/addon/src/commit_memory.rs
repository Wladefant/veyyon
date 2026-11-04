//! Windows commit accounting for the session heartbeat.
//!
//! On Windows the resource that runs out is not physical memory but commit
//! charge: the sum of every private, committed page, bounded by RAM plus the
//! pagefile. A process that asks for memory past that limit is refused, and
//! the console shows "Out of Virtual Memory" while `os.freemem()` still
//! reports gigabytes free (veyyon#73, D06). Neither `process.memoryUsage()`
//! nor the `os` module can read the commit figures, so the heartbeat reads
//! them here, in-process, with no spawned tool.
//!
//! Other platforms have no equivalent single counter and report `None`; Linux
//! reads its cgroup limits as files on the TypeScript side.

use napi_derive::napi;

/// System and process commit, in bytes.
#[napi(object, js_name = "CommitMemory")]
pub struct CommitMemory {
	/// Committed memory across the whole system (`CommitTotal` x page size).
	pub commit_charge_bytes:  f64,
	/// The most the system can commit: RAM plus pagefile (`CommitLimit` x page
	/// size). Allocation fails when the charge reaches it.
	pub commit_limit_bytes:   f64,
	/// Private committed bytes of this process (`PrivateUsage`).
	pub process_commit_bytes: f64,
}

/// Read system commit charge and limit and this process's private commit.
///
/// `None` off Windows, and on Windows when either kernel query fails.
#[napi(js_name = "readCommitMemory")]
pub fn read_commit_memory() -> Option<CommitMemory> {
	platform::read()
}

#[cfg(windows)]
mod platform {
	use std::mem::size_of;

	use windows_sys::Win32::System::{
		ProcessStatus::{
			K32GetPerformanceInfo, K32GetProcessMemoryInfo, PERFORMANCE_INFORMATION,
			PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
		},
		Threading::GetCurrentProcess,
	};

	use super::CommitMemory;

	/// Bytes as a JS number. Commit never approaches 2^53 (8 PiB), so the
	/// conversion is exact in every reachable range.
	#[allow(clippy::cast_precision_loss, reason = "commit sizes stay far below 2^53 bytes")]
	const fn bytes(value: usize) -> f64 {
		value as f64
	}

	pub fn read() -> Option<CommitMemory> {
		let mut perf = PERFORMANCE_INFORMATION::default();
		let perf_size = u32::try_from(size_of::<PERFORMANCE_INFORMATION>()).ok()?;
		perf.cb = perf_size;
		// SAFETY: `perf` is a live, writable PERFORMANCE_INFORMATION whose `cb`
		// holds its exact size, which is all the call reads before it fills it.
		if unsafe { K32GetPerformanceInfo(&raw mut perf, perf_size) } == 0 {
			return None;
		}

		let mut process = PROCESS_MEMORY_COUNTERS_EX::default();
		let process_size = u32::try_from(size_of::<PROCESS_MEMORY_COUNTERS_EX>()).ok()?;
		process.cb = process_size;
		// SAFETY: `GetCurrentProcess` returns the always-valid pseudo handle. The
		// EX struct begins with the PROCESS_MEMORY_COUNTERS layout, and the call
		// writes only as many bytes as `cb` says, which is the EX size of the
		// buffer it is given.
		let ok = unsafe {
			K32GetProcessMemoryInfo(
				GetCurrentProcess(),
				(&raw mut process).cast::<PROCESS_MEMORY_COUNTERS>(),
				process_size,
			)
		};
		if ok == 0 {
			return None;
		}

		Some(CommitMemory {
			commit_charge_bytes:  bytes(perf.CommitTotal.saturating_mul(perf.PageSize)),
			commit_limit_bytes:   bytes(perf.CommitLimit.saturating_mul(perf.PageSize)),
			process_commit_bytes: bytes(process.PrivateUsage),
		})
	}
}

#[cfg(not(windows))]
mod platform {
	use super::CommitMemory;

	pub const fn read() -> Option<CommitMemory> {
		None
	}
}

#[cfg(all(test, windows))]
mod tests {
	use super::read_commit_memory;

	#[test]
	fn a_running_windows_process_has_nonzero_commit_within_the_limit() {
		let commit = read_commit_memory().expect("the kernel answers for the current process");
		assert!(commit.process_commit_bytes > 0.0);
		assert!(commit.commit_charge_bytes >= commit.process_commit_bytes);
		assert!(commit.commit_limit_bytes >= commit.commit_charge_bytes);
	}
}

#[cfg(all(test, not(windows)))]
mod tests {
	use super::read_commit_memory;

	#[test]
	fn a_platform_without_commit_accounting_reports_none() {
		assert!(read_commit_memory().is_none());
	}
}
