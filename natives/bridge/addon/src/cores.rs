//! Cores the process may run on.
//!
//! `available_parallelism` counts hardware threads, and the hardware threads
//! of one core share its execution units: two CPU-bound threads on one core
//! run no faster than one. A tree search over 282 000 PHP files on a 16-core,
//! 32-thread machine took 0.8 s with 28 parse threads and with 12, and 12.2 s
//! of CPU against 9.5 s.

use std::{collections::HashSet, sync::LazyLock};

/// Cores of the CPUs the process may run on, at most its available
/// parallelism, which also counts a CPU quota. Where the topology cannot be
/// read, the available parallelism.
pub fn cores() -> usize {
	static CORES: LazyLock<usize> = LazyLock::new(|| {
		let parallelism = std::thread::available_parallelism().map_or(1, usize::from);
		allowed_cores().map_or(parallelism, |cores| cores.min(parallelism))
	});
	*CORES
}

#[cfg(target_os = "linux")]
fn allowed_cores() -> Option<usize> {
	let status = std::fs::read_to_string("/proc/self/status").ok()?;
	let allowed = status
		.lines()
		.find_map(|line| line.strip_prefix("Cpus_allowed_list:"))?;
	count_cores(&parse_cpu_list(allowed.trim())?, |cpu, name| {
		std::fs::read_to_string(format!("/sys/devices/system/cpu/cpu{cpu}/topology/{name}"))
			.ok()
			.map(|value| value.trim().to_owned())
	})
}

#[cfg(not(target_os = "linux"))]
const fn allowed_cores() -> Option<usize> {
	None
}

/// The CPUs of a kernel CPU list such as `0-3,8,10-11`, or `None` when it is
/// malformed.
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
fn parse_cpu_list(list: &str) -> Option<Vec<usize>> {
	let mut cpus = Vec::new();
	for range in list.split(',') {
		let (first, last) = range.split_once('-').unwrap_or((range, range));
		let (first, last): (usize, usize) = (first.parse().ok()?, last.parse().ok()?);
		if first > last {
			return None;
		}
		cpus.extend(first..=last);
	}
	Some(cpus)
}

/// Distinct cores of `cpus`, a core being a `core_id` within a
/// `physical_package_id` that `topology` reads for a CPU, or `None` when
/// `cpus` is empty or a CPU's topology cannot be read.
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
fn count_cores(cpus: &[usize], topology: impl Fn(usize, &str) -> Option<String>) -> Option<usize> {
	let mut cores = HashSet::new();
	for &cpu in cpus {
		cores.insert((topology(cpu, "physical_package_id")?, topology(cpu, "core_id")?));
	}
	(!cores.is_empty()).then_some(cores.len())
}

#[cfg(test)]
mod tests {
	use super::{count_cores, parse_cpu_list};

	#[test]
	fn a_cpu_list_names_every_cpu_of_its_ranges() {
		assert_eq!(parse_cpu_list("0-3,8,10-11"), Some(vec![0, 1, 2, 3, 8, 10, 11]));
		assert_eq!(parse_cpu_list("5"), Some(vec![5]));
		for malformed in ["", "3-1", "0-", "a", "0,,1", "0-3 "] {
			assert_eq!(parse_cpu_list(malformed), None, "{malformed:?}");
		}
	}

	/// A core's hardware threads count once, the same core id in two packages
	/// counts twice, and a CPU whose topology cannot be read leaves the count
	/// to the caller's fallback.
	#[test]
	fn hardware_threads_of_one_core_count_once() {
		// Two packages of two cores, two hardware threads each: CPU `n` and
		// `n + 8` share a core, as Linux numbers SMT siblings.
		let topology = |cpu: usize, name: &str| -> Option<String> {
			let cpu = cpu % 8;
			Some(match name {
				"physical_package_id" => (cpu / 4).to_string(),
				"core_id" => (cpu % 4).to_string(),
				_ => return None,
			})
		};
		let all: Vec<usize> = (0..16).collect();
		assert_eq!(count_cores(&all, topology), Some(8));
		assert_eq!(count_cores(&[0, 8], topology), Some(1));
		assert_eq!(count_cores(&[0, 4], topology), Some(2), "one core id in two packages");
		assert_eq!(count_cores(&[], topology), None);
		let missing = |cpu: usize, name: &str| (cpu != 3).then(|| topology(cpu, name)).flatten();
		assert_eq!(count_cores(&all, missing), None);
	}
}
