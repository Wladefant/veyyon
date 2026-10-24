//! Free pages of the C allocator's heaps.
//!
//! Native work runs on the addon's worker threads: Rayon's global pool, the
//! walker pool, Tokio's workers and blocking pool, and the runtime's own work
//! pool. glibc gives each thread that calls `malloc` an arena of its own, up to
//! eight per core, and keeps the pages of every chunk freed in an arena mapped
//! until the top of that arena's heap is free. A search over a large tree
//! leaves most of its peak resident in the arenas of the threads that ran it:
//! four searches over a 200 000-match tree left 266 MiB resident in 36 thread
//! arenas after every result was dropped. `Bun.shrink()` releases the engine's
//! heaps and leaves the C allocator's untouched.
//!
//! [`release_free_heap_pages`] first drops the walker's expired cached scans,
//! which the cache otherwise keeps until a later scan replaces them, then calls
//! `malloc_trim(0)`, which walks every arena and returns each whole free page
//! to the kernel with `MADV_DONTNEED`. Live allocations stay where they are; a
//! later allocation faults fresh zeroed pages back in. The same four searches
//! drop to 54 MiB, in 11 ms.
//!
//! The walk runs on libuv's thread pool. Its cost grows with the free chunks in
//! every arena: in a 6 GiB session it held the event loop 250 to 1127 ms per
//! call. `malloc_trim` locks one arena at a time, so a thread allocating from
//! the arena being walked waits for that arena only.
//!
//! [`cap_arenas`] caps the arena count at [`ARENA_MAX`] when the addon loads.
//! Every arena keeps its own free chunks, so a burst of concurrent tool calls
//! leaves its peak spread over as many arenas as there were threads: 48 shell
//! commands, 32 searches and 16 globs at once grew 242 arenas, 491 MiB RSS at
//! the peak and 340 MiB after the release. With eight arenas the same burst
//! peaks at 306 MiB, settles at 188 MiB and runs in the same wall time.
//!
//! [`pin_mmap_threshold`] fixes glibc's mmap threshold at [`MMAP_THRESHOLD`]
//! when the addon loads. glibc raises the threshold to the size of each mapped
//! block a thread frees, up to 32 MiB, so after the first large free every
//! later block of that size comes from an arena heap and stays resident once
//! freed. Skimming a 148 MB session allocates two 4 MiB read blocks and up to
//! 16 MiB of output per call: resuming it peaked at 298 MiB anonymous memory
//! and held 248 MiB a second later, and with the threshold fixed it peaks at
//! 274 MiB and holds 219 MiB, with the same load time and search throughput.
//! A block of [`MMAP_THRESHOLD`] or more is mapped on its own and unmapped
//! when freed.
//!
//! [`route_tree_sitter_allocations`] sends tree-sitter's allocations to
//! mimalloc when the addon loads. A tree search parses on a thread per core,
//! and under the arena cap those threads wait on each other's arena locks: 16
//! parse threads searching 282 000 PHP files switched context 1 045 000 times.
//! mimalloc gives each thread a heap of its own and keeps a freed page mapped
//! for a second, for the next parse to reuse. [`release_tree_sitter_pages`]
//! returns every freed page at once: a tree search calls it when it ends, and
//! the release calls it too.
//!
//! The arena cap, the threshold, mimalloc and the trim are glibc Linux only.
//! Elsewhere the release drops expired scans and resolves true only when it
//! dropped one: musl returns free pages to the kernel when a chunk is freed,
//! the macOS allocator releases emptied regions on its own, and Windows heaps
//! decommit free pages past a threshold.

use napi_derive::napi;

use crate::task;

/// Arenas glibc may create for the whole process, the main arena included.
/// glibc's default is eight per core.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
const ARENA_MAX: libc::c_int = 8;

/// Caps glibc's arena count at [`ARENA_MAX`].
///
/// Runs from the addon's module initializer, before its threads exist. glibc
/// fixes its limit once the process holds more than eight arenas, so the cap
/// applies to every arena created after the load. An explicit
/// `MALLOC_ARENA_MAX` or `glibc.malloc.arena_max` limit stays in force: glibc
/// fixes that one when the runtime's own threads take their first arenas,
/// before any addon loads.
pub fn cap_arenas() {
	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	// SAFETY: `mallopt` takes no pointers and sets a field of glibc's
	// allocator parameters under the main arena's lock.
	unsafe {
		libc::mallopt(libc::M_ARENA_MAX, ARENA_MAX);
	}
}

/// Size from which glibc maps a block on its own and unmaps it when freed.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
const MMAP_THRESHOLD: libc::c_int = 1 << 20;

/// Fixes glibc's mmap threshold at [`MMAP_THRESHOLD`].
///
/// Runs from the addon's module initializer. Setting the threshold turns off
/// glibc's dynamic adjustment of it and of the trim threshold for the rest of
/// the process. An explicit `MALLOC_MMAP_THRESHOLD_` or
/// `glibc.malloc.mmap_threshold` setting stays in force.
pub fn pin_mmap_threshold() {
	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	{
		let explicit = std::env::var_os("MALLOC_MMAP_THRESHOLD_").is_some()
			|| std::env::var("GLIBC_TUNABLES")
				.is_ok_and(|tunables| tunables.contains("glibc.malloc.mmap_threshold="));
		if explicit {
			return;
		}
		// SAFETY: `mallopt` takes no pointers and sets a field of glibc's
		// allocator parameters under the main arena's lock.
		unsafe {
			libc::mallopt(libc::M_MMAP_THRESHOLD, MMAP_THRESHOLD);
		}
	}
}

/// Routes tree-sitter's allocations to mimalloc.
///
/// Runs from the addon's module initializer, before any tree-sitter object
/// exists, so every tree-sitter allocation is freed by the allocator that made
/// it.
pub fn route_tree_sitter_allocations() {
	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	// SAFETY: no tree-sitter object exists yet: the initializer runs before any
	// export can parse, so no block glibc allocated reaches `mi_free`.
	unsafe {
		tree_sitter::set_allocator(
			Some(libmimalloc_sys::mi_malloc),
			Some(libmimalloc_sys::mi_calloc),
			Some(libmimalloc_sys::mi_realloc),
			Some(libmimalloc_sys::mi_free),
		);
	}
}

/// Returns the pages tree-sitter freed to the kernel.
///
/// mimalloc keeps a freed page mapped for a second in case the next parse
/// reuses it, and drops it only when a thread that allocates checks again, so
/// the trees of a finished search stay resident while no thread parses.
/// `mi_collect` drops every freed page of the process at once, but returns at
/// once on a thread mimalloc has not set up, which a thread pool thread that
/// never parsed is; `mi_thread_init` sets the calling thread up first.
pub fn release_tree_sitter_pages() {
	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	// SAFETY: `mi_thread_init` and `mi_collect` take no pointers and lock what
	// they walk, so both are sound to call from any thread at any time.
	unsafe {
		libmimalloc_sys::mi_thread_init();
		libmimalloc_sys::mi_collect(true);
	}
}

/// Drops expired cached scans and returns free heap pages to the kernel.
///
/// Runs on libuv's thread pool: drops the walker's expired cached scans, then
/// returns the free pages of every C allocator arena. Resolves true when any
/// memory was released, and false when none was or the platform allocator has
/// no such call.
#[napi]
pub fn release_free_heap_pages() -> task::Promise<bool> {
	task::blocking("release_free_heap_pages", (), |_| Ok(release_heap()))
}

fn release_heap() -> bool {
	let released_scans = veyyon_walker::release_expired_scans();
	trim_arenas() || released_scans > 0
}

fn trim_arenas() -> bool {
	release_tree_sitter_pages();
	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	{
		// SAFETY: `malloc_trim` takes no pointers and locks each arena it
		// walks, so it is sound to call from any thread at any time.
		unsafe { libc::malloc_trim(0) != 0 }
	}
	#[cfg(not(all(target_os = "linux", target_env = "gnu")))]
	{
		false
	}
}

/// What a test that measures or changes process-wide state needs.
#[cfg(all(test, target_os = "linux", target_env = "gnu"))]
pub mod measure {
	/// Runs the test `name` of `module` alone in a child process with `env` set.
	///
	/// Returns true in the child, so the test is the only one in its process,
	/// whose allocations and limits it measures or changes, and false in the
	/// parent after checking that the child passed.
	pub fn in_child(module: &str, name: &str, env: &[(&str, &str)]) -> bool {
		const CHILD: &str = "VEYYON_HEAP_PAGES_TEST_CHILD";
		if std::env::var_os(CHILD).is_some() {
			return true;
		}
		let module = module.split_once("::").map_or(module, |(_, rest)| rest);
		let name = format!("{module}::{name}");
		let output = std::process::Command::new(std::env::current_exe().unwrap())
			.args([name.as_str(), "--exact", "--test-threads=1"])
			.env(CHILD, "1")
			.envs(env.iter().copied())
			.output()
			.unwrap();
		let stdout = String::from_utf8_lossy(&output.stdout);
		assert!(
			output.status.success() && stdout.contains("test result: ok. 1 passed"),
			"{stdout}{}",
			String::from_utf8_lossy(&output.stderr)
		);
		false
	}

	/// The process's resident anonymous memory now and its peak resident
	/// memory so far, in bytes.
	pub fn anon_resident() -> (usize, usize) {
		let status = std::fs::read_to_string("/proc/self/status").unwrap();
		let field = |name: &str| {
			let line = status
				.lines()
				.find_map(|line| line.strip_prefix(name))
				.unwrap_or_else(|| panic!("/proc/self/status has no {name}"));
			let kib: usize = line.trim().trim_end_matches(" kB").parse().unwrap();
			kib << 10
		};
		(field("RssAnon:"), field("VmHWM:"))
	}
}

/// Freed memory in a worker thread's arena stays resident until the release:
/// blocks below the mmap threshold come from the arena's heap, and a block
/// allocated after them keeps the heap top in use, so glibc trims none of
/// them on free. `mincore` reads the residency of the freed blocks' whole
/// pages directly, so allocation elsewhere in the process does not move it.
#[cfg(all(test, target_os = "linux", target_env = "gnu"))]
mod tests {
	use ast_grep_core::tree_sitter::LanguageExt;
	use veyyon_ast::SupportLang;

	use super::{
		measure::{anon_resident, in_child},
		trim_arenas,
	};

	const BLOCK: usize = 64 * 1024;
	const BLOCKS: usize = 512;

	/// Resident and total whole pages inside each `(start, len)` range. A range
	/// glibc has unmapped holds no resident page.
	fn residency(ranges: &[(usize, usize)]) -> (usize, usize) {
		// SAFETY: `sysconf` reads a constant.
		let page = usize::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) }).unwrap();
		let mut resident = 0;
		let mut total = 0;
		let mut vec = Vec::new();
		for &(start, len) in ranges {
			// The first page of a block holds the free chunk's header, which
			// free() writes; only the pages after it are measured.
			let first = (start + 1).next_multiple_of(page);
			let last = (start + len) / page * page;
			if last <= first {
				continue;
			}
			vec.clear();
			vec.resize((last - first) / page, 0u8);
			// SAFETY: `first..last` is page-aligned; `mincore` reports ENOMEM
			// for a range that is not mapped and writes nothing; `vec` has one
			// byte per page.
			let rc =
				unsafe { libc::mincore(first as *mut libc::c_void, last - first, vec.as_mut_ptr()) };
			total += vec.len();
			if rc != 0 {
				let error = std::io::Error::last_os_error();
				assert_eq!(error.raw_os_error(), Some(libc::ENOMEM), "mincore failed: {error}");
				continue;
			}
			resident += vec.iter().filter(|&&flags| flags & 1 == 1).count();
		}
		(resident, total)
	}

	/// Resident and total pages of a 2 MiB block a worker thread frees after
	/// freeing an 8 MiB one, with a later block keeping the arena's top in use.
	fn freed_block_residency() -> (usize, usize) {
		std::thread::spawn(|| {
			drop(vec![1u8; 8 << 20]);
			let block = vec![1u8; 2 << 20];
			let pin = vec![1u8; BLOCK];
			let range = (block.as_ptr() as usize, block.len());
			drop(block);
			let measured = residency(&[range]);
			drop(pin);
			measured
		})
		.join()
		.unwrap()
	}

	/// glibc raises a dynamic mmap threshold to the size of each mapped block
	/// freed, so a block allocated after a larger one was freed comes from the
	/// arena heap and stays resident. The addon's initializer fixes the
	/// threshold, so a freed block of a mebibyte or more leaves nothing
	/// resident, whatever was freed before it.
	#[test]
	fn a_freed_block_of_a_mebibyte_leaves_no_page_resident() {
		if !in_child(module_path!(), "a_freed_block_of_a_mebibyte_leaves_no_page_resident", &[]) {
			return;
		}
		let (resident, total) = freed_block_residency();
		assert!(total >= 500, "measured {total} pages of a 2 MiB block");
		assert_eq!(resident, 0, "a freed 2 MiB block kept {resident} of {total} pages resident");
	}

	/// A threshold the environment sets stays in force: under a 32 MiB
	/// threshold the 2 MiB block comes from the arena heap and stays resident.
	#[test]
	fn an_explicit_mmap_threshold_stays_in_force() {
		let env = [("MALLOC_MMAP_THRESHOLD_", "33554432")];
		if !in_child(module_path!(), "an_explicit_mmap_threshold_stays_in_force", &env) {
			return;
		}
		let (resident, total) = freed_block_residency();
		assert!(total >= 500, "measured {total} pages of a 2 MiB block");
		assert!(
			resident * 10 >= total * 9,
			"a freed 2 MiB block under a 32 MiB threshold kept {resident} of {total} pages"
		);
	}

	/// The addon's initializer caps the test binary at eight arenas too, so
	/// once the harness runs more threads than that, another test shares this
	/// test's arena and its allocations reuse the freed blocks, faulting their
	/// pages back in after the release. The measurement runs in a child process
	/// that holds only this test.
	#[test]
	fn the_release_returns_the_pages_a_worker_thread_freed() {
		if !in_child(module_path!(), "the_release_returns_the_pages_a_worker_thread_freed", &[]) {
			return;
		}
		std::thread::spawn(|| {
			let blocks: Vec<Vec<u8>> = (0..BLOCKS).map(|_| vec![1u8; BLOCK]).collect();
			let pin = vec![1u8; BLOCK];
			let ranges: Vec<(usize, usize)> = blocks
				.iter()
				.map(|b| (b.as_ptr() as usize, b.len()))
				.collect();
			drop(blocks);

			let (before, total) = residency(&ranges);
			assert!(total > BLOCKS * 8, "measured {total} pages of {BLOCKS} freed blocks");
			assert!(
				before * 10 >= total * 9,
				"freed blocks must stay resident before the release: {before} of {total} pages"
			);

			assert!(trim_arenas(), "the release reported nothing released");
			let (after, total) = residency(&ranges);
			assert!(
				after * 10 <= total,
				"freed blocks stayed resident after the release: {after} of {total} pages"
			);
			drop(pin);
		})
		.join()
		.unwrap();
	}

	/// WHY: tree-sitter allocates from mimalloc, which keeps the pages of a
	/// freed tree mapped until a thread that allocates checks again, and whose
	/// `mi_collect` does nothing on a thread it has not set up. The idle
	/// release runs on a thread pool thread that may never have parsed, and
	/// must still return the pages of every tree a finished parse freed. The
	/// child holds freed pages for a minute, so nothing but the release
	/// returns them within the test.
	///
	/// What it does not catch: a tree a search keeps alive, which no release
	/// can return.
	#[test]
	fn the_release_returns_tree_sitter_pages_from_a_thread_that_never_parsed() {
		let name = "the_release_returns_tree_sitter_pages_from_a_thread_that_never_parsed";
		if !in_child(module_path!(), name, &[("MIMALLOC_PURGE_DELAY", "60000")]) {
			return;
		}
		let (before, _) = anon_resident();
		let source = "foo(1);\n".repeat(200_000);
		std::thread::spawn(move || drop(SupportLang::TypeScript.document().ast_grep(source)))
			.join()
			.unwrap();
		let freed = anon_resident().0.saturating_sub(before);
		assert!(freed >= 32 << 20, "a freed tree stays resident until the release: {freed} bytes");
		let released = std::thread::spawn(move || {
			trim_arenas();
			anon_resident().0.saturating_sub(before)
		})
		.join()
		.unwrap();
		assert!(released * 8 <= freed, "the release left {released} of {freed} bytes resident");
	}
}

/// The idle release is the only point that frees the last scan a quiet
/// process took: the walker drops an expired scan on its next cold walk, and a
/// quiet process takes none.
#[cfg(test)]
mod scan_tests {
	use std::{fs, thread, time::Duration};

	use veyyon_test_scratch::scratch_dir;
	use veyyon_walker::{WalkRequest, cache_ttl_ms, release_expired_scans};

	use super::release_heap;

	#[test]
	fn the_release_leaves_no_expired_scan_cached() {
		let tree = scratch_dir("heap-release-expired-scan");
		fs::write(tree.path().join("file.txt"), b"x").unwrap();
		let outcome = WalkRequest::new(tree.path())
			.cache(true)
			.collect()
			.expect("cached walk should succeed");
		assert!(!outcome.entries.is_empty(), "the walk saw the file");
		thread::sleep(Duration::from_millis(cache_ttl_ms() + 100));

		assert!(release_heap(), "dropping an expired scan releases memory");
		assert_eq!(release_expired_scans(), 0, "the release left an expired scan cached");
	}
}
