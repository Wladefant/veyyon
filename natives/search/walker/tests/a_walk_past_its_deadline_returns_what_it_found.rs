//! WHY: a collection bounded by time discarded everything it had found when the
//! time ran out. The native glob ran the walk on a heartbeat that failed at the
//! deadline, the walk returned `WalkError::Interrupted`, and the `search` tool
//! reported "no files found" for a pattern whose matches it had already listed.
//! On a 14-million-entry tree most file searches ended that way.
//!
//! The class closed is any deadline-bounded collection that fails, returns
//! nothing, or returns the whole tree when its deadline passes mid-walk; that
//! hides the deadline from the caller; that reads a deadline as a cancellation
//! or a cancellation as a deadline; that keeps walking long after the deadline;
//! or that leaves a cut scan where a later cached walk would serve it. Every
//! walk a deadline reaches is swept through [`LANES`] (the parallel collector,
//! the serial collector, and a request with the scan cache on) crossed with
//! [`METHODS`] (the plain and the ranked collection).
//!
//! What it does not catch: an overrun of the deadline shorter than [`BOUND`],
//! which is the time a thread takes to visit the 128 entries between two
//! heartbeats; and a deadline-bounded entry point added to the crate without a
//! row in [`METHODS`].

use std::{
	fs,
	path::Path,
	sync::{
		LazyLock, Mutex, MutexGuard, PoisonError,
		atomic::{AtomicUsize, Ordering},
	},
	thread,
	time::{Duration, Instant},
};

use veyyon_test_scratch::{TempTree, scratch_dir};
use veyyon_walker::{WalkError, WalkOutcome, WalkRank, WalkRequest, invalidate_all, walk_workers};

/// Four walker threads, whatever the host says, so the parallel lane is the
/// parallel collector. The count is read once per process, so it is set before
/// the first walk in this binary.
static WORKERS: LazyLock<()> = LazyLock::new(|| {
	// SAFETY: this body runs once, inside `LazyLock`, before any walk in this
	// binary has read the environment.
	unsafe { std::env::set_var("VEYYON_WALK_WORKERS", "4") };
});

/// One test at a time: a heartbeat that sleeps holds a thread of the shared
/// walker pool, and a second test's walk would wait for it.
static SERIAL: Mutex<()> = Mutex::new(());

/// How long a walk may run past its deadline.
const BOUND: Duration = Duration::from_secs(2);

/// Heartbeats a walk cut mid-walk answers at once before the rest sleep past
/// the deadline. The walk visits 128 entries per heartbeat on each thread.
const PROMPT_BEATS: usize = 4;

/// 32 directories of 128 files: more entries than four threads visit in
/// [`PROMPT_BEATS`] + 1 heartbeats each, so a cut walk cannot finish.
const DIRS: usize = 32;
const FILES: usize = 128;

fn ready() -> MutexGuard<'static, ()> {
	LazyLock::force(&WORKERS);
	assert_eq!(walk_workers(), 4, "the parallel lane needs the parallel collector to apply");
	SERIAL.lock().unwrap_or_else(PoisonError::into_inner)
}

fn tree(name: &str) -> TempTree {
	let tree = scratch_dir(&format!("walker-deadline-{name}"));
	for dir in 0..DIRS {
		let dir = tree.path().join(format!("d{dir:02}"));
		fs::create_dir(&dir).expect("directory should be created");
		for file in 0..FILES {
			fs::write(dir.join(format!("f{file:03}.txt")), b"x").expect("file should be written");
		}
	}
	tree
}

/// A request over `root` that a deadline reaches through one collector.
type Lane = fn(&Path) -> WalkRequest;

fn parallel(root: &Path) -> WalkRequest {
	WalkRequest::new(root)
}

/// The parallel collector checks no device, so this keeps the walk serial.
fn serial(root: &Path) -> WalkRequest {
	WalkRequest::new(root).same_file_system(true)
}

fn cached(root: &Path) -> WalkRequest {
	WalkRequest::new(root).cache(true)
}

const LANES: [(&str, Lane); 3] = [("parallel", parallel), ("serial", serial), ("cached", cached)];

type Heartbeat<'a> = &'a (dyn Fn() -> Result<(), String> + Sync);

/// One deadline-bounded collection.
type Method =
	fn(&WalkRequest, Option<Instant>, Heartbeat<'_>) -> Result<WalkOutcome, WalkError<String>>;

fn plain(
	request: &WalkRequest,
	deadline: Option<Instant>,
	heartbeat: Heartbeat<'_>,
) -> Result<WalkOutcome, WalkError<String>> {
	request.collect_with_deadline(deadline, heartbeat)
}

fn ranked(
	request: &WalkRequest,
	deadline: Option<Instant>,
	heartbeat: Heartbeat<'_>,
) -> Result<WalkOutcome, WalkError<String>> {
	request.collect_ranked_with_deadline(WalkRank::PathAsc, usize::MAX, deadline, heartbeat)
}

const METHODS: [(&str, Method); 2] = [("collect", plain), ("ranked", ranked)];

fn paths(outcome: &WalkOutcome) -> Vec<String> {
	outcome
		.entries
		.iter()
		.map(|entry| entry.path.clone())
		.collect()
}

/// Every entry of `root`, from a walk with no deadline.
fn whole(root: &Path) -> Vec<String> {
	let outcome = WalkRequest::new(root)
		.collect()
		.expect("an unbounded walk should succeed");
	assert!(!outcome.deadline_reached, "a walk with no deadline reached one");
	assert_eq!(outcome.entries.len(), DIRS * (FILES + 1), "the tree is not what the test built");
	paths(&outcome)
}

/// A heartbeat that never interrupts.
const STEADY: Heartbeat<'static> = &|| Ok(());

#[test]
fn a_passed_deadline_returns_no_entries_and_reports_it() {
	let _serial = ready();
	let tree = tree("passed");
	for (lane, request) in LANES {
		for (method, collect) in METHODS {
			let outcome =
				collect(&request(tree.path()), Some(Instant::now()), STEADY).unwrap_or_else(|err| {
					panic!("{lane}/{method}: a passed deadline failed the walk: {err}")
				});
			assert!(outcome.deadline_reached, "{lane}/{method}: the deadline went unreported");
			assert_eq!(
				paths(&outcome),
				Vec::<String>::new(),
				"{lane}/{method}: walked past the deadline"
			);
		}
	}
}

#[test]
fn a_deadline_the_walk_beats_returns_the_whole_tree() {
	let _serial = ready();
	let tree = tree("beaten");
	let whole = whole(tree.path());
	for (lane, request) in LANES {
		for (method, collect) in METHODS {
			for deadline in [None, Some(Instant::now() + Duration::from_mins(1))] {
				let outcome = collect(&request(tree.path()), deadline, STEADY)
					.unwrap_or_else(|err| panic!("{lane}/{method}/{deadline:?}: {err}"));
				assert!(
					!outcome.deadline_reached,
					"{lane}/{method}/{deadline:?}: reported a deadline it beat"
				);
				assert_eq!(paths(&outcome), whole, "{lane}/{method}/{deadline:?}: lost entries");
			}
		}
	}
}

/// Answers [`PROMPT_BEATS`] heartbeats at once, then sleeps past `deadline` in
/// every later one and succeeds, so only the clock can stop the walk.
fn cut_at(deadline: Instant) -> impl Fn() -> Result<(), String> + Sync {
	let beats = AtomicUsize::new(0);
	move || {
		if beats.fetch_add(1, Ordering::Relaxed) >= PROMPT_BEATS {
			thread::sleep(
				deadline.saturating_duration_since(Instant::now()) + Duration::from_millis(1),
			);
		}
		Ok(())
	}
}

#[test]
fn a_deadline_reached_mid_walk_returns_what_the_walk_found() {
	let _serial = ready();
	let tree = tree("mid-walk");
	let whole = whole(tree.path());
	for (lane, request) in LANES {
		for (method, collect) in METHODS {
			let deadline = Instant::now() + Duration::from_millis(300);
			let outcome = collect(&request(tree.path()), Some(deadline), &cut_at(deadline))
				.unwrap_or_else(|err| {
					panic!("{lane}/{method}: a reached deadline failed the walk: {err}")
				});
			let overrun = Instant::now().saturating_duration_since(deadline);
			assert!(overrun < BOUND, "{lane}/{method}: walked {overrun:?} past the deadline");
			assert!(outcome.deadline_reached, "{lane}/{method}: the deadline went unreported");
			let found = paths(&outcome);
			assert!(!found.is_empty(), "{lane}/{method}: discarded what it found before the deadline");
			assert!(
				found.len() < whole.len(),
				"{lane}/{method}: a walk held past its deadline still listed the whole tree"
			);
			assert!(found.is_sorted(), "{lane}/{method}: a cut walk is not sorted by path");
			let strays: Vec<&String> = found
				.iter()
				.filter(|path| whole.binary_search(path).is_err())
				.collect();
			assert_eq!(
				strays,
				Vec::<&String>::new(),
				"{lane}/{method}: listed entries the tree lacks"
			);
		}
	}
}

#[test]
fn a_cancellation_on_the_deadline_beat_fails_the_walk() {
	let _serial = ready();
	let tree = tree("cancelled");
	let cancelled = || Err::<(), _>("cancelled".to_owned());
	for (lane, request) in LANES {
		for (method, collect) in METHODS {
			match collect(&request(tree.path()), Some(Instant::now()), &cancelled) {
				Err(WalkError::Interrupted(message)) => {
					assert_eq!(message, "cancelled", "{lane}/{method}: the cancellation was replaced");
				},
				Err(other) => panic!("{lane}/{method}: a cancellation failed as {other}"),
				Ok(outcome) => panic!(
					"{lane}/{method}: a cancellation returned {} entries as a partial result",
					outcome.entries.len()
				),
			}
		}
	}
}

#[test]
fn a_walk_cut_short_is_never_served_from_the_cache() {
	let _serial = ready();
	let tree = tree("cache");
	let whole = whole(tree.path());
	for (method, collect) in METHODS {
		invalidate_all();
		let deadline = Instant::now() + Duration::from_millis(300);
		let cut = collect(&cached(tree.path()), Some(deadline), &cut_at(deadline))
			.unwrap_or_else(|err| panic!("{method}: a reached deadline failed the walk: {err}"));
		assert!(cut.deadline_reached, "{method}: the walk was not cut, so this proves nothing");
		let next = cached(tree.path())
			.collect()
			.expect("a cached walk should succeed");
		assert_eq!(paths(&next), whole, "{method}: a cached walk served the cut scan");
	}
}
