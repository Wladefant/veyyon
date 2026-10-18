//! WHY: the scan cache served a scan for one TTL and then kept it. An expired
//! entry left the map only when a request for the same root and options
//! replaced it, or when sixteen newer scans pushed it out, so a process that
//! scanned a tree once held every path of that tree for the rest of its life.
//! One `@` completion over a 510 000-entry tree held 79 MiB after its TTL, and
//! a session open in a 6.5 million-entry tree held about a gigabyte.
//!
//! The class closed is any expired scan that outlives both release points: the
//! cold path of each cached walk, which drops every expired scan before it
//! allocates a new one, and `release_expired_scans`, which the addon's idle
//! heap release calls. Both cold paths are enumerated in [`COLD_PATHS`], and
//! the bytes are read from a counting allocator, because the map's length
//! cannot show a scan whose entries leaked elsewhere.
//!
//! What it does not catch: memory the C allocator keeps after the scan is
//! freed (the addon's `malloc_trim` owns that, and its own test reads page
//! residency), and a fresh scan dropped early by a release that runs inside the
//! TTL on a clock that jumps, which `Instant` rules out.

use std::{
	alloc::{GlobalAlloc, Layout, System},
	fs,
	path::Path,
	sync::{
		LazyLock, Mutex, MutexGuard, PoisonError,
		atomic::{AtomicI64, Ordering},
	},
	thread,
	time::Duration,
};

use veyyon_test_scratch::{TempTree, scratch_dir};
use veyyon_walker::{
	CollectedEntry, CompiledWalkGlob, EmptyRecheck, WalkDetail, WalkFilter, WalkOptions,
	WalkRequest, cache_ttl_ms, collect_entries_without_heartbeat, invalidate_all,
	release_expired_scans,
};

/// Bytes allocated and not yet freed in this test binary.
static LIVE: AtomicI64 = AtomicI64::new(0);
/// The highest [`LIVE`] has been since [`reset_peak`].
static PEAK: AtomicI64 = AtomicI64::new(0);

fn grow(bytes: i64) {
	let live = LIVE.fetch_add(bytes, Ordering::Relaxed) + bytes;
	PEAK.fetch_max(live, Ordering::Relaxed);
}

/// The system allocator with live-byte and peak counters in front of it.
struct Counting;

// SAFETY: every method forwards to the system allocator with the pointer and
// layout it was given, and the counters are atomics that allocate nothing
// themselves.
unsafe impl GlobalAlloc for Counting {
	unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
		grow(layout.size() as i64);
		// SAFETY: the layout is the caller's, forwarded unchanged.
		unsafe { System.alloc(layout) }
	}

	unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
		LIVE.fetch_sub(layout.size() as i64, Ordering::Relaxed);
		// SAFETY: pointer and layout are the pair this allocator handed out.
		unsafe { System.dealloc(pointer, layout) };
	}

	unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
		grow(new_size as i64 - layout.size() as i64);
		// SAFETY: pointer and layout are the pair this allocator handed out, and
		// `new_size` is the caller's.
		unsafe { System.realloc(pointer, layout, new_size) }
	}
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

/// A TTL short enough that a test can outlive it.
///
/// The walker reads this once per process through a `LazyLock`, so it has to be
/// set before the first cache access anywhere in this binary. Every test forces
/// this static first, which is what orders the write ahead of that read.
static SHORT_TTL: LazyLock<()> = LazyLock::new(|| {
	// SAFETY: this body runs once, inside `LazyLock`, before any test in this
	// binary has reached the cache, so no other thread is reading the environment
	// while it writes.
	unsafe { std::env::set_var("FS_SCAN_CACHE_TTL_MS", "400") };
});

/// One test at a time in this binary: the live-byte counter and the scan cache
/// are both process-wide.
static SERIAL: Mutex<()> = Mutex::new(());

fn ready() -> MutexGuard<'static, ()> {
	LazyLock::force(&SHORT_TTL);
	let guard = SERIAL.lock().unwrap_or_else(PoisonError::into_inner);
	invalidate_all();
	guard
}

fn live() -> i64 {
	LIVE.load(Ordering::Relaxed)
}

fn reset_peak() {
	PEAK.store(live(), Ordering::Relaxed);
}

fn peak() -> i64 {
	PEAK.load(Ordering::Relaxed)
}

fn outlive_the_ttl() {
	thread::sleep(Duration::from_millis(cache_ttl_ms() + 100));
}

/// A tree of `files` files under `src/`, spread a hundred per directory.
fn tree(name: &str, files: usize) -> TempTree {
	let tree = scratch_dir(&format!("walker-expired-scan-{name}"));
	for index in 0..files {
		let path = tree
			.path()
			.join("src")
			.join(format!("d{:03}", index / 100))
			.join(format!("f{index:05}.txt"));
		fs::create_dir_all(path.parent().expect("a file under src has a parent"))
			.expect("parent directory should be created");
		fs::write(path, b"x").expect("file should be written");
	}
	tree
}

fn options(cache: bool) -> WalkOptions {
	WalkOptions { detail: WalkDetail::Full, cache, ..WalkOptions::default() }
}

/// One cached walk over `root`, its result dropped, so the cache holds the only
/// copy of the scan.
type ColdPath = fn(&Path);

/// The plain owned walk: `collect_entries` with the cache on.
fn owned_walk(root: &Path) {
	drop(collect_entries_without_heartbeat(root, options(true)).expect("owned walk should succeed"));
}

/// The filtered walk every `WalkRequest` without overrides takes, the one `@`
/// completion and structural search use. The filter keeps nothing, so the
/// caller holds no entry.
fn filtered_walk(root: &Path) {
	let outcome =
		WalkRequest::from_options(root, options(true))
			.filter(WalkFilter::files_only().glob(
				CompiledWalkGlob::new(["no-file-is-named-this"]).expect("test glob should compile"),
			))
			.empty_recheck(EmptyRecheck::Never)
			.collect()
			.expect("filtered walk should succeed");
	assert!(outcome.entries.is_empty(), "the filter keeps nothing");
}

const COLD_PATHS: [(&str, ColdPath); 2] = [("owned", owned_walk), ("filtered", filtered_walk)];

/// Bytes the cache holds for one scan of `root` taken through `walk`, measured
/// from an empty cache with the walker's threads already started.
fn cached_bytes(root: &Path, walk: ColdPath) -> i64 {
	invalidate_all();
	let before = live();
	walk(root);
	let held = live() - before;
	let floor = 2_000 * std::mem::size_of::<CollectedEntry>() as i64;
	assert!(
		held > floor,
		"a cached scan of a 2,000-file tree must hold more than {floor} bytes, held {held}; the \
		 walk did not reach the cache"
	);
	held
}

fn warm_up(root: &Path) {
	drop(collect_entries_without_heartbeat(root, options(false)).expect("warm-up walk"));
}

#[test]
fn a_scan_inside_its_ttl_survives_the_release() {
	let _serial = ready();
	let big = tree("fresh", 2_000);
	warm_up(big.path());
	for (name, walk) in COLD_PATHS {
		let held = cached_bytes(big.path(), walk);
		let before = live();
		assert_eq!(release_expired_scans(), 0, "{name}: a scan inside its TTL is not expired");
		let freed = before - live();
		assert!(
			freed < held / 10,
			"{name}: the release freed {freed} of a fresh scan's {held} bytes"
		);
	}
}

#[test]
fn the_heap_release_drops_an_expired_scan() {
	let _serial = ready();
	let big = tree("release", 2_000);
	warm_up(big.path());
	for (name, walk) in COLD_PATHS {
		let held = cached_bytes(big.path(), walk);
		outlive_the_ttl();
		let before = live();
		assert_eq!(release_expired_scans(), 1, "{name}: the one cached scan has expired");
		let freed = before - live();
		assert!(
			freed > held * 9 / 10,
			"{name}: releasing an expired scan freed {freed} of the {held} bytes it held"
		);
	}
}

#[test]
fn a_cold_walk_drops_every_expired_scan_before_it_scans() {
	let _serial = ready();
	let big = tree("insert-big", 2_000);
	let small = tree("insert-small", 1);
	warm_up(big.path());
	warm_up(small.path());
	for (name, walk) in COLD_PATHS {
		// The control: how far a walk of `small` peaks above an empty cache.
		invalidate_all();
		let before = live();
		reset_peak();
		walk(small.path());
		let control = peak() - before;

		let held = cached_bytes(big.path(), walk);
		// Live bytes with the cache empty: the scan of `big` is the only thing the
		// walk above left behind.
		let empty_cache = live() - held;
		outlive_the_ttl();
		// A different root is a different key: the expired scan of `big` is
		// neither replaced nor, with one entry in the cache, evicted.
		reset_peak();
		walk(small.path());
		let retained = live() - empty_cache;
		assert!(
			retained < held / 10,
			"{name}: after a walk of another root, {retained} bytes stayed live of the expired \
			 {held}-byte scan"
		);
		// Released before the scan, the expired scan and the walk's working set
		// are never live together, so the peak is the larger of the two plus the
		// cache key the walk builds before it releases. A release after the scan
		// stacks one on the other.
		let high_water = peak() - empty_cache;
		let bound = held.max(control) + held.min(control) / 2;
		assert!(
			high_water < bound,
			"{name}: a walk of another root peaked {high_water} bytes above an empty cache, so its \
			 {control}-byte working set was allocated while the expired {held}-byte scan was still \
			 cached"
		);
	}
}
