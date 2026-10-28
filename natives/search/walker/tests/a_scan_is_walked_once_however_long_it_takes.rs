//! WHY: the scan cache stamped a scan with the instant its walk began, ran
//! every concurrent miss as a walk of its own, and let a walk that began before
//! an invalidation insert its scan after it.
//!
//! - A walk longer than the TTL was stored already expired, so on a tree whose
//!   walk takes more than a second the cache never served a hit.
//! - `@` completion asks once per typed character before its first popup opens,
//!   so typing `@abc` in a six-million-entry tree started a full walk per
//!   character, each holding most of a gigabyte.
//! - A scan taken before a file was written was served for a full TTL after the
//!   write invalidated the root.
//!
//! The class closed is any cached request that walks while a walk of the same
//! key is running and still valid, joins a walk an invalidation overtook,
//! caches such a walk, measures the TTL from the start of the walk or never
//! expires it, keeps waiting after its own heartbeat fails, or waits on a walk
//! that failed or panicked instead of walking itself. Every cached lane is
//! swept through [`LANES`], a fixed table of the walker's three cached entry
//! points, and every invalidation through [`INVALIDATIONS`].
//!
//! A held walk stops in its first heartbeat. The walker calls it after it has
//! listed the root and before it visits an entry, so a file written into the
//! root while the walk is held is absent from that walk and present in any walk
//! that starts later. That is how these tests tell a joined walk from a second
//! one.
//!
//! What it does not catch: a waiter woken by its poll instead of by the walk
//! that settled, which delays it by at most the poll interval; a request that
//! misses the cache in the instant between a walk storing its scan and leaving
//! the flight table, which walks again when the leader's second cache lookup is
//! removed and costs one walk; and a cached entry point or an invalidation
//! added to the crate without a row in these tables.

use std::{
	fs,
	path::Path,
	sync::{
		Condvar, LazyLock, Mutex, MutexGuard, PoisonError,
		atomic::{AtomicBool, Ordering},
		mpsc,
	},
	thread,
	time::Duration,
};

use veyyon_test_scratch::{TempTree, scratch_dir};
use veyyon_walker::{
	CollectedEntry, EmptyRecheck, WalkError, WalkOptions, WalkRequest, cache_ttl_ms,
	collect_entries, invalidate_all, invalidate_path, invalidate_path_string,
};

/// A TTL a test can outlast in well under a second.
///
/// The walker reads this once per process through a `LazyLock`, so it is set
/// before the first cache access anywhere in this binary. Every test forces
/// this static first, which orders the write ahead of that read.
static PINNED_TTL: LazyLock<()> = LazyLock::new(|| {
	// SAFETY: this body runs once, inside `LazyLock`, before any test in this
	// binary has reached the cache, so no other thread is reading the environment
	// while it writes.
	unsafe { std::env::set_var("FS_SCAN_CACHE_TTL_MS", "500") };
});

/// One test at a time in this binary: the scan cache and its flights are
/// process-wide.
static SERIAL: Mutex<()> = Mutex::new(());

/// How long a test waits for a walk it expects to finish.
const BOUND: Duration = Duration::from_secs(10);

/// Files under `src/`, so a walk visits more than the root.
const FILES: usize = 200;

fn ready() -> MutexGuard<'static, ()> {
	LazyLock::force(&PINNED_TTL);
	let guard = SERIAL.lock().unwrap_or_else(PoisonError::into_inner);
	invalidate_all();
	guard
}

fn tree(name: &str) -> TempTree {
	let tree = scratch_dir(&format!("walker-single-flight-{name}"));
	let src = tree.path().join("src");
	fs::create_dir_all(&src).expect("src should be created");
	for index in 0..FILES {
		fs::write(src.join(format!("f{index:03}.txt")), b"x").expect("file should be written");
	}
	tree
}

fn write(root: &Path, name: &str) {
	fs::write(root.join(name), b"x").expect("file should be written");
}

fn options() -> WalkOptions {
	WalkOptions { cache: true, ..WalkOptions::default() }
}

type Heartbeat<'a> = &'a (dyn Fn() -> Result<(), String> + Sync);

/// One cached walk over a root, returning the relative paths it lists, sorted.
type Lane = fn(&Path, Heartbeat<'_>) -> Result<Vec<String>, String>;

fn listed<'a>(entries: impl Iterator<Item = &'a CollectedEntry>) -> Vec<String> {
	let mut paths: Vec<String> = entries.map(|entry| entry.path.clone()).collect();
	paths.sort_unstable();
	paths
}

fn describe(err: WalkError<String>) -> String {
	match err {
		WalkError::Interrupted(message) => message,
		other => other.to_string(),
	}
}

/// `collect_entries` with the cache on.
fn owned(root: &Path, heartbeat: Heartbeat<'_>) -> Result<Vec<String>, String> {
	let scan = collect_entries(root, options(), heartbeat).map_err(describe)?;
	Ok(listed(scan.entries.iter()))
}

/// The filtered walk every `WalkRequest` without overrides takes.
fn filtered(root: &Path, heartbeat: Heartbeat<'_>) -> Result<Vec<String>, String> {
	let outcome = WalkRequest::from_options(root, options())
		.empty_recheck(EmptyRecheck::Never)
		.collect_with_heartbeat(heartbeat)
		.map_err(describe)?;
	Ok(listed(outcome.entries.iter()))
}

/// The shared walk `@` completion reads in place.
fn shared(root: &Path, heartbeat: Heartbeat<'_>) -> Result<Vec<String>, String> {
	let walk = WalkRequest::from_options(root, options())
		.empty_recheck(EmptyRecheck::Never)
		.collect_shared_with_heartbeat(heartbeat)
		.map_err(describe)?;
	Ok(listed(walk.iter()))
}

const LANES: [(&str, Lane); 3] = [("owned", owned), ("filtered", filtered), ("shared", shared)];

/// A heartbeat that never interrupts.
static FREE: fn() -> Result<(), String> = || Ok(());

fn invalidate_path_text(root: &Path) {
	invalidate_path_string(root.to_str().expect("scratch paths are UTF-8"));
}

fn invalidate_everything(_: &Path) {
	invalidate_all();
}

/// One way to invalidate the cached scans of a root.
type Invalidation = fn(&Path);

/// Every way to invalidate a cached root.
const INVALIDATIONS: [(&str, Invalidation); 3] = [
	("path", invalidate_path),
	("path_string", invalidate_path_text),
	("all", invalidate_everything),
];

fn lists(paths: &[String], name: &str) -> bool {
	paths.iter().any(|path| path == name)
}

/// What a held walk does once the test lets it go.
#[derive(Clone, Copy, Debug)]
enum Release {
	Finish,
	Fail,
	Panic,
}

#[derive(Default)]
struct GateState {
	held:    bool,
	release: Option<Release>,
}

/// Holds a walk inside its first heartbeat until the test releases it.
#[derive(Default)]
struct Gate {
	state:   Mutex<GateState>,
	changed: Condvar,
}

impl Gate {
	fn lock(&self) -> MutexGuard<'_, GateState> {
		self.state.lock().unwrap_or_else(PoisonError::into_inner)
	}

	fn heartbeat(&self) -> Result<(), String> {
		let mut state = self.lock();
		state.held = true;
		self.changed.notify_all();
		let state = self
			.changed
			.wait_while(state, |state| state.release.is_none())
			.unwrap_or_else(PoisonError::into_inner);
		let release = state.release.expect("the wait ends once a release is set");
		drop(state);
		match release {
			Release::Finish => Ok(()),
			Release::Fail => Err("the held walk failed".to_owned()),
			Release::Panic => panic!("the held walk panicked"),
		}
	}

	fn wait_held(&self) {
		let (state, _) = self
			.changed
			.wait_timeout_while(self.lock(), BOUND, |state| !state.held)
			.unwrap_or_else(PoisonError::into_inner);
		assert!(state.held, "the first walk never reached its heartbeat");
	}

	/// The first release wins, so the drop guard never turns a failure into a
	/// finish.
	fn release(&self, release: Release) {
		self.lock().release.get_or_insert(release);
		self.changed.notify_all();
	}
}

/// Releases the gate however the test ends, so a failed assertion never
/// leaves a scoped thread held forever.
struct ReleaseOnDrop<'a>(&'a Gate);

impl Drop for ReleaseOnDrop<'_> {
	fn drop(&mut self) {
		self.0.release(Release::Finish);
	}
}

/// A heartbeat that reports every call and fails once cancelled.
struct Probe {
	called:    mpsc::Sender<()>,
	cancelled: AtomicBool,
}

impl Probe {
	fn new() -> (Self, mpsc::Receiver<()>) {
		let (called, calls) = mpsc::channel();
		(Self { called, cancelled: AtomicBool::new(false) }, calls)
	}

	fn heartbeat(&self) -> Result<(), String> {
		self.called.send(()).ok();
		if self.cancelled.load(Ordering::SeqCst) {
			Err("the waiting request was cancelled".to_owned())
		} else {
			Ok(())
		}
	}
}

/// Cancels the probe however the test ends, so a failed assertion never leaves
/// a scoped thread waiting forever.
struct CancelOnDrop<'a>(&'a Probe);

impl Drop for CancelOnDrop<'_> {
	fn drop(&mut self) {
		self.0.cancelled.store(true, Ordering::SeqCst);
	}
}

#[test]
fn a_request_joins_the_walk_already_running() {
	for (lane_name, lane) in LANES {
		let _serial = ready();
		let root = tree(&format!("join-{lane_name}"));
		let root = root.path();
		let gate = Gate::default();
		let (probe, calls) = Probe::new();
		let (done, finished) = mpsc::channel();
		thread::scope(|scope| {
			let _release = ReleaseOnDrop(&gate);
			let _cancel = CancelOnDrop(&probe);
			let first = scope.spawn(|| lane(root, &|| gate.heartbeat()));
			gate.wait_held();
			write(root, "late.txt");
			scope.spawn(|| done.send(lane(root, &|| probe.heartbeat())));
			calls
				.recv_timeout(BOUND)
				.expect("the second request should call its heartbeat");
			gate.release(Release::Finish);
			let second = finished
				.recv_timeout(BOUND)
				.expect("the second request should finish once the first walk does")
				.expect("the second request should succeed");
			let first = first
				.join()
				.expect("the first walk should not panic")
				.expect("the first walk should succeed");
			assert!(
				!lists(&second, "late.txt"),
				"{lane_name}: the second request walked the tree itself instead of joining the walk \
				 already running"
			);
			assert_eq!(second, first, "{lane_name}: a joined request lists what the walk listed");
		});
	}
}

#[test]
fn requests_after_an_invalidation_join_a_new_walk_not_the_overtaken_one() {
	for (invalidation_name, invalidate) in INVALIDATIONS {
		for (lane_name, lane) in LANES {
			let _serial = ready();
			let root = tree(&format!("overtaken-join-{invalidation_name}-{lane_name}"));
			let root = root.path();
			let overtaken = Gate::default();
			let renewed = Gate::default();
			let (probe, calls) = Probe::new();
			let (second_done, second_finished) = mpsc::channel();
			let (third_done, third_finished) = mpsc::channel();
			thread::scope(|scope| {
				let _release_overtaken = ReleaseOnDrop(&overtaken);
				let _release_renewed = ReleaseOnDrop(&renewed);
				let _cancel = CancelOnDrop(&probe);
				let first = scope.spawn(|| lane(root, &|| overtaken.heartbeat()));
				overtaken.wait_held();
				write(root, "late.txt");
				invalidate(root);
				scope.spawn(|| second_done.send(lane(root, &|| renewed.heartbeat())));
				renewed.wait_held();
				write(root, "later.txt");
				scope.spawn(|| third_done.send(lane(root, &|| probe.heartbeat())));
				calls
					.recv_timeout(BOUND)
					.expect("the third request should call its heartbeat");
				renewed.release(Release::Finish);
				let second = second_finished
					.recv_timeout(BOUND)
					.unwrap_or_else(|_| {
						panic!(
							"{lane_name}: a request after invalidating by {invalidation_name} waited on \
							 the walk the invalidation overtook"
						)
					})
					.expect("the second request should succeed");
				let third = third_finished
					.recv_timeout(BOUND)
					.expect("the third request should finish once the second walk does")
					.expect("the third request should succeed");
				assert!(
					lists(&second, "late.txt"),
					"{lane_name}: the walk after invalidating by {invalidation_name} lists late.txt"
				);
				assert!(
					!lists(&third, "later.txt"),
					"{lane_name}: after invalidating by {invalidation_name}, a request walked the tree \
					 itself instead of joining the walk the invalidation started"
				);
				assert_eq!(third, second, "{lane_name}: a joined request lists what the walk listed");
				overtaken.release(Release::Finish);
				first
					.join()
					.expect("the first walk should not panic")
					.expect("the first walk should succeed");
			});
		}
	}
}

#[test]
fn a_walk_overtaken_by_an_invalidation_is_not_cached() {
	for (invalidation_name, invalidate) in INVALIDATIONS {
		for (lane_name, lane) in LANES {
			let _serial = ready();
			let root = tree(&format!("overtaken-store-{invalidation_name}-{lane_name}"));
			let root = root.path();
			let gate = Gate::default();
			thread::scope(|scope| {
				let _release = ReleaseOnDrop(&gate);
				let first = scope.spawn(|| lane(root, &|| gate.heartbeat()));
				gate.wait_held();
				invalidate(root);
				gate.release(Release::Finish);
				first
					.join()
					.expect("the first walk should not panic")
					.expect("the first walk should succeed");
			});
			write(root, "later.txt");
			let after = lane(root, &FREE).expect("the next request should succeed");
			assert!(
				lists(&after, "later.txt"),
				"{lane_name}: a scan taken before invalidating by {invalidation_name} was cached and \
				 served after it"
			);
		}
	}
}

#[test]
fn a_walk_longer_than_the_ttl_is_served_once_it_lands() {
	for (lane_name, lane) in LANES {
		let _serial = ready();
		let root = tree(&format!("slow-{lane_name}"));
		let root = root.path();
		let gate = Gate::default();
		thread::scope(|scope| {
			let _release = ReleaseOnDrop(&gate);
			let first = scope.spawn(|| lane(root, &|| gate.heartbeat()));
			gate.wait_held();
			thread::sleep(Duration::from_millis(cache_ttl_ms() + 100));
			gate.release(Release::Finish);
			first
				.join()
				.expect("the first walk should not panic")
				.expect("the first walk should succeed");
		});
		write(root, "later.txt");
		let after = lane(root, &FREE).expect("the next request should succeed");
		assert!(
			!lists(&after, "later.txt"),
			"{lane_name}: a walk longer than the TTL was stored already expired, so the next request \
			 walked again"
		);
		thread::sleep(Duration::from_millis(cache_ttl_ms() + 100));
		let expired = lane(root, &FREE).expect("the request after the TTL should succeed");
		assert!(
			lists(&expired, "later.txt"),
			"{lane_name}: a scan was served after its TTL had passed since it landed"
		);
	}
}

#[test]
fn a_cancelled_request_stops_waiting() {
	for (lane_name, lane) in LANES {
		let _serial = ready();
		let root = tree(&format!("cancel-{lane_name}"));
		let root = root.path();
		let gate = Gate::default();
		let (probe, calls) = Probe::new();
		let (done, finished) = mpsc::channel();
		thread::scope(|scope| {
			let _release = ReleaseOnDrop(&gate);
			let first = scope.spawn(|| lane(root, &|| gate.heartbeat()));
			gate.wait_held();
			scope.spawn(|| done.send(lane(root, &|| probe.heartbeat())));
			calls
				.recv_timeout(BOUND)
				.expect("the second request should call its heartbeat");
			probe.cancelled.store(true, Ordering::SeqCst);
			let second = finished.recv_timeout(BOUND).unwrap_or_else(|_| {
				panic!("{lane_name}: a cancelled request kept waiting on another request's walk")
			});
			assert_eq!(
				second,
				Err("the waiting request was cancelled".to_owned()),
				"{lane_name}: a cancelled request reports its own heartbeat's error"
			);
			gate.release(Release::Finish);
			first
				.join()
				.expect("the first walk should not panic")
				.expect("the first walk should succeed");
		});
	}
}

#[test]
fn a_request_waiting_on_a_failed_walk_walks_itself() {
	for release in [Release::Fail, Release::Panic] {
		for (lane_name, lane) in LANES {
			let _serial = ready();
			let root = tree(&format!("failed-{release:?}-{lane_name}"));
			let root = root.path();
			let gate = Gate::default();
			let (probe, calls) = Probe::new();
			let (done, finished) = mpsc::channel();
			thread::scope(|scope| {
				let _release = ReleaseOnDrop(&gate);
				let _cancel = CancelOnDrop(&probe);
				let first = scope.spawn(|| lane(root, &|| gate.heartbeat()));
				gate.wait_held();
				write(root, "late.txt");
				scope.spawn(|| done.send(lane(root, &|| probe.heartbeat())));
				calls
					.recv_timeout(BOUND)
					.expect("the second request should call its heartbeat");
				gate.release(release);
				let second = finished
					.recv_timeout(BOUND)
					.unwrap_or_else(|_| {
						panic!(
							"{lane_name}: a request waiting on a walk that hit {release:?} never returned"
						)
					})
					.unwrap_or_else(|err| {
						panic!(
							"{lane_name}: a request waiting on a walk that hit {release:?} failed: {err}"
						)
					});
				assert!(
					lists(&second, "late.txt") && lists(&second, &format!("src/f{:03}.txt", FILES - 1)),
					"{lane_name}: a request waiting on a walk that hit {release:?} lists the whole tree"
				);
				match (release, first.join()) {
					(Release::Fail, Ok(Err(message))) => assert_eq!(message, "the held walk failed"),
					(Release::Panic, Err(_)) => {},
					(release, outcome) => {
						panic!("{lane_name}: the first walk ended {outcome:?} after {release:?}")
					},
				}
			});
		}
	}
}
