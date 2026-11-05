//! Per-OS session CPU budget groups.
//!
//! OWNERSHIP SPLIT with the TypeScript session layer
//! (`packages/coding-agent/src/session/cpu-limit.ts`). This side owns the
//! mechanics a budget needs from the OS: creating the group, adopting spawned
//! children into it, reading its usage, tearing it down. The spawn points
//! that first see a child pid live in the native addon (the brush spawn
//! observer, the PTY spawner), so the per-OS "add a process to the budget"
//! operation has to live here as well. The TS side owns all policy: probing
//! the host, picking a backend, the once-a-second watcher, deny/kill
//! decisions, settings, and lifecycle. Policy never appears here; OS
//! mechanics never appear there.
//!
//! Three backends behind one shape:
//!
//! - Linux: a cgroup v2 directory. `cpu.max` throttles, `cpu.stat` meters,
//!   `cgroup.procs` adopts and lists. The kernel cap holds even if every
//!   watcher dies.
//! - Windows: a Job Object with `JOB_OBJECT_CPU_RATE_CONTROL` hard cap.
//!   `CpuRate` is a fraction of TOTAL machine capacity (`10_000` = every
//!   logical processor), so the rate for N cores is `N / host * 10_000`.
//! - Anything else (macOS): bookkeeping only. No per-group CPU quota exists
//!   there, `throttles` is false, usage comes from summing `proc_pidinfo` over
//!   tracked members, and the TS watcher layers deny / renice / kill on top.
//!   Nothing in this backend pretends a quota exists.

use std::{collections::HashMap, sync::Arc};

use anyhow::Result;
use parking_lot::Mutex;

#[cfg(target_os = "linux")]
mod linux;
mod tracked;
#[cfg(target_os = "windows")]
mod windows;
mod windows_rate;

/// Which backend a budget group uses, chosen by the TS probe.
#[derive(Debug, Clone)]
pub enum BudgetBackendSpec {
	/// Linux direct: create and own a cgroup under this delegated parent.
	Cgroup { parent_dir: String },
	/// Linux systemd-run: manage an existing scope cgroup. The quota belongs
	/// to systemd (`CPUQuota`), so `set_cores` and teardown leave it alone.
	ExistingCgroup { dir: String },
	/// Platform default with no cgroup input: a Job Object on Windows,
	/// bookkeeping-only anywhere else. The TS probe only picks this after it
	/// has established the platform.
	Native,
	/// Bookkeeping-only, forced. Exists so tests can exercise the degraded
	/// path on any host.
	Tracked,
}

/// One session's budget group. Cheap to share: every operation touches the OS
/// or a small lock, never a runtime.
pub struct BudgetGroup {
	throttles: bool,
	backend:   Backend,
}

enum Backend {
	#[cfg(target_os = "linux")]
	Linux(linux::LinuxBudget),
	#[cfg(target_os = "windows")]
	Windows(windows::JobBudget),
	Tracked(tracked::TrackedBudget),
}

impl BudgetGroup {
	/// Create a group for `cores` cores. Fails with a reason when the spec
	/// does not match the host platform; the TS probe never lets that happen,
	/// so an error here means the probe and the platform drifted apart.
	pub fn create(spec: &BudgetBackendSpec, name: &str, cores: f64) -> Result<Self> {
		match spec {
			BudgetBackendSpec::Cgroup { parent_dir } => Self::create_cgroup(parent_dir, name, cores),
			BudgetBackendSpec::ExistingCgroup { dir } => Self::manage_cgroup(dir, name, cores),
			BudgetBackendSpec::Native => Self::create_native(name, cores),
			BudgetBackendSpec::Tracked => Ok(Self::tracked()),
		}
	}

	#[cfg(target_os = "linux")]
	fn create_cgroup(parent_dir: &str, name: &str, cores: f64) -> Result<Self> {
		Ok(Self {
			throttles: true,
			backend:   Backend::Linux(linux::LinuxBudget::create(parent_dir, name, cores)?),
		})
	}

	#[cfg(not(target_os = "linux"))]
	fn create_cgroup(parent_dir: &str, name: &str, cores: f64) -> Result<Self> {
		let _ = (parent_dir, name, cores);
		Err(anyhow::Error::msg("cgroup budgets are Linux-only"))
	}

	#[cfg(target_os = "linux")]
	fn manage_cgroup(dir: &str, _name: &str, _cores: f64) -> Result<Self> {
		Ok(Self {
			throttles: true,
			backend:   Backend::Linux(linux::LinuxBudget::manage_existing(dir)?),
		})
	}

	#[cfg(not(target_os = "linux"))]
	fn manage_cgroup(dir: &str, name: &str, cores: f64) -> Result<Self> {
		let _ = (dir, name, cores);
		Err(anyhow::Error::msg("cgroup budgets are Linux-only"))
	}

	#[cfg(target_os = "windows")]
	fn create_native(name: &str, cores: f64) -> Result<Self> {
		Ok(Self {
			throttles: true,
			backend:   Backend::Windows(windows::JobBudget::create(name, cores)?),
		})
	}

	#[cfg(not(target_os = "windows"))]
	#[allow(
		clippy::unnecessary_wraps,
		reason = "the Windows variant allocates a Job Object and can fail"
	)]
	fn create_native(_name: &str, _cores: f64) -> Result<Self> {
		Ok(Self::tracked())
	}

	fn tracked() -> Self {
		Self { throttles: false, backend: Backend::Tracked(tracked::TrackedBudget::new()) }
	}

	/// Whether the OS throttles this group's members. When false the budget
	/// is policy-only (deny / renice / kill from the TS watcher).
	#[must_use]
	pub const fn throttles(&self) -> bool {
		self.throttles
	}

	/// Move a spawned child into the group. Best-effort everywhere: a child
	/// that already exited, or a group torn down mid-spawn, must not fail the
	/// command the pid belongs to.
	pub fn adopt(&self, pid: i32) {
		match &self.backend {
			#[cfg(target_os = "linux")]
			Backend::Linux(budget) => budget.adopt(pid),
			#[cfg(target_os = "windows")]
			Backend::Windows(budget) => budget.adopt(pid),
			Backend::Tracked(budget) => budget.adopt(pid),
		}
	}

	/// Total CPU the group has consumed, in microseconds, when the platform
	/// reports it. The watcher differentiates this into a rate.
	#[must_use]
	pub fn usage_usec(&self) -> Option<u64> {
		match &self.backend {
			#[cfg(target_os = "linux")]
			Backend::Linux(budget) => budget.usage_usec(),
			#[cfg(target_os = "windows")]
			Backend::Windows(budget) => budget.usage_usec(),
			Backend::Tracked(budget) => budget.usage_usec(),
		}
	}

	/// How often the kernel throttled the group, when the platform counts it.
	/// The watcher uses an increasing count to tell "the budget is too small"
	/// from "the budget is merely fully used".
	#[must_use]
	#[cfg_attr(
		not(target_os = "linux"),
		expect(
			clippy::missing_const_for_fn,
			reason = "the linux arm calls a non-const backend method; the shared signature cannot be"
		)
	)]
	pub fn throttled_periods(&self) -> Option<u64> {
		match &self.backend {
			#[cfg(target_os = "linux")]
			Backend::Linux(budget) => budget.throttled_periods(),
			#[cfg(target_os = "windows")]
			Backend::Windows(_) => None,
			Backend::Tracked(_) => None,
		}
	}

	/// The group's current member pids, for kill and teardown.
	#[must_use]
	pub fn members(&self) -> Vec<i32> {
		match &self.backend {
			#[cfg(target_os = "linux")]
			Backend::Linux(budget) => budget.members(),
			#[cfg(target_os = "windows")]
			Backend::Windows(budget) => budget.members(),
			Backend::Tracked(budget) => budget.members(),
		}
	}

	/// Re-express the quota for a changed core count. No-op where the quota
	/// is not ours (a systemd scope) or does not exist (tracked).
	pub fn set_cores(&self, cores: f64) {
		match &self.backend {
			#[cfg(target_os = "linux")]
			Backend::Linux(budget) => budget.set_cores(cores),
			#[cfg(target_os = "windows")]
			Backend::Windows(budget) => budget.set_cores(cores),
			Backend::Tracked(_) => {},
		}
	}

	/// The degraded-mode lever: set the scheduling priority of every member to
	/// `level`, an absolute nice value. Meaningful only where no quota exists;
	/// the watcher restores [`SPAWN_NICE`]. Quota backends ignore it because
	/// the quota is already the lever.
	#[cfg_attr(
		not(unix),
		expect(
			clippy::missing_const_for_fn,
			reason = "the unix body calls a non-const backend method; the shared signature cannot be"
		)
	)]
	pub fn renice(&self, level: i32) {
		if let Backend::Tracked(budget) = &self.backend {
			budget.renice(level);
		}
	}

	/// Release the group. Surviving members are reparented (Linux) or simply
	/// released (Windows handle close, tracked forget): teardown never kills.
	pub fn teardown(&self) {
		match &self.backend {
			#[cfg(target_os = "linux")]
			Backend::Linux(budget) => budget.teardown(),
			#[cfg(target_os = "windows")]
			Backend::Windows(budget) => budget.teardown(),
			Backend::Tracked(budget) => budget.teardown(),
		}
	}
}

// ---------------------------------------------------------------------------
// Registry: how the spawn hooks find the group a run belongs to
// ---------------------------------------------------------------------------

static GROUPS: Mutex<Option<HashMap<String, Arc<BudgetGroup>>>> = Mutex::new(None);

/// Register a live group under its name (overwrites a stale same-name entry).
pub fn register_budget_group(name: &str, group: BudgetGroup) -> Arc<BudgetGroup> {
	let mut guard = GROUPS.lock();
	let group = Arc::new(group);
	guard
		.get_or_insert_with(HashMap::new)
		.insert(name.to_string(), group.clone());
	group
}

/// Look up a live group by name.
pub fn budget_group(name: &str) -> Option<Arc<BudgetGroup>> {
	GROUPS.lock().as_ref()?.get(name).cloned()
}

/// Drop a name from the registry. The caller tears the group down itself.
pub fn unregister_budget_group(name: &str) {
	if let Some(groups) = GROUPS.lock().as_mut() {
		groups.remove(name);
	}
}

/// The spawn-hook entry point: adopt `pid` into the named group when it is
/// live. A missing group (session disposed before the spawn, or no budget)
/// is the common uncapped path and adopts nothing.
pub fn adopt_into_budget(name: &str, pid: i32) {
	if let Some(group) = budget_group(name) {
		group.adopt(pid);
	}
}

// ---------------------------------------------------------------------------
// Spawn priority: what every spawned child starts at
// ---------------------------------------------------------------------------

/// Nice level every external child a run spawns starts at, budget or not.
///
/// Agent work then yields the CPU to the desktop, the terminal and the host
/// whenever they contend, and loses nothing on an idle machine. Same value as
/// `SPAWN_NICE` in `packages/coding-agent/src/session/cpu-limit.ts`, which
/// applies it to the spawns the TypeScript side makes.
pub const SPAWN_NICE: i32 = 10;

/// Start `pid` at [`SPAWN_NICE`].
///
/// Descendants inherit the level, so the direct child is the only process
/// that needs it. A host already at or below that priority leaves the child
/// at the level it inherited. Best-effort: an exited child or a refused
/// change leaves the spawn as is.
#[cfg(unix)]
pub fn lower_spawn_priority(pid: i32) {
	// SAFETY: getpriority on the calling thread only reads. Its -1 is both an
	// error and a real level; either reading is below SPAWN_NICE, so both lead
	// to the same call.
	let own = unsafe { libc::getpriority(libc::PRIO_PROCESS, 0) };
	if own >= SPAWN_NICE {
		return;
	}
	// SAFETY: setpriority with PRIO_PROCESS targets exactly the pid given; a
	// dead pid fails with ESRCH and changes nothing.
	unsafe {
		libc::setpriority(libc::PRIO_PROCESS, pid as u32, SPAWN_NICE);
	}
}

/// Start `pid` at `BELOW_NORMAL_PRIORITY_CLASS`, the class for [`SPAWN_NICE`].
///
/// Children of a below-normal process inherit the class.
#[cfg(windows)]
pub fn lower_spawn_priority(pid: i32) {
	use windows_sys::Win32::{
		Foundation::CloseHandle,
		System::Threading::{
			BELOW_NORMAL_PRIORITY_CLASS, GetCurrentProcess, GetPriorityClass, IDLE_PRIORITY_CLASS,
			OpenProcess, PROCESS_SET_INFORMATION, SetPriorityClass,
		},
	};
	// SAFETY: GetCurrentProcess returns a pseudo-handle that needs no close.
	let own = unsafe { GetPriorityClass(GetCurrentProcess()) };
	if own == BELOW_NORMAL_PRIORITY_CLASS || own == IDLE_PRIORITY_CLASS {
		return;
	}
	// SAFETY: OpenProcess either returns a handle this scope owns and closes,
	// or null for an already-exited child.
	let process = unsafe { OpenProcess(PROCESS_SET_INFORMATION, 0, pid as u32) };
	if process.is_null() {
		return;
	}
	// SAFETY: `process` is a live handle owned by this scope.
	unsafe {
		SetPriorityClass(process, BELOW_NORMAL_PRIORITY_CLASS);
		CloseHandle(process);
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn tracked_group_bookkeeps_members_and_reports_no_throttle() {
		let group = BudgetGroup::create(&BudgetBackendSpec::Tracked, "test", 2.0).expect("tracked");
		assert!(!group.throttles());
		group.adopt(4242);
		group.adopt(4343);
		let mut members = group.members();
		members.sort_unstable();
		assert_eq!(members, vec![4242, 4343]);
		group.teardown();
		assert!(group.members().is_empty());
	}

	#[test]
	fn registry_round_trip_and_missing_name() {
		let group = register_budget_group(
			"veyyon-cpu-registry-test",
			BudgetGroup::create(&BudgetBackendSpec::Tracked, "registry-test", 1.0).expect("tracked"),
		);
		adopt_into_budget("veyyon-cpu-registry-test", 777);
		assert_eq!(group.members(), vec![777]);
		adopt_into_budget("veyyon-cpu-registry-missing", 888); // no panic, no-op
		unregister_budget_group("veyyon-cpu-registry-test");
		assert!(budget_group("veyyon-cpu-registry-test").is_none());
	}
}
