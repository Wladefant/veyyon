use std::{borrow::Cow, io};

use grep_matcher::Matcher;
use grep_pcre2::{RegexMatcher as PcreMatcher, RegexMatcherBuilder as PcreMatcherBuilder};
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use regex_syntax::ast::{ErrorKind as AstErrorKind, parse::Parser as AstParser};

use crate::{CompiledMatcher, escape_literal_pattern, pcre_matcher_defaults};

/// The rule that fences the default engine's error off from PCRE2's, 79 tildes
/// wide, which is the width ripgrep 15.1.0 writes.
pub const ENGINE_ERROR_FENCE: &str =
	"~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~";

/// The report for a pattern NEITHER engine can compile, in ripgrep 15.1.0's
/// shape.
#[must_use]
pub fn both_engines_refused(rust: &str, pcre: &str) -> String {
	format!(
		"regex could not be compiled with either the default regex engine or with PCRE2.\n\ndefault \
		 regex engine error:\n{ENGINE_ERROR_FENCE}\n{rust}\n{ENGINE_ERROR_FENCE}\n\nPCRE2 regex \
		 engine error:\n{pcre}"
	)
}

/// Which regular expression engine to use.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Default)]
pub enum RegexEngine {
	#[default]
	Default,
	Pcre2,
	Auto,
}

/// Parameters for compiling a pattern into a matcher.
#[derive(Clone, Debug)]
pub struct MatcherSpec {
	pub case_insensitive:     bool,
	pub case_smart:           bool,
	pub word:                 bool,
	pub whole_line:           bool,
	pub fixed_strings:        bool,
	pub dot_matches_new_line: bool,
	pub crlf:                 bool,
	pub unicode:              bool,
	pub multi_line:           bool,
	pub line_terminator:      Option<u8>,
}
pub type MatcherFlags = MatcherSpec;

impl Default for MatcherSpec {
	fn default() -> Self {
		Self {
			case_insensitive:     false,
			case_smart:           false,
			word:                 false,
			whole_line:           false,
			fixed_strings:        false,
			dot_matches_new_line: false,
			crlf:                 false,
			unicode:              true,
			multi_line:           true,
			line_terminator:      None,
		}
	}
}

impl MatcherSpec {
	/// Build a `grep_regex::RegexMatcher` with these flags.
	pub fn build_rust_matcher(
		&self,
		patterns: &[String],
	) -> Result<RegexMatcher, grep_regex::Error> {
		let Self {
			case_insensitive,
			case_smart,
			word,
			whole_line,
			fixed_strings,
			dot_matches_new_line,
			crlf,
			unicode,
			multi_line,
			line_terminator,
		} = *self;
		let mut builder = RegexMatcherBuilder::new();
		builder
			.case_insensitive(case_insensitive)
			.case_smart(case_smart)
			.word(word)
			.whole_line(whole_line)
			.fixed_strings(fixed_strings)
			.multi_line(multi_line)
			.dot_matches_new_line(dot_matches_new_line)
			.unicode(unicode)
			.crlf(crlf);
		if let Some(terminator) = line_terminator {
			builder.line_terminator(Some(terminator));
		}
		builder.build_many(patterns)
	}

	/// Build a `grep_pcre2::RegexMatcher` with these flags.
	pub fn build_pcre_matcher(&self, patterns: &[String]) -> Result<PcreMatcher, String> {
		let Self {
			case_insensitive,
			case_smart,
			word,
			whole_line,
			fixed_strings,
			dot_matches_new_line,
			crlf,
			unicode,
			multi_line,
			line_terminator: _,
		} = *self;
		let mut builder = PcreMatcherBuilder::new();
		builder
			.caseless(case_insensitive)
			.case_smart(case_smart)
			.word(word)
			.whole_line(whole_line)
			.fixed_strings(fixed_strings)
			.multi_line(multi_line)
			.dotall(dot_matches_new_line)
			.crlf(crlf);
		pcre_matcher_defaults(&mut builder);
		if !unicode {
			crate::pcre_matcher_override_no_unicode(&mut builder);
		}
		builder
			.build_many(patterns)
			.map_err(|error| error.to_string())
	}

	/// Compile patterns into a [`CompiledMatcher`] according to the requested
	/// engine.
	pub fn build_matcher(
		&self,
		patterns: &[String],
		engine: RegexEngine,
	) -> Result<CompiledMatcher, String> {
		match engine {
			RegexEngine::Default => self
				.build_rust_matcher(patterns)
				.map(CompiledMatcher::Rust)
				.map_err(|error| error.to_string()),
			RegexEngine::Pcre2 => self.build_pcre_matcher(patterns).map(CompiledMatcher::Pcre),
			RegexEngine::Auto => match self.build_rust_matcher(patterns) {
				Ok(matcher) => Ok(CompiledMatcher::Rust(matcher)),
				Err(rust) => self
					.build_pcre_matcher(patterns)
					.map(CompiledMatcher::Pcre)
					.map_err(|pcre| both_engines_refused(&rust.to_string(), &pcre)),
			},
		}
	}
}

/// Check if `bytes[start]` (which must be `b'{'`) begins a valid repetition
/// quantifier: `{N}`, `{N,}`, or `{N,M}` where N and M are decimal digits.
#[must_use]
pub fn find_valid_repetition(bytes: &[u8], start: usize) -> Option<usize> {
	let len = bytes.len();
	let mut i = start + 1;
	if i >= len || !bytes[i].is_ascii_digit() {
		return None;
	}
	while i < len && bytes[i].is_ascii_digit() {
		i += 1;
	}
	if i >= len {
		return None;
	}
	if bytes[i] == b'}' {
		return Some(i);
	}
	if bytes[i] != b',' {
		return None;
	}
	i += 1;
	if i >= len {
		return None;
	}
	while i < len && bytes[i].is_ascii_digit() {
		i += 1;
	}
	if i < len && bytes[i] == b'}' {
		return Some(i);
	}
	None
}

#[must_use]
pub fn find_braced_escape_end(bytes: &[u8], start: usize) -> Option<usize> {
	let mut i = start + 1;
	while i < bytes.len() {
		if bytes[i] == b'}' {
			return Some(i);
		}
		i += 1;
	}
	None
}

/// Escape `{` and `}` that don't form valid repetition quantifiers.
#[must_use]
pub fn sanitize_braces(pattern: &str) -> Cow<'_, str> {
	let bytes = pattern.as_bytes();
	if !bytes.contains(&b'{') && !bytes.contains(&b'}') {
		return Cow::Borrowed(pattern);
	}

	let len = bytes.len();
	let mut result = String::with_capacity(len + 8);
	let mut modified = false;
	let mut i = 0;

	while i < len {
		if bytes[i] == b'\\' && i + 1 < len {
			result.push('\\');
			i += 1;
			let ch = pattern[i..]
				.chars()
				.next()
				.expect("non-empty slice has a char");
			result.push(ch);
			i += ch.len_utf8();
			if matches!(ch, 'p' | 'P' | 'x' | 'u') && i < len && bytes[i] == b'{' {
				if let Some(end) = find_braced_escape_end(bytes, i) {
					result.push_str(&pattern[i..=end]);
					i = end + 1;
				} else {
					result.push_str(&pattern[i..]);
					i = len;
				}
			}
			continue;
		}

		if bytes[i] == b'{' {
			if let Some(end) = find_valid_repetition(bytes, i) {
				result.push_str(&pattern[i..=end]);
				i = end + 1;
				continue;
			}
			result.push_str("\\{");
			i += 1;
			modified = true;
			continue;
		}

		if bytes[i] == b'}' {
			result.push_str("\\}");
			i += 1;
			modified = true;
			continue;
		}

		let ch = pattern[i..]
			.chars()
			.next()
			.expect("non-empty slice has a char");
		result.push(ch);
		i += ch.len_utf8();
	}

	if modified {
		Cow::Owned(result)
	} else {
		Cow::Borrowed(pattern)
	}
}

/// Escape the parentheses that cannot pair, after a group-syntax regex error.
///
/// A `(` with no later `)` and a `)` with no earlier open `(` are escaped. A
/// balanced pair stays a group, so `(get|set)Value(` keeps its alternation and
/// matches `getValue(` rather than the text `(get` or `set)Value(`. Escaped
/// parentheses and parentheses inside a character class are literal already
/// and are left as written.
#[must_use]
pub fn escape_unbalanced_parentheses(pattern: &str) -> Cow<'_, str> {
	// Byte scan: every byte compared below is ASCII, and the bytes of a
	// multi-byte character are all >= 0x80, so none of them is mistaken for one
	// and every recorded offset is a character boundary.
	let bytes = pattern.as_bytes();
	let mut open = Vec::new();
	let mut stray = Vec::new();
	let mut class_depth = 0usize;
	let mut i = 0;
	while i < bytes.len() {
		match bytes[i] {
			b'\\' => {
				i += 2;
				continue;
			},
			b'[' => {
				class_depth += 1;
				i += 1;
				// A `]` first in a class, after an optional `^`, is a member.
				if bytes.get(i) == Some(&b'^') {
					i += 1;
				}
				if bytes.get(i) == Some(&b']') {
					i += 1;
				}
				continue;
			},
			b']' if class_depth > 0 => class_depth -= 1,
			b'(' if class_depth == 0 => open.push(i),
			// The guard pops the `(` this `)` closes; with none open, it is stray.
			b')' if class_depth == 0 && open.pop().is_none() => stray.push(i),
			_ => {},
		}
		i += 1;
	}
	stray.extend(open);
	if stray.is_empty() {
		return Cow::Borrowed(pattern);
	}
	stray.sort_unstable();

	let mut result = String::with_capacity(pattern.len() + stray.len());
	let mut copied = 0;
	for at in stray {
		result.push_str(&pattern[copied..at]);
		result.push('\\');
		copied = at;
	}
	result.push_str(&pattern[copied..]);
	Cow::Owned(result)
}

/// Compile a single pattern with automatic sanitization, fallback to PCRE2,
/// paren retry, and demotion to literal search.
///
/// Returns `(CompiledMatcher, Option<notice>)` where `Some(notice)` means
/// the pattern was demoted to literal text search because both engines rejected
/// it.
pub fn compile_with_demotion(
	pattern: &str,
	ignore_case: bool,
	multiline: bool,
) -> Result<(CompiledMatcher, Option<String>), String> {
	// grep-regex parses a pattern inside `(?:…)`, so a pattern that closes a
	// group it never opened pairs with that wrapper: `)(` compiles as `(?:)()`
	// and matches every line. Parsing the pattern alone first rejects it as it
	// is written. The error carries whether the fault is an unpaired group,
	// which is the one fault the retry below repairs.
	let build_rust = |pat: &str| -> Result<RegexMatcher, (String, bool)> {
		if let Err(err) = AstParser::new().parse(pat) {
			let group_fault =
				matches!(err.kind(), AstErrorKind::GroupUnclosed | AstErrorKind::GroupUnopened);
			return Err((err.to_string(), group_fault));
		}
		let build = |line_terminated| {
			let mut builder = RegexMatcherBuilder::new();
			builder.case_insensitive(ignore_case).multi_line(multiline);
			if line_terminated {
				builder.line_terminator(Some(b'\n'));
			}
			builder.build(pat)
		};
		if !multiline && let Ok(matcher) = build(true) {
			return Ok(matcher);
		}
		build(false).map_err(|err| (err.to_string(), false))
	};

	let build_pcre = |pat: &str| {
		let mut builder = PcreMatcherBuilder::new();
		builder.caseless(ignore_case).multi_line(multiline);
		pcre_matcher_defaults(&mut builder);
		builder.build(pat)
	};

	let sanitized = sanitize_braces(pattern);
	let (message, group_fault) = match build_rust(sanitized.as_ref()) {
		Ok(matcher) => return Ok((CompiledMatcher::Rust(matcher), None)),
		Err(err) => err,
	};

	// A group fault is a parenthesis fault in syntax both engines share: Rust
	// reports PCRE2-only syntax (look-around, `\Q`, `(?>`, `(*VERB)`) as a
	// different fault at its own position. PCRE2 therefore rejects the pattern
	// as written too, and only accepts it by pairing the stray `)` with the
	// `(?:…)` grep-pcre2 wraps it in, so it is not asked.
	if !group_fault && let Ok(matcher) = build_pcre(sanitized.as_ref()) {
		return Ok((CompiledMatcher::Pcre(matcher), None));
	}

	if group_fault {
		let escaped = escape_unbalanced_parentheses(sanitized.as_ref());
		if escaped.as_ref() != sanitized.as_ref() {
			match build_rust(escaped.as_ref()) {
				Ok(matcher) => return Ok((CompiledMatcher::Rust(matcher), None)),
				Err((_, false)) => {
					if let Ok(matcher) = build_pcre(escaped.as_ref()) {
						return Ok((CompiledMatcher::Pcre(matcher), None));
					}
				},
				Err((_, true)) => {},
			}
		}
	}

	build_rust(&escape_literal_pattern(pattern))
		.map(|matcher| (CompiledMatcher::Rust(matcher), Some(message.clone())))
		.map_err(|_| message)
}

/// Collect all match spans on `line` in order.
pub fn match_spans<M: Matcher>(
	matcher: &M,
	line: &[u8],
	out: &mut Vec<grep_matcher::Match>,
) -> io::Result<()> {
	out.clear();
	matcher
		.find_iter(line, |span| {
			out.push(span);
			true
		})
		.map_err(|error| io::Error::other(error.to_string()))
}

/// Strip trailing record terminator from `bytes`.
#[must_use]
pub fn strip_record_terminator(bytes: &[u8], terminator: u8) -> &[u8] {
	if bytes.last().copied() == Some(terminator) {
		&bytes[..bytes.len() - 1]
	} else {
		bytes
	}
}
