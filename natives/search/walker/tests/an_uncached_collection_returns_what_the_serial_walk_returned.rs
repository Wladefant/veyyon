//! WHY: `WalkRequest::collect` with the cache off used to read the tree on one
//! thread, copy every entry, sort all of them by path and only then drop the
//! ones the filter rejected. A files search for a name that matched nothing in
//! a 400,000-file tree spent 700ms there. An uncached collection now walks on
//! the walker pool, copies only what the filter keeps and sorts that. On Linux
//! a request for full metadata with no size bound lists without metadata and
//! stats only the entries the filter keeps; a size bound lists with metadata,
//! because it needs every size. The sweep runs both.
//!
//! The class this closes is any observable difference between that parallel
//! collector and the serial one it replaced: an entry kept or dropped, its
//! metadata, the order, the scanned and filtered counts, or an error surfaced
//! or swallowed. The reference is the serial collector itself, read through the
//! shared lane with no filter, which this change does not route; the expected
//! answer is that walk filtered by the rule written out in test words. The
//! sweep crosses every option that decides which entries a walk reaches with
//! every root shape a caller can hand it. `base` names every `WalkOptions`
//! field, so an option added later does not compile here until it is placed.
//!
//! What it does not catch: a directory that fails to open with an error other
//! than not-found, not-a-directory or permission-denied (EIO, ENAMETOOLONG),
//! which no fixture here produces; the branches the deferred stat takes only
//! when the tree changes between listing an entry and statting it (the entry
//! vanished, changed kind, or failed to stat with such an error), which a
//! fixture cannot time; and the speed itself, which
//! `a_filtered_walk_never_copies_an_entry_it_discards.rs` pins by allocation
//! and `perf.rs` measures.

use std::{
	convert::Infallible,
	fs,
	path::{Path, PathBuf},
	sync::LazyLock,
};

use veyyon_test_scratch::{TempTree, scratch_dir};
use veyyon_walker::{
	CollectedEntry, CompiledWalkGlob, DirectoryErrorMode, FileType, FollowLinks, WalkBackend,
	WalkDetail, WalkFilter, WalkOptions, WalkOrder, WalkOverridePattern, WalkOverrides, WalkRequest,
	walk_workers,
};

/// Four walker threads, whatever the host says.
///
/// The worker count is read once per process, so it is set before the first
/// walk in this binary; with one worker every request would stay serial and the
/// sweep would compare the serial collector with itself.
static WORKERS: LazyLock<()> = LazyLock::new(|| {
	// SAFETY: this body runs once, inside `LazyLock`, before any walk in this
	// binary has read the environment.
	unsafe { std::env::set_var("VEYYON_WALK_WORKERS", "4") };
});

fn ready() {
	LazyLock::force(&WORKERS);
	assert_eq!(walk_workers(), 4, "the sweep needs the parallel collector to apply");
}

fn temp_tree(name: &str) -> TempTree {
	scratch_dir(&format!("walker-uncached-collection-{name}"))
}

fn write(path: impl AsRef<Path>, bytes: &[u8]) {
	let path = path.as_ref();
	if let Some(parent) = path.parent() {
		fs::create_dir_all(parent).expect("parent directory should be created");
	}
	fs::write(path, bytes).expect("file should be written");
}

/// Every kind of entry and every rule that decides whether a walk reaches one.
fn build(root: &Path, with_git: bool) {
	write(root.join("a.txt"), b"a");
	write(root.join("big.rs"), &[b'x'; 4096]);
	write(root.join(".hidden.txt"), b"h");
	write(root.join(".hiddendir/inner.rs"), b"h");
	write(root.join(".gitignore"), b"ignored.txt\nignored_dir/\n");
	write(root.join(".ignore"), b"dotignored.rs\n");
	write(root.join("ignored.txt"), b"i");
	write(root.join("dotignored.rs"), b"i");
	write(root.join("ignored_dir/x.rs"), b"i");
	write(root.join("excluded.rs"), b"e");
	write(root.join("node_modules/pkg/index.rs"), b"n");
	write(root.join("src/lib.rs"), b"s");
	write(root.join("src/ignored.txt"), b"s");
	write(root.join("src/deep/er/leaf.rs"), b"s");
	write(root.join("src/deep/er/est/leaf.rs"), b"s");
	write(root.join("locked/secret.rs"), b"l");
	fs::create_dir_all(root.join("empty_dir")).expect("empty directory should be created");
	if with_git {
		write(root.join(".git/HEAD"), b"ref: refs/heads/main\n");
		write(root.join(".git/info/exclude"), b"excluded.rs\n");
	}
	#[cfg(unix)]
	{
		use std::os::unix::fs::{PermissionsExt, symlink};
		symlink("a.txt", root.join("link_to_file")).expect("file symlink should be created");
		symlink("src", root.join("link_to_dir")).expect("directory symlink should be created");
		symlink("missing", root.join("dangling")).expect("dangling symlink should be created");
		fs::set_permissions(root.join("locked"), fs::Permissions::from_mode(0o000))
			.expect("locked directory should be made unreadable");
	}
}

/// Restores `locked/` so the scratch tree can be removed. Declared after the
/// tree, so it drops first.
struct Unlock(
	#[cfg_attr(not(unix), allow(dead_code, reason = "only unix makes `locked/` unreadable"))]
	Vec<PathBuf>,
);

impl Drop for Unlock {
	fn drop(&mut self) {
		#[cfg(unix)]
		for root in &self.0 {
			use std::os::unix::fs::PermissionsExt;
			let _ = fs::set_permissions(root.join("locked"), fs::Permissions::from_mode(0o755));
		}
	}
}

/// Every option, named, at the value the native glob path uses.
const fn base() -> WalkOptions {
	WalkOptions {
		include_hidden:     true,
		use_gitignore:      true,
		use_dot_ignore:     true,
		use_vcs_ignore:     true,
		use_exclude_ignore: true,
		use_global_ignore:  true,
		use_parent_ignore:  true,
		require_git:        false,
		skip_git:           false,
		skip_node_modules:  false,
		follow_links:       FollowLinks::Never,
		detail:             WalkDetail::Full,
		order:              WalkOrder::Path,
		emit_root:          false,
		min_depth:          1,
		max_depth:          usize::MAX,
		contents_first:     false,
		directory_errors:   DirectoryErrorMode::SkipSkippable,
		same_file_system:   false,
		cache:              false,
	}
}

/// The full product of every option that decides which entries a walk reaches.
fn reaching_options() -> Vec<WalkOptions> {
	let bounds =
		[(0, usize::MAX), (1, usize::MAX), (2, usize::MAX), (1, 1), (1, 2), (2, 2), (1, 0), (3, 2)];
	let mut out = Vec::new();
	for bits in 0_u32..(1 << 7) {
		let bit = |index: u32| bits & (1 << index) != 0;
		for (min_depth, max_depth) in bounds {
			out.push(WalkOptions {
				include_hidden: bit(0),
				use_gitignore: bit(1),
				require_git: bit(2),
				skip_git: bit(3),
				skip_node_modules: bit(4),
				detail: if bit(5) {
					WalkDetail::Full
				} else {
					WalkDetail::Minimal
				},
				directory_errors: if bit(6) {
					DirectoryErrorMode::SkipSkippable
				} else {
					DirectoryErrorMode::Visit
				},
				min_depth,
				max_depth,
				..base()
			});
		}
	}
	out
}

/// One option at a time off each base: the ignore sources, and the options
/// that send a request to the serial collector.
fn single_options() -> Vec<WalkOptions> {
	let variants: [fn(&mut WalkOptions); 13] = [
		|o| o.use_dot_ignore = false,
		|o| o.use_vcs_ignore = false,
		|o| o.use_exclude_ignore = false,
		|o| o.use_global_ignore = false,
		|o| o.use_parent_ignore = false,
		|o| o.follow_links = FollowLinks::Roots,
		|o| o.follow_links = FollowLinks::Always,
		|o| o.order = WalkOrder::Unordered,
		|o| o.emit_root = true,
		|o| {
			o.emit_root = true;
			o.min_depth = 0;
		},
		|o| o.contents_first = true,
		|o| o.same_file_system = true,
		|o| o.include_hidden = false,
	];
	let mut out = Vec::new();
	for gitignore in [true, false] {
		for variant in variants {
			let mut options = WalkOptions { use_gitignore: gitignore, ..base() };
			variant(&mut options);
			out.push(options);
		}
	}
	out
}

fn glob(pattern: &str) -> CompiledWalkGlob {
	CompiledWalkGlob::new([pattern]).expect("test glob should compile")
}

/// Filters paired with the same rule in test words. `node_modules` is in the
/// set because it prunes a directory, the one decision that stops a filtered
/// walk from descending; the size bound because it needs every entry's size,
/// so it is the one filter that lists with metadata rather than statting what
/// it keeps.
#[expect(
	clippy::type_complexity,
	reason = "a filter paired with the same rule written independently in test words"
)]
fn filters() -> Vec<(&'static str, WalkFilter, Box<dyn Fn(&CollectedEntry) -> bool>)> {
	vec![
		("all", WalkFilter::all(), Box::new(|_: &CollectedEntry| true)),
		(
			"files + glob",
			WalkFilter::files_only().glob(glob("**/*.rs")),
			Box::new(|entry: &CollectedEntry| {
				entry.file_type == FileType::File && glob("**/*.rs").is_match(&entry.path)
			}),
		),
		(
			"dirs",
			WalkFilter::dirs_only(),
			Box::new(|entry: &CollectedEntry| entry.file_type == FileType::Dir),
		),
		(
			"node_modules unless mentioned",
			WalkFilter::all().node_modules_unless_mentioned(false),
			Box::new(|entry: &CollectedEntry| {
				!entry.path.split('/').any(|part| part == "node_modules")
			}),
		),
		(
			"size bound",
			WalkFilter::files_only().max_file_size(1024),
			Box::new(|entry: &CollectedEntry| {
				entry.file_type == FileType::File && !entry.size.is_some_and(|size| size > 1024.0)
			}),
		),
	]
}

/// Entries as the two collectors can be compared.
///
/// NTFS refreshes a directory's own timestamp in its parent's listing lazily,
/// so two reads of one unchanged directory, a millisecond apart, can disagree
/// by about a millisecond on Windows. A directory entry carries no mtime
/// there; files and every other field still compare exactly.
fn comparable(mut entries: Vec<CollectedEntry>) -> Vec<CollectedEntry> {
	if cfg!(windows) {
		for entry in &mut entries {
			if entry.file_type == FileType::Dir {
				entry.mtime = None;
			}
		}
	}
	entries
}

/// What the serial collector returns for `request`, unfiltered, or its error.
///
/// The detail is the request's effective one: a size bound reads metadata for
/// a request that asked for none, and the reference reads what it reads.
fn serial(request: &WalkRequest) -> Result<Vec<CollectedEntry>, String> {
	request
		.clone()
		.filter(WalkFilter::all())
		.detail(request.options().detail)
		.collect_shared_with_heartbeat(|| Ok::<(), Infallible>(()))
		.map(|walk| comparable(walk.iter().cloned().collect()))
		.map_err(|err| format!("{err:?}"))
}

/// Compare the subject with the serial reference for one request.
fn check(label: &str, request: &WalkRequest) {
	let mut references: Vec<(WalkDetail, Result<Vec<CollectedEntry>, String>)> = Vec::new();
	for (name, filter, accept) in filters() {
		let request = request.clone().filter(filter);
		let detail = request.options().detail;
		if !references.iter().any(|(read, _)| *read == detail) {
			references.push((detail, serial(&request)));
		}
		let reference = &references
			.iter()
			.find(|(read, _)| *read == detail)
			.expect("the reference for this detail was just read")
			.1;
		let subject = request.collect();
		let case = format!("{label}, filter {name}");
		match (reference, subject) {
			(Ok(all), Ok(outcome)) => {
				let expected: Vec<CollectedEntry> =
					all.iter().filter(|entry| accept(entry)).cloned().collect();
				let entries = comparable(outcome.entries);
				assert_eq!(entries, expected, "{case}: entries");
				assert_eq!(outcome.stats.scanned_entries, all.len(), "{case}: scanned");
				assert_eq!(
					outcome.stats.filtered_entries,
					all.len() - expected.len(),
					"{case}: filtered"
				);
				assert_eq!(outcome.stats.limited_entries, 0, "{case}: limited");
				assert_eq!(outcome.backend, WalkBackend::Fresh, "{case}: backend");
			},
			(Err(expected), Err(error)) => {
				assert_eq!(&format!("{error:?}"), expected, "{case}: error");
			},
			(reference, subject) => panic!(
				"{case}: the serial collector returned {reference:?} and the subject returned \
				 {subject:?}"
			),
		}
	}
}

#[test]
fn every_option_and_root_shape_collects_what_the_serial_walk_collected() {
	ready();
	let git = temp_tree("git");
	let plain = temp_tree("plain");
	let _unlock = Unlock(vec![git.path().to_path_buf(), plain.path().to_path_buf()]);
	build(git.path(), true);
	build(plain.path(), false);

	let roots = [
		git.path().to_path_buf(),
		plain.path().to_path_buf(),
		git.path().join("src"),
		git.path().join("a.txt"),
		git.path().join("link_to_dir"),
		git.path().join("missing"),
		git.path().join("locked"),
	];
	// The fixture is only a fixture if both lanes see the entries it was built
	// to hold; an empty reference would make every comparison trivial.
	let full = serial(&WalkRequest::from_options(git.path(), base())).expect("reference walk");
	for path in ["src/deep/er/est/leaf.rs", "node_modules/pkg/index.rs", ".hidden.txt", "big.rs"] {
		assert!(full.iter().any(|entry| entry.path == path), "the fixture should reach {path}");
	}

	for options in reaching_options().into_iter().chain(single_options()) {
		for root in &roots {
			let request = WalkRequest::from_options(root, options);
			check(&format!("{} with {options:?}", root.display()), &request);
		}
	}
}

#[test]
fn caller_named_globs_collect_what_the_serial_walk_collected() {
	ready();
	let tree = temp_tree("overrides");
	let _unlock = Unlock(vec![tree.path().to_path_buf()]);
	build(tree.path(), true);

	let pattern_sets: [&[&str]; 5] =
		[&["**/*.rs"], &["*"], &["!**/*.txt"], &["**/.hidden*", "**/ignored*"], &["ignored_dir"]];
	for patterns in pattern_sets {
		let overrides = WalkOverrides::new(
			tree.path(),
			patterns.iter().map(|glob| WalkOverridePattern::new(*glob)),
		)
		.expect("override globs should compile");
		for (include_hidden, use_gitignore) in
			[(true, true), (false, true), (true, false), (false, false)]
		{
			let options = WalkOptions { include_hidden, use_gitignore, ..base() };
			let request = WalkRequest::from_options(tree.path(), options).overrides(overrides.clone());
			check(&format!("{patterns:?} with {options:?}"), &request);
		}
	}
}
