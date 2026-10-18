//! Fuzzy file path discovery for autocomplete and @-mention resolution.
//!
//! Searches for files and directories whose paths match a query string via
//! subsequence scoring. Uses `veyyon-walker` for directory traversal and
//! caching.

use std::{borrow::Cow, cmp::Ordering, collections::BinaryHeap, path::Path};

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::{iofs, task};

/// A kept match. Orders worst first: a lower score, then a deeper path, then a
/// later path, so a max-heap of these has the worst kept match on top and its
/// sorted vector lists the best first.
struct Ranked {
	score:        u32,
	depth:        usize,
	/// Relative path, with a trailing `/` for a directory.
	path:         String,
	is_directory: bool,
}

impl Ord for Ranked {
	fn cmp(&self, other: &Self) -> Ordering {
		other
			.score
			.cmp(&self.score)
			.then_with(|| self.depth.cmp(&other.depth))
			.then_with(|| self.path.cmp(&other.path))
	}
}

impl PartialOrd for Ranked {
	fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
		Some(self.cmp(other))
	}
}

impl PartialEq for Ranked {
	fn eq(&self, other: &Self) -> bool {
		self.cmp(other).is_eq()
	}
}

impl Eq for Ranked {}

/// Whether a candidate, not yet copied, ranks before `kept` in [`Ranked`]
/// order. The candidate's path is compared with the `/` a directory gets, so
/// the answer matches comparing the two as [`Ranked`] values.
fn ranks_before(score: u32, depth: usize, path: &str, is_directory: bool, kept: &Ranked) -> bool {
	kept
		.score
		.cmp(&score)
		.then_with(|| depth.cmp(&kept.depth))
		.then_with(|| {
			path
				.bytes()
				.chain(is_directory.then_some(b'/'))
				.cmp(kept.path.bytes())
		})
		.is_lt()
}

/// Options for fuzzy file path search.
#[napi(object)]
pub struct FuzzyFindOptions<'env> {
	/// Fuzzy query to match against file paths (case-insensitive).
	pub query:       String,
	/// Directory to search.
	pub path:        String,
	/// Include hidden files (default: false).
	pub hidden:      Option<bool>,
	/// Respect .gitignore (default: true).
	pub gitignore:   Option<bool>,
	/// Enable walker scan caching (default: false).
	pub cache:       Option<bool>,
	/// Maximum number of matches to return (default: 100).
	pub max_results: Option<u32>,
	/// Abort signal for cancelling the operation.
	pub signal:      Option<Unknown<'env>>,
	/// Timeout in milliseconds for the operation.
	pub timeout_ms:  Option<u32>,
}

/// A single match in fuzzy find results.
#[napi(object)]
pub struct FuzzyFindMatch {
	/// Relative path from the search root (uses `/` separators).
	pub path:         String,
	/// Whether this entry is a directory.
	pub is_directory: bool,
	/// Match quality score (higher is better).
	pub score:        u32,
}

/// Result of fuzzy file path search.
#[napi(object)]
pub struct FuzzyFindResult {
	/// Matched entries (up to `maxResults`).
	pub matches:       Vec<FuzzyFindMatch>,
	/// Total number of matches found (may exceed `matches.len()`).
	pub total_matches: u32,
}

/// `value` lowercased, borrowed when lowercasing leaves it unchanged.
///
/// The scorer lowercases the name of every entry it reads, and most names are
/// lowercase ASCII already, so allocating a copy of each is most of a
/// lookup's cost. Any other string goes through `str::to_lowercase`, whose
/// context rules (a final sigma) a per-character lowercase does not follow.
fn lowercase(value: &str) -> Cow<'_, str> {
	if value
		.bytes()
		.any(|byte| byte.is_ascii_uppercase() || !byte.is_ascii())
	{
		Cow::Owned(value.to_lowercase())
	} else {
		Cow::Borrowed(value)
	}
}

/// The characters fuzzy scoring compares: `value` without whitespace and path
/// punctuation, lowercased one character at a time.
fn normalized_chars(value: &str) -> impl Iterator<Item = char> + '_ {
	value
		.chars()
		.filter(|ch| !ch.is_whitespace() && !matches!(ch, '/' | '\\' | '.' | '_' | '-'))
		.flat_map(char::to_lowercase)
}

fn normalize_fuzzy_text(value: &str) -> String {
	normalized_chars(value).collect()
}

fn fuzzy_subsequence_score(query_chars: &[char], target: impl Iterator<Item = char>) -> u32 {
	if query_chars.is_empty() {
		return 1;
	}
	let mut query_index = 0usize;
	let mut gaps = 0u32;
	let mut last_match_index: Option<usize> = None;
	for (target_index, target_ch) in target.enumerate() {
		if query_index >= query_chars.len() {
			break;
		}
		if query_chars[query_index] == target_ch {
			if let Some(last_index) = last_match_index
				&& target_index > last_index + 1
			{
				gaps = gaps.saturating_add(1);
			}
			last_match_index = Some(target_index);
			query_index += 1;
		}
	}
	if query_index != query_chars.len() {
		return 0;
	}
	let gap_penalty = gaps.saturating_mul(5);
	40u32.saturating_sub(gap_penalty).max(1)
}

/// The last component of a walk path, as `Path::file_name` reads it with the
/// whole path as the fallback.
///
/// A walk path is relative with `/` separators, so the component after the
/// last `/` is the answer unless it is empty, `.` or `..`, which go to `Path`.
/// A path without a `/` is its own answer either way.
fn file_name(path: &str) -> &str {
	match path.rsplit_once('/') {
		None => path,
		Some((_, name)) if !matches!(name, "" | "." | "..") => name,
		_ => Path::new(path)
			.file_name()
			.and_then(|name| name.to_str())
			.unwrap_or(path),
	}
}

/// Whether `query_chars` occur in order in the ASCII string `haystack`, which
/// is lowercased byte by byte.
///
/// Normalized query characters are never whitespace or path punctuation, so
/// the bytes normalization drops cannot match and need no skipping, and a
/// character outside ASCII cannot occur at all.
fn holds_ascii_subsequence(haystack: &str, query_chars: &[char]) -> bool {
	let mut wanted = query_chars.iter();
	let Some(mut next) = wanted.next() else {
		return true;
	};
	for byte in haystack.bytes() {
		if char::from(byte.to_ascii_lowercase()) == *next {
			match wanted.next() {
				Some(following) => next = following,
				None => return true,
			}
		}
	}
	false
}

fn score_fuzzy_path(
	path: &str,
	is_directory: bool,
	query_lower: &str,
	query_chars: &[char],
) -> u32 {
	if query_lower.is_empty() {
		return if is_directory { 11 } else { 1 };
	}

	// Match against the full relative path only when the user typed a path-style
	// query (contains '/'). Plain queries should match by basename only, otherwise
	// '@plan' surfaces every file whose ancestor directories contain 'plan'.
	let query_has_slash = query_lower.contains('/');

	let file_name = file_name(path);
	// Every nonzero score needs the query's characters in order in the name,
	// or in the path for a query with a `/`, once both are normalized. For
	// ASCII that is one byte scan, and it rejects most entries before anything
	// is lowercased or searched.
	let searched = if query_has_slash { path } else { file_name };
	if searched.is_ascii() && !holds_ascii_subsequence(searched, query_chars) {
		return 0;
	}
	let lower_file_name = lowercase(file_name);

	let mut score = if lower_file_name == query_lower {
		120
	} else if lower_file_name.starts_with(query_lower) {
		100
	} else if lower_file_name.contains(query_lower) {
		80
	} else if !query_has_slash {
		let file_name_fuzzy = fuzzy_subsequence_score(query_chars, normalized_chars(file_name));
		if file_name_fuzzy > 0 {
			50 + file_name_fuzzy
		} else {
			0
		}
	} else {
		let lower_path = lowercase(path);
		if lower_path.contains(query_lower) {
			60
		} else {
			let file_name_fuzzy = fuzzy_subsequence_score(query_chars, normalized_chars(file_name));
			if file_name_fuzzy > 0 {
				50 + file_name_fuzzy
			} else {
				let path_fuzzy = fuzzy_subsequence_score(query_chars, normalized_chars(path));
				if path_fuzzy > 0 { 30 + path_fuzzy } else { 0 }
			}
		}
	};

	if is_directory && score > 0 {
		score += 10;
	}

	score
}

/// Directory depth of a relative match path (trailing slash ignored).
/// Used as a sort tie-break so equally scored matches surface shallow paths
/// first — `@scripts` should rank cwd-root `scripts/` above
/// `packages/*/scripts/`.
fn path_depth(path: &str) -> usize {
	path.trim_end_matches('/').matches('/').count()
}

struct FuzzyFindConfig {
	query:       String,
	path:        String,
	hidden:      Option<bool>,
	gitignore:   Option<bool>,
	max_results: Option<u32>,
	cache:       Option<bool>,
}

fn fuzzy_find_sync(config: FuzzyFindConfig, ct: task::CancelToken) -> Result<FuzzyFindResult> {
	let root = veyyon_walker::resolve_search_path(&config.path).map_err(iofs::map_walker_error)?;
	let include_hidden = config.hidden.unwrap_or(false);
	let respect_gitignore = config.gitignore.unwrap_or(true);
	let max_results = config.max_results.unwrap_or(100) as usize;
	if max_results == 0 {
		return Ok(FuzzyFindResult { matches: Vec::new(), total_matches: 0 });
	}

	let query_lower = config.query.trim().to_lowercase();
	let normalized_query = normalize_fuzzy_text(&query_lower);
	let query_chars: Vec<char> = normalized_query.chars().collect();
	if !query_lower.is_empty() && normalized_query.is_empty() {
		return Ok(FuzzyFindResult { matches: Vec::new(), total_matches: 0 });
	}

	let walk = veyyon_walker::WalkRequest::new(root)
		.hidden(include_hidden)
		.gitignore(respect_gitignore)
		.skip_git(true)
		.skip_node_modules(true)
		.follow_links(veyyon_walker::FollowLinks::Always)
		.detail(veyyon_walker::WalkDetail::Minimal)
		.order(veyyon_walker::WalkOrder::Path)
		.emit_root(false)
		.depth(1, usize::MAX)
		.directory_errors(veyyon_walker::DirectoryErrorMode::SkipSkippable)
		.cache(config.cache.unwrap_or(false))
		.empty_recheck(veyyon_walker::EmptyRecheck::Configured)
		.collect_shared_with_heartbeat(|| ct.heartbeat())
		.map_err(iofs::map_walker_error)?;
	let query = FuzzyQuery { lower: &query_lower, chars: &query_chars };
	let (best, total_matches) = best_matches(walk.iter(), &query, max_results, &ct)?;
	let matches = best
		.into_iter()
		.map(|Ranked { score, path, is_directory, .. }| FuzzyFindMatch { path, is_directory, score })
		.collect();
	Ok(FuzzyFindResult { matches, total_matches: crate::utils::clamp_u32(total_matches) })
}

/// A query in the two forms [`score_fuzzy_path`] reads.
struct FuzzyQuery<'a> {
	lower: &'a str,
	chars: &'a [char],
}

/// The best `max_results` matches among `entries`, best first, and the number
/// of entries that matched at all.
///
/// The entries are borrowed from the walk, and a path is copied only while its
/// match ranks among the best `max_results`. The result does not depend on the
/// order the entries arrive in, because [`Ranked`] order is total over unique
/// paths.
fn best_matches<'a>(
	entries: impl Iterator<Item = &'a veyyon_walker::CollectedEntry>,
	query: &FuzzyQuery<'_>,
	max_results: usize,
	ct: &task::CancelToken,
) -> Result<(Vec<Ranked>, u64)> {
	let mut kept = BinaryHeap::with_capacity(max_results.min(1024) + 1);
	let mut total_matches = 0_u64;
	for entry in entries {
		ct.heartbeat()?;
		if entry.file_type == veyyon_walker::FileType::Symlink {
			continue;
		}

		let is_directory = entry.file_type == veyyon_walker::FileType::Dir;
		let score = score_fuzzy_path(&entry.path, is_directory, query.lower, query.chars);
		if score == 0 {
			continue;
		}
		total_matches += 1;

		let depth = path_depth(&entry.path);
		if kept.len() == max_results {
			let Some(worst) = kept.peek() else { continue };
			if !ranks_before(score, depth, &entry.path, is_directory, worst) {
				continue;
			}
			kept.pop();
		}
		let mut path = String::with_capacity(entry.path.len() + usize::from(is_directory));
		path.push_str(&entry.path);
		if is_directory {
			path.push('/');
		}
		kept.push(Ranked { score, depth, path, is_directory });
	}
	Ok((kept.into_sorted_vec(), total_matches))
}

/// Fuzzy file path search for autocomplete.
#[napi(js_name = "fuzzyFind")]
pub fn fuzzy_find(options: FuzzyFindOptions<'_>) -> task::Promise<FuzzyFindResult> {
	let FuzzyFindOptions { query, path, hidden, gitignore, cache, max_results, timeout_ms, signal } =
		options;
	let ct = task::CancelToken::new(timeout_ms, signal);
	let config = FuzzyFindConfig { query, path, hidden, gitignore, max_results, cache };
	task::blocking("fuzzy_find", ct, move |ct| fuzzy_find_sync(config, ct))
}

#[cfg(test)]
mod tests {
	#[cfg(unix)]
	use std::{fs, os::unix::fs as unix_fs};

	use veyyon_walker::{CollectedEntry, FileType};

	#[cfg(unix)]
	use super::{FuzzyFindConfig, fuzzy_find_sync};
	use super::{
		FuzzyQuery, best_matches, fuzzy_subsequence_score, normalize_fuzzy_text, path_depth,
		score_fuzzy_path,
	};
	use crate::task;

	// WHY: fuzzy find used to score every entry, copy every match and sort them
	// all before keeping `max_results`; an empty query copied all 510 000 paths
	// of a scanned `/usr`. It now keeps a bounded heap and copies a path only
	// while its match is among the best. The class these tests close is any
	// selection whose answer differs from that full sort cut at `max_results`:
	// a comparator that disagrees with the kept order, an admission that
	// evicts a better match, a tie broken by arrival order instead of by path,
	// and a match count that counts kept matches instead of all of them. Every
	// cut and every rotation of the entries in both directions is checked,
	// because a wrong admission shows only when a better match arrived first.
	// What they do not catch: whether the entries were borrowed or copied, which
	// the walker's allocation tests and the binary measurement cover.

	/// The walk entries the selection tests rank: directories that tie on score
	/// and depth and differ by a byte below `/` (`foo`, `foo-`, `foo.d`),
	/// sibling directories whose walk order is not their byte order (`a`,
	/// `a-b`), the same name at two depths, and a symlink, which is never a
	/// match.
	fn corpus() -> Vec<CollectedEntry> {
		let entry = |path: &str, file_type| CollectedEntry {
			path: path.to_owned(),
			file_type,
			mtime: None,
			size: None,
		};
		vec![
			entry("foo", FileType::Dir),
			entry("foo-", FileType::Dir),
			entry("foo.d", FileType::Dir),
			entry("scripts", FileType::Dir),
			entry("a", FileType::Dir),
			entry("a-b", FileType::Dir),
			entry("a/scripts", FileType::Dir),
			entry("a-b/scripts", FileType::Dir),
			entry("foo-/x.txt", FileType::File),
			entry("scripts.md", FileType::File),
			entry("a/scripts.md", FileType::File),
			entry("a/notes.txt", FileType::File),
			entry("s-c-r-i-p-t-s", FileType::File),
			entry("link-to-foo", FileType::Symlink),
		]
	}

	/// Every match ranked by a full sort, best first, as `(path, score)`.
	fn fully_sorted(entries: &[CollectedEntry], query: &FuzzyQuery<'_>) -> Vec<(String, u32)> {
		let mut scored: Vec<(String, u32)> = entries
			.iter()
			.filter(|entry| entry.file_type != FileType::Symlink)
			.filter_map(|entry| {
				let is_directory = entry.file_type == FileType::Dir;
				let score = score_fuzzy_path(&entry.path, is_directory, query.lower, query.chars);
				let path = if is_directory {
					format!("{}/", entry.path)
				} else {
					entry.path.clone()
				};
				(score > 0).then_some((path, score))
			})
			.collect();
		scored.sort_by(|a, b| {
			b.1.cmp(&a.1)
				.then_with(|| path_depth(&a.0).cmp(&path_depth(&b.0)))
				.then_with(|| a.0.cmp(&b.0))
		});
		scored
	}

	#[test]
	fn the_kept_matches_are_the_full_ranking_cut_at_max_results_in_any_arrival_order() {
		let corpus = corpus();
		let forward: Vec<&CollectedEntry> = corpus.iter().collect();
		let backward: Vec<&CollectedEntry> = corpus.iter().rev().collect();
		let ct = task::CancelToken::default();
		for raw_query in ["", "scripts", "foo"] {
			let lower = raw_query.trim().to_lowercase();
			let normalized = normalize_fuzzy_text(&lower);
			let chars: Vec<char> = normalized.chars().collect();
			let query = FuzzyQuery { lower: &lower, chars: &chars };
			let ranking = fully_sorted(&corpus, &query);
			assert!(ranking.len() > 2, "{raw_query:?} should match enough entries to cut");

			for order in [&forward, &backward] {
				for start in 0..order.len() {
					let arrival = order[start..].iter().chain(&order[..start]).copied();
					for max_results in 1..=ranking.len() + 1 {
						let (best, total) = best_matches(arrival.clone(), &query, max_results, &ct)
							.expect("selection should succeed");
						let kept: Vec<(String, u32)> = best
							.into_iter()
							.map(|ranked| (ranked.path, ranked.score))
							.collect();
						let cut = &ranking[..max_results.min(ranking.len())];
						assert_eq!(
							kept, cut,
							"query {raw_query:?}, max_results {max_results}, arrival starting at {:?}",
							order[start].path
						);
						assert_eq!(total, ranking.len() as u64, "every match is counted");
					}
				}
			}
		}
	}

	#[test]
	fn an_empty_query_ranks_directories_then_shallow_paths_then_bytes() {
		let corpus = corpus();
		let query = FuzzyQuery { lower: "", chars: &[] };
		let (best, total) = best_matches(corpus.iter(), &query, 100, &task::CancelToken::default())
			.expect("selection should succeed");
		let paths: Vec<&str> = best.iter().map(|ranked| ranked.path.as_str()).collect();
		assert_eq!(paths, [
			"a-b/",
			"a/",
			"foo-/",
			"foo.d/",
			"foo/",
			"scripts/",
			"a-b/scripts/",
			"a/scripts/",
			"s-c-r-i-p-t-s",
			"scripts.md",
			"a/notes.txt",
			"a/scripts.md",
			"foo-/x.txt",
		]);
		assert_eq!(total, 13, "every entry but the symlink matches an empty query");
	}

	/// The scorer before it borrowed: each name and path lowercased with
	/// `str::to_lowercase` and normalized into a new `String`, and a path whose
	/// normalized form equals the query scored 40 by comparison, which the
	/// subsequence score of an identical string also gives. The borrowing scorer
	/// must agree with it on every name, including the ones it still copies.
	fn copying_score(
		path: &str,
		is_directory: bool,
		query_lower: &str,
		normalized_query: &str,
		query_chars: &[char],
	) -> u32 {
		let normalize = |value: &str| -> String {
			value
				.chars()
				.filter(|ch| !ch.is_whitespace() && !matches!(ch, '/' | '\\' | '.' | '_' | '-'))
				.flat_map(|ch| ch.to_lowercase())
				.collect()
		};
		if query_lower.is_empty() {
			return if is_directory { 11 } else { 1 };
		}
		let file_name = std::path::Path::new(path)
			.file_name()
			.and_then(|name| name.to_str())
			.unwrap_or(path);
		let lower_file_name = file_name.to_lowercase();
		let file_name_fuzzy = || fuzzy_subsequence_score(query_chars, normalize(file_name).chars());
		let score = if lower_file_name == query_lower {
			120
		} else if lower_file_name.starts_with(query_lower) {
			100
		} else if lower_file_name.contains(query_lower) {
			80
		} else if !query_lower.contains('/') {
			match file_name_fuzzy() {
				0 => 0,
				fuzzy => 50 + fuzzy,
			}
		} else if path.to_lowercase().contains(query_lower) {
			60
		} else {
			match file_name_fuzzy() {
				0 => {
					let normalized_path = normalize(path);
					let path_fuzzy = if normalized_path == normalized_query {
						40
					} else {
						fuzzy_subsequence_score(query_chars, normalized_path.chars())
					};
					if path_fuzzy > 0 { 30 + path_fuzzy } else { 0 }
				},
				fuzzy => 50 + fuzzy,
			}
		};
		if is_directory && score > 0 {
			score + 10
		} else {
			score
		}
	}

	// WHY: the scorer lowercased and normalized every entry's name into a new
	// string, two allocations per entry on every keystroke of an `@` lookup. It
	// now borrows a name that lowercasing leaves unchanged, normalizes as it
	// compares, rejects an ASCII name that lacks the query's characters in one
	// byte scan, and splits the name off at the last `/` instead of parsing a
	// `Path`. The class closed is any name the borrowing scorer reads
	// differently from the copying one: uppercase ASCII, non-ASCII whose
	// lowercase depends on context (a final sigma, a dotted capital I), Unicode
	// whitespace, a match only a directory in the path holds, a path ending in
	// `/`, `.` or `..`, and every score class, each pinned below so the
	// comparison covers it. What it does not catch: a name outside this corpus
	// whose lowercase differs in a way none of these share.
	#[test]
	fn scoring_a_borrowed_name_agrees_with_scoring_a_lowercased_copy() {
		let classes = [
			("src/Main.rs", "main.rs", 120),
			("README.md", "readme", 100),
			("lib/libzq.so", "zq", 80),
			("z-q.txt", "zq", 90),
			("usr/lib/zq.py", "lib/zq", 60),
			("a/x_z_q", "x/zq", 90),
			("A/B", "a/b.", 70),
			("q/r/s/t", "q/s", 65),
			("ΣΑΣ", "\u{3C3}\u{3B1}\u{3C2}", 120),
			("dir/ΟΔΟΣ.txt", "\u{3BF}\u{3B4}\u{3BF}\u{3C3}", 100),
			("\u{130}stanbul", "i\u{307}stanbul", 120),
			("x\u{0B}y", "xy", 90),
			("nothing.txt", "zq", 0),
		];
		let mut paths: Vec<&str> = classes.iter().map(|(path, ..)| *path).collect();
		paths.extend([
			"STRASSE",
			"straße",
			"Makefile",
			"tab\tname",
			"lib/ZQ/Zq",
			"ZQ.TXT",
			"foo bar.txt",
			"lib/zq/x",
			"ünïcode/zq.txt",
			"a/b/.",
			"a/..",
			".",
			"..",
			"trailing/",
			"a//b",
			"",
		]);
		let mut queries: Vec<&str> = classes.iter().map(|(_, query, _)| *query).collect();
		queries.extend([
			"strasse", "straße", "make", "tabname", "zq/zq", "Σ", "trailing", "b", "foo bar", "..",
			"a/..",
		]);

		for raw_query in queries {
			let lower = raw_query.trim().to_lowercase();
			let normalized = normalize_fuzzy_text(&lower);
			let chars: Vec<char> = normalized.chars().collect();
			for path in &paths {
				for is_directory in [false, true] {
					let copied = copying_score(path, is_directory, &lower, &normalized, &chars);
					let borrowed = score_fuzzy_path(path, is_directory, &lower, &chars);
					assert_eq!(
						borrowed, copied,
						"{path:?} against {raw_query:?}, directory {is_directory}"
					);
				}
			}
		}
		for (path, query, score) in classes {
			let lower = query.to_lowercase();
			let normalized = normalize_fuzzy_text(&lower);
			let chars: Vec<char> = normalized.chars().collect();
			assert_eq!(
				copying_score(path, false, &lower, &normalized, &chars),
				score,
				"{path:?} against {query:?} is the score class it stands for"
			);
		}
	}

	#[cfg(unix)]
	/// A scratch directory for one case.
	///
	/// The guard used to be declared here, one of eight identical copies across
	/// the workspace. `veyyon-test-scratch` owns the single implementation now.
	fn temp_dir_guard() -> veyyon_test_scratch::TempTree {
		veyyon_test_scratch::scratch_dir("natives-fd")
	}

	#[cfg(unix)]
	#[test]
	fn fuzzy_find_without_cache_follows_symlinked_directories() {
		let root = temp_dir_guard();
		let real_dir = root.path().join("zz-real-dir");
		let link_dir_name = "aa-linked-dir";
		let link_dir = root.path().join(link_dir_name);
		let file_name = "follow-links-fuzzy-needle.txt";

		fs::create_dir_all(&real_dir).expect("create real directory");
		fs::write(real_dir.join(file_name), "needle\n").expect("write symlink target file");
		unix_fs::symlink(&real_dir, &link_dir).expect("create directory symlink");

		let result = fuzzy_find_sync(
			FuzzyFindConfig {
				query:       file_name.to_string(),
				path:        root.path().to_string_lossy().into_owned(),
				hidden:      Some(true),
				gitignore:   Some(false),
				max_results: Some(4),
				cache:       Some(false),
			},
			task::CancelToken::default(),
		)
		.expect("fuzzy find succeeds");

		assert!(!result.matches.is_empty(), "expected at least one fuzzy find match");
		let expected_path = format!("{link_dir_name}/{file_name}");
		assert!(
			result
				.matches
				.iter()
				.any(|entry| entry.path == expected_path),
			"expected fuzzy find to include symlink traversal path {expected_path:?}, got {:?}",
			result
				.matches
				.iter()
				.map(|entry| entry.path.as_str())
				.collect::<Vec<_>>()
		);
	}

	#[cfg(unix)]
	#[test]
	fn fuzzy_find_ranks_shallow_paths_first_on_score_tie() {
		let root = temp_dir_guard();
		// Same-named directories at different depths all score identically
		// (exact basename match + directory bonus); the shallow one must win.
		fs::create_dir_all(root.path().join("scripts")).expect("create root scripts dir");
		fs::create_dir_all(root.path().join(".veyyon/skills/opt/scripts"))
			.expect("create hidden nested scripts dir");
		fs::create_dir_all(root.path().join("packages/ai/scripts"))
			.expect("create nested scripts dir");

		let result = fuzzy_find_sync(
			FuzzyFindConfig {
				query:       "scripts".to_string(),
				path:        root.path().to_string_lossy().into_owned(),
				hidden:      Some(true),
				gitignore:   Some(false),
				max_results: Some(10),
				cache:       Some(false),
			},
			task::CancelToken::default(),
		)
		.expect("fuzzy find succeeds");

		let paths: Vec<&str> = result
			.matches
			.iter()
			.map(|entry| entry.path.as_str())
			.collect();
		assert_eq!(
			paths.first(),
			Some(&"scripts/"),
			"expected cwd-root scripts/ to rank first, got {paths:?}"
		);
	}
}
