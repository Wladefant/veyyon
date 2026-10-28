//! The walk depth bound must never be shallower than something the pattern
//! matches.
//!
//! WHAT THE BOUND IS FOR. A walk-relative glob compiles with
//! `literal_separator(true)`, so `*` and `?` cannot cross a `/`. A pattern with
//! N segments can then only match entries N components deep,
//! and `walk_depth_bound` tells the walker to stop there. That is what keeps
//! `dir/*.json` from descending through an entire subtree it can never match
//! into.
//!
//! WHY A WRONG BOUND IS THE WORST KIND OF BUG HERE. The walker prunes at the
//! bound, so a bound that is too shallow means directories are never visited
//! and their matches are never reported. Nothing errors, nothing is logged, and
//! the caller cannot tell a search that found three matches from one that found
//! three of five. It is a silent recall loss, and it is invisible in exactly
//! the case that matters: a large tree where nobody counts the results by hand.
//!
//! THE BUG. `literal_separator` governs `*` and `?`. It does NOT govern a
//! character class, which matches whatever it lists, `/` included. `[,-[]`
//! spans 0x2C..=0x5B and `/` is 0x2F, so `"*?[?!*?[?!,-[]?*"` matches
//! `"b/~0ba"` two components deep while its segment count says one.
//! Found by `tests/fuzz/fuzz_targets/glob_patterns.rs`, whose property is
//! exactly the one this file states: whatever the pattern matches, the walk
//! must be able to reach.
//!
//! THE RULE NOW. A pattern whose bracket class can match `/` is unbounded.
//! Ambiguity answers "can", because that answer only ever removes an
//! optimization while the other one loses results.
//!
//! ALTERNATION. A `{a,b}` group used to disable the bound outright, so
//! `source-cache/{plugins.json,pairs/manifest.json}` walked six million
//! entries to find two files at depth two and timed out. A group now counts
//! as its deepest alternative. The sweep below draws patterns from group
//! syntax, classes and escapes, expands every alternative into a concrete path
//! the engine itself must match, and requires the bound to reach it. It does
//! not cover `\` as a separator on Windows, which a walk-relative pattern never
//! holds because `build_glob_pattern` rewrites it to `/` first.

use veyyon_glob::{compile_glob, walk_depth_bound};

/// The bound as the walker uses it, against what the compiled pattern really
/// matches.
fn assert_bound_reaches(pattern: &str, path: &str) {
	let compiled = compile_glob(pattern, false).expect("the pattern under test must compile");
	assert!(compiled.is_match(path), "sanity: {pattern:?} is supposed to match {path:?}");

	let bound = walk_depth_bound(pattern);
	if bound == usize::MAX {
		return;
	}
	let depth = path.split('/').filter(|seg| !seg.is_empty()).count().max(1);
	assert!(
		depth <= bound,
		"{pattern:?} matches {path:?} at depth {depth} but bounds the walk at {bound}, so the \
		 walker would never reach it",
	);
}

mod a_class_that_can_match_a_separator {
	use super::*;

	/// THE regression, as the fuzzer reduced it.
	#[test]
	fn the_fuzzers_pattern_is_unbounded() {
		assert_eq!(walk_depth_bound("*?[?!*?[?!,-[]?*"), usize::MAX);
		assert_bound_reaches("*?[?!*?[?!,-[]?*", "b/~0ba");
	}

	/// A range that straddles `/` is the general form of it.
	///
	/// `.` is 0x2E and `0` is 0x30, so `[.-0]` contains `/` without naming it,
	/// which is why checking for a literal `/` in the class is not enough.
	#[test]
	fn a_range_that_straddles_the_separator_is_unbounded() {
		assert_eq!(walk_depth_bound("a[.-0]b"), usize::MAX);
		// `[!-9]` reads as a NEGATED class holding `-` and `9`, not as a range from
		// `!`, because a leading `!` is the negation marker. Either reading is
		// unbounded, and the test says which one the code takes so a future change to
		// the parse is a visible decision.
		assert_eq!(walk_depth_bound("a[!-9]b"), usize::MAX);
	}

	/// A class that names the separator outright.
	#[test]
	fn a_class_listing_the_separator_is_unbounded() {
		assert_eq!(walk_depth_bound("a[/]b"), usize::MAX);
		assert_eq!(walk_depth_bound("a[xy/z]b"), usize::MAX);
	}

	/// A negated class matches everything it does not list, which includes `/`.
	///
	/// Reasoning about the complement would mean deciding whether `/` is among
	/// the excluded characters, and nothing writes `[^/]` by accident. Treating
	/// every negation as unbounded costs one optimization and cannot lose a
	/// match.
	#[test]
	fn a_negated_class_is_unbounded() {
		assert_eq!(walk_depth_bound("a[!xyz]b"), usize::MAX);
		assert_eq!(walk_depth_bound("a[^xyz]b"), usize::MAX);
	}

	/// An unterminated class is not understood, so it is not bounded.
	#[test]
	fn an_unterminated_class_is_unbounded() {
		assert_eq!(walk_depth_bound("a[xyz"), usize::MAX);
		assert_eq!(walk_depth_bound("src/[0-9"), usize::MAX);
	}

	/// An escaped separator inside a class still matches a separator.
	#[test]
	fn an_escaped_separator_inside_a_class_is_unbounded() {
		assert_eq!(walk_depth_bound("a[x\\/y]b"), usize::MAX);
	}
}

mod a_class_that_cannot {
	use super::*;

	/// The common cases keep their bound, which is the whole point of having
	/// one.
	///
	/// If every class disabled the bound, `src/[0-9]*.log` would walk an entire
	/// tree again and the timeouts the bound was written for would come back.
	#[test]
	fn an_ordinary_class_keeps_its_segment_count() {
		assert_eq!(walk_depth_bound("[0-9].ts"), 1);
		assert_eq!(walk_depth_bound("src/[0-9]*.log"), 2);
		assert_eq!(walk_depth_bound("a/b/[abc]d/e.rs"), 4);
	}

	/// A range entirely above or below `/` is fine.
	#[test]
	fn a_range_that_misses_the_separator_keeps_its_bound() {
		assert_eq!(walk_depth_bound("x[0-9]y"), 1);
		assert_eq!(walk_depth_bound("x[a-z]y"), 1);
		// A range that stops one byte short of `/`: `#` is 0x23 and `.` is 0x2E.
		assert_eq!(walk_depth_bound("x[#-.]y"), 1);
		// And one that starts one byte past it: `0` is 0x30.
		assert_eq!(walk_depth_bound("x[0-;]y"), 1);
	}

	/// A literal `]` first in the class does not end it, and the rest is still
	/// read.
	#[test]
	fn a_leading_bracket_is_a_literal_and_the_class_still_ends() {
		assert_eq!(walk_depth_bound("x[]ab]y"), 1);
		assert_eq!(walk_depth_bound("x[]/]y"), usize::MAX);
	}

	/// A trailing `-` is a literal, not the start of a range.
	#[test]
	fn a_trailing_dash_is_a_literal() {
		assert_eq!(walk_depth_bound("x[ab-]y"), 1);
	}

	/// An escaped `[` is not a class at all.
	#[test]
	fn an_escaped_bracket_opens_nothing() {
		assert_eq!(walk_depth_bound("a\\[bc"), 1);
		assert_eq!(walk_depth_bound("src/a\\[b/c.ts"), 3);
	}
}

mod the_rest_of_the_bound_is_unchanged {
	use super::*;

	/// `**` still disables it, inside a group or out.
	#[test]
	fn globstar_stays_unbounded() {
		assert_eq!(walk_depth_bound("**/*.ts"), usize::MAX);
		assert_eq!(walk_depth_bound("src/**"), usize::MAX);
		assert_eq!(walk_depth_bound("{**/a,b}/c.ts"), usize::MAX);
	}

	/// A plain pattern is its segment count, never zero.
	#[test]
	fn a_plain_pattern_counts_its_segments() {
		assert_eq!(walk_depth_bound("*.ts"), 1);
		assert_eq!(walk_depth_bound("src/*.ts"), 2);
		assert_eq!(walk_depth_bound("/"), 1);
		assert_eq!(walk_depth_bound(""), 1);
	}

	/// And the bound holds for the patterns it is supposed to bound.
	#[test]
	fn a_bounded_pattern_reaches_everything_it_matches() {
		for (pattern, path) in
			[("*.ts", "a.ts"), ("src/*.ts", "src/a.ts"), ("src/[0-9]*.log", "src/1x.log")]
		{
			assert_bound_reaches(pattern, path);
		}
	}
}

mod an_alternation_reaches_its_deepest_alternative {
	use globset::{GlobBuilder, GlobMatcher};

	use super::*;

	/// The shape that timed out: literal names in one group, one of them a
	/// level deeper than the rest.
	#[test]
	fn a_group_of_literal_paths_reaches_its_deepest_member() {
		let pattern = "{plugins.json,pairs/manifest.json,scan.py}";
		assert_eq!(walk_depth_bound(pattern), 2);
		for path in ["plugins.json", "pairs/manifest.json", "scan.py"] {
			assert_bound_reaches(pattern, path);
		}
	}

	/// The engine as the walker compiles it. Not `compile_glob`, which
	/// rewrites `\` to `/` before it compiles.
	fn engine(pattern: &str) -> Option<GlobMatcher> {
		let glob = GlobBuilder::new(pattern)
			.literal_separator(true)
			.build()
			.ok()?;
		Some(glob.compile_matcher())
	}

	fn assert_engine_reaches(pattern: &str, path: &str, depth: usize) {
		let matcher = engine(pattern).unwrap_or_else(|| panic!("{pattern:?} compiles"));
		assert!(matcher.is_match(path), "the engine matches {path:?} with {pattern:?}");
		assert_eq!(path.split('/').count(), depth);
		assert_eq!(walk_depth_bound(pattern), depth);
	}

	/// A class the engine closes at its first `]` must not hide the `{` that
	/// follows. Reading `\` inside a class as an escape keeps the class open
	/// across `{a]`, splits the alternative at the inner group's `,`, and
	/// bounds the walk short of the depth-six match.
	#[cfg(unix)]
	#[test]
	fn a_backslash_inside_a_class_does_not_hide_a_group() {
		assert_engine_reaches("{b/b/[\\]{a],b/b/b/a}a}", "b/b/\\b/b/b/aa", 6);
	}

	/// A `]` first in a class is a member, so `[]{]` and `[]}]` are classes
	/// and the `,` between them is a literal at the top level. Closing either
	/// class at its first `]` turns the braces into a group whose
	/// alternatives are measured apart, one level short of the match.
	#[test]
	fn a_leading_bracket_in_a_class_does_not_open_a_group() {
		assert_engine_reaches("[]{]b/b,b/b[]}]", "{b/b,b/b}", 3);
	}

	/// Pattern pieces, each with the text a match puts where it stands.
	/// `None` marks group syntax.
	const TOKENS: &[(&str, Option<&str>)] = &[
		("a", Some("a")),
		("b/", Some("b/")),
		("/", Some("/")),
		("*", Some("x")),
		("?", Some("q")),
		("]", Some("]")),
		("\\{", Some("{")),
		("\\,", Some(",")),
		("[,}]", Some(",")),
		("[\\]", Some("\\")),
		("[]{]", Some("{")),
		("[]}]", Some("}")),
		("[],]", Some(",")),
		("{", None),
		(",", None),
		("}", None),
	];

	/// A pattern as nested groups: each alternative is a sequence of literal
	/// text and groups.
	enum Piece {
		Text(&'static str),
		Group(Vec<Vec<Self>>),
	}

	/// Build the tree for a token sequence, or `None` when its braces do not
	/// balance. A `,` outside every group is literal, as the engine reads it.
	fn parse(tokens: &[usize]) -> Option<Vec<Piece>> {
		let mut stack: Vec<Vec<Vec<Piece>>> = vec![vec![Vec::new()]];
		for &token in tokens {
			let (text, instance) = TOKENS[token];
			match (text, instance) {
				(_, Some(instance)) => stack.last_mut()?.last_mut()?.push(Piece::Text(instance)),
				("{", None) => stack.push(vec![Vec::new()]),
				(",", None) if stack.len() == 1 => stack[0][0].push(Piece::Text(",")),
				(",", None) => stack.last_mut()?.push(Vec::new()),
				(_, None) => {
					if stack.len() == 1 {
						return None;
					}
					let group = stack.pop()?;
					stack.last_mut()?.last_mut()?.push(Piece::Group(group));
				},
			}
		}
		if stack.len() != 1 {
			return None;
		}
		stack.pop()?.pop()
	}

	/// Every concrete path the sequence expands to, or `None` past `cap`.
	///
	/// The engine drops an alternative that compiles to nothing (`{a,}`
	/// matches `a` and never the empty string), and a group left with no
	/// alternative matches the empty string. Every text piece is non-empty, so
	/// an alternative compiles to nothing exactly when it expands to `[""]`.
	fn expand(sequence: &[Piece], cap: usize) -> Option<Vec<String>> {
		let mut paths = vec![String::new()];
		for piece in sequence {
			paths = match piece {
				Piece::Text(text) => paths.into_iter().map(|path| path + text).collect(),
				Piece::Group(alternatives) => {
					let mut tails = Vec::new();
					for alternative in alternatives {
						let expanded = expand(alternative, cap)?;
						if expanded != [""] {
							tails.extend(expanded);
						}
					}
					if tails.is_empty() {
						tails.push(String::new());
					}
					let mut joined = Vec::new();
					for path in &paths {
						for tail in &tails {
							joined.push(format!("{path}{tail}"));
						}
					}
					joined
				},
			};
			if paths.len() > cap {
				return None;
			}
		}
		Some(paths)
	}

	/// Deterministic draws, so a failure reproduces.
	struct SplitMix(u64);

	impl SplitMix {
		const fn below(&mut self, bound: usize) -> usize {
			self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
			let mut z = self.0;
			z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
			z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
			((z ^ (z >> 31)) % bound as u64) as usize
		}
	}

	/// Tokens the engine reads as the sweep does. Windows reads `\` as a
	/// separator, not an escape, so a token carrying one is drawn on Unix only.
	fn drawable_tokens() -> Vec<usize> {
		(0..TOKENS.len())
			.filter(|&token| !cfg!(windows) || !TOKENS[token].0.contains('\\'))
			.collect()
	}

	#[test]
	fn every_alternative_of_a_drawn_pattern_is_reachable() {
		let mut rng = SplitMix(0x5eed0fa17e57);
		let drawable = drawable_tokens();
		let mut bounded_groups = 0;
		for _ in 0..60_000 {
			let length = 1 + rng.below(12);
			let tokens: Vec<usize> = (0..length)
				.map(|_| drawable[rng.below(drawable.len())])
				.collect();
			let pattern: String = tokens.iter().map(|&token| TOKENS[token].0).collect();
			let bound = walk_depth_bound(&pattern);
			if bound == usize::MAX {
				continue;
			}
			let Some(matcher) = engine(&pattern) else {
				continue;
			};
			let tree = parse(&tokens).unwrap_or_else(|| {
				panic!("the engine compiles {pattern:?} but the sweep cannot parse it")
			});
			let Some(paths) = expand(&tree, 512) else {
				continue;
			};
			if tokens.iter().any(|&token| TOKENS[token].0 == "{") {
				bounded_groups += 1;
			}
			for path in paths {
				if path.is_empty()
					|| path.starts_with('/')
					|| path.ends_with('/')
					|| path.contains("//")
				{
					continue;
				}
				assert!(
					matcher.is_match(&path),
					"the sweep reads {pattern:?} as matching {path:?} and the engine does not"
				);
				let depth = path.split('/').count();
				assert!(
					depth <= bound,
					"{pattern:?} matches {path:?} at depth {depth} but bounds the walk at {bound}"
				);
			}
		}
		assert!(bounded_groups > 1_000, "only {bounded_groups} drawn patterns held a bounded group");
	}
}
