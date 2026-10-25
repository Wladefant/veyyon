//! A pattern rejected for an unpaired parenthesis is retried with that
//! parenthesis escaped, and with nothing else changed.
//!
//! Two defects produced a search for a pattern nobody wrote, with no notice.
//! The retry escaped every unescaped parenthesis, so `(get|set)Value(` compiled
//! as `\(get|set\)Value\(`, whose top-level alternation matches the text `(get`
//! or `set)Value(` and misses `getValue(`. And grep-regex and grep-pcre2 both
//! parse a pattern inside `(?:…)`, so a `)` with no open group paired with that
//! wrapper: `)(` compiled as `(?:)()` and matched every line, and `a)|(b`
//! matched any `a` or `b`, without reaching the retry at all.
//!
//! The class closed here: any compile of a pattern with an unpaired parenthesis
//! that changes a parenthesis which pairs, or pairs one with text outside the
//! pattern. The table pins the exact rewrite and its matches for each place a
//! pair can sit (before, after and around the stray one, nested,
//! non-capturing), for each place a parenthesis is literal already (escaped,
//! inside a class, a `]` leading a class), and for each way a stray `)` can
//! close the wrapper. The sweep enumerates every pattern over `( ) a |` up to
//! six characters and asserts that the retry repairs it into a regex rather
//! than demoting it to a literal, inserts only backslashes, inserts the minimum
//! number of them, and that the compiled matcher agrees with the rewrite.
//!
//! Not caught: which of two equally short repairs is chosen when a stray `(`
//! sits inside a run of opens, beyond the table rows; patterns that combine a
//! parenthesis fault with a second syntax fault, which fall to the literal
//! search and its notice; and PCRE2-only syntax such as `\Q..\E`, whose quoted
//! parentheses are scanned as if unquoted.

use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use veyyon_grep_kernel::{compile_with_demotion, escape_unbalanced_parentheses};

/// `(pattern, rewrite, lines it matches, lines it misses)`.
const CASES: &[(&str, &str, &[&str], &[&str])] = &[
	("fetchAnthropicProvider(", r"fetchAnthropicProvider\(", &["fetchAnthropicProvider(x)"], &[
		"fetchAnthropicProvider",
	]),
	("foo.*(bar", r"foo.*\(bar", &["fooXYZ(bar"], &["foobar"]),
	("(get|set)Value(", r"(get|set)Value\(", &["getValue(1)", "setValue(2)"], &[
		"(get marker",
		"set)Value( marker",
	]),
	("x)(get|set)Value", r"x\)(get|set)Value", &["x)getValue", "x)setValue"], &[
		"set)Value",
		"getValue",
	]),
	("((a|b)c", r"\((a|b)c", &["(ac", "(bc"], &["ac", "bc"]),
	("(?:get|set)Value(", r"(?:get|set)Value\(", &["getValue(", "setValue("], &["getValue"]),
	(r"\((a|b)(", r"\((a|b)\(", &["(a(", "(b("], &["a(", "(ab"]),
	("[(]x(", r"[(]x\(", &["(x("], &["(x", "x("]),
	("[](]a)", r"[](]a\)", &["(a)", "]a)"], &["(a", "a)"]),
	("[^](]a)", r"[^](]a\)", &["xa)"], &["(a)", "]a)"]),
	("[]()]a(", r"[]()]a\(", &[")a(", "]a("], &[")a", "a("]),
	("[^)]a)", r"[^)]a\)", &["za)"], &[")a)"]),
	(")(", r"\)\(", &[")("], &["()", "none"]),
	("a)|(b", r"a\)|\(b", &["a)", "(b"], &["a", "b", "ab"]),
	// Rust cannot compile the look-ahead, so the repaired pattern goes to PCRE2.
	(")(?=a)a(", r"\)(?=a)a\(", &[")a("], &[")b(", "a(", ")a"]),
	("é(", r"é\(", &["é("], &["é"]),
];

fn matches(matcher: &impl Matcher, line: &str) -> bool {
	matcher
		.is_match(line.as_bytes())
		.unwrap_or_else(|err| panic!("matching {line:?} failed: {err}"))
}

#[test]
fn the_retry_escapes_only_the_parenthesis_that_cannot_pair() {
	for &(pattern, rewrite, hits, misses) in CASES {
		assert_eq!(
			escape_unbalanced_parentheses(pattern).as_ref(),
			rewrite,
			"rewrite of `{pattern}`"
		);
		let (matcher, notice) = compile_with_demotion(pattern, false, false)
			.unwrap_or_else(|err| panic!("`{pattern}` should be repaired, got: {err}"));
		assert_eq!(notice, None, "`{pattern}` was repaired into a regex, not demoted to a literal");
		for line in hits {
			assert!(matches(&matcher, line), "`{pattern}` should match {line:?}");
		}
		for line in misses {
			assert!(!matches(&matcher, line), "`{pattern}` should not match {line:?}");
		}
	}
}

#[test]
fn a_pattern_whose_parentheses_all_pair_is_returned_as_written() {
	for pattern in ["fetchAnthropicProvider()", "(a|(b))c", r"\(", r"a\)b", "[(]", "[]()]", "[^)]"] {
		let rewrite = escape_unbalanced_parentheses(pattern);
		assert!(
			matches!(rewrite, std::borrow::Cow::Borrowed(_)),
			"`{pattern}` has no unpaired parenthesis but rewrote to `{rewrite}`"
		);
	}
}

/// Every string over `alphabet` of length one to `max_len`.
fn strings_over(alphabet: &[char], max_len: usize) -> Vec<String> {
	let mut all = Vec::new();
	let mut layer = vec![String::new()];
	for _ in 0..max_len {
		layer = layer
			.iter()
			.flat_map(|prefix| {
				alphabet.iter().map(move |ch| {
					let mut next = prefix.clone();
					next.push(*ch);
					next
				})
			})
			.collect();
		all.extend(layer.iter().cloned());
	}
	all
}

/// The fewest parentheses that must be escaped to balance `pattern`, which has
/// no escapes and no classes: every `)` without an open `(` before it, plus
/// every `(` left open at the end.
fn unpaired_count(pattern: &str) -> usize {
	let (mut open, mut stray) = (0usize, 0usize);
	for ch in pattern.chars() {
		match ch {
			'(' => open += 1,
			')' if open > 0 => open -= 1,
			')' => stray += 1,
			_ => {},
		}
	}
	open + stray
}

#[test]
fn every_parenthesis_fault_is_repaired_with_the_fewest_escapes() {
	let patterns = strings_over(&['(', ')', 'a', '|'], 6);
	assert_eq!(patterns.len(), 4 + 16 + 64 + 256 + 1024 + 4096);
	let mut haystacks = strings_over(&['(', ')', 'a'], 3);
	haystacks.push(String::new());
	for pattern in &patterns {
		let rewrite = escape_unbalanced_parentheses(pattern);
		assert_eq!(
			rewrite.replace('\\', ""),
			*pattern,
			"`{pattern}` rewrote to `{rewrite}`, which changes more than escapes"
		);
		assert_eq!(
			rewrite.matches('\\').count(),
			unpaired_count(pattern),
			"`{pattern}` rewrote to `{rewrite}`"
		);
		let (compiled, notice) = compile_with_demotion(pattern, false, false)
			.unwrap_or_else(|err| panic!("`{pattern}` should compile, got: {err}"));
		assert_eq!(notice, None, "`{pattern}` has only a parenthesis fault and must stay a regex");
		// The rewrite pairs every parenthesis it leaves, so compiling it directly
		// is the meaning the repaired pattern has to keep.
		let reference = RegexMatcherBuilder::new()
			.build(&rewrite)
			.unwrap_or_else(|err| panic!("rewrite `{rewrite}` of `{pattern}` should compile: {err}"));
		for hay in &haystacks {
			assert_eq!(
				matches(&compiled, hay),
				matches(&reference, hay),
				"`{pattern}` and its rewrite `{rewrite}` disagree on {hay:?}"
			);
		}
	}
}
