//! A source that lacks a pattern's required text holds no match of it.
//!
//! WHY THIS SUITE EXISTS. A structure search over a tree of three million PHP
//! files parsed every file to look for one call: 543 seconds, nearly all of it
//! spent on files that did not contain the call's name. A search now reads a
//! file and skips the parse when the file lacks the text of a named leaf of
//! every pattern (`RequiredText`). The skip rests on the matcher comparing a
//! named leaf with a node by text, a node's text being a slice of the source.
//!
//! THE CLASS IT CLOSES. Any language, strictness or pattern shape for which the
//! matcher accepts a node whose text is not the text of the pattern's named
//! leaf, which would make the skip drop a real match and report nothing. The
//! sweep derives its patterns from the sources themselves, every named node's
//! text and the same text with its first named leaf made a metavariable, so
//! each language is driven by patterns its own grammar produces. It runs every
//! pattern against every source under every strictness and fails when a source
//! with a match does not pass `is_in`. A language added to `all_langs` is swept
//! without an edit here, and a strictness added upstream fails to compile until
//! it is listed.
//!
//! WHAT IT DOES NOT CATCH. A text normalization in the matcher that none of the
//! sources or derived patterns exercise.

use std::{
	collections::BTreeSet,
	panic::{AssertUnwindSafe, catch_unwind},
};

use ast_grep_core::{MatchStrictness, matcher::Pattern, tree_sitter::LanguageExt};
use veyyon_ast::{
	SupportLang,
	ops::{AstMatchStrictness, compile_pattern},
	required_text::RequiredText,
};

const ALL_STRICTNESS: [AstMatchStrictness; 6] = [
	AstMatchStrictness::Cst,
	AstMatchStrictness::Smart,
	AstMatchStrictness::Ast,
	AstMatchStrictness::Relaxed,
	AstMatchStrictness::Signature,
	AstMatchStrictness::Template,
];

/// Fails to compile when a strictness is added and not listed above.
const fn listed(strictness: AstMatchStrictness) -> usize {
	match strictness {
		AstMatchStrictness::Cst => 0,
		AstMatchStrictness::Smart => 1,
		AstMatchStrictness::Ast => 2,
		AstMatchStrictness::Relaxed => 3,
		AstMatchStrictness::Signature => 4,
		AstMatchStrictness::Template => 5,
	}
}

/// Snippets in the shapes most grammars read: calls, assignments, blocks,
/// markup, data, queries and lists. Pairs differ in one token, a semicolon or
/// an argument, so a pattern from one meets a near miss in the other.
const SOURCES: &[&str] = &[
	"foo(bar, 1);\nfoo(baz);\n",
	"foo(bar, 1)\nfoo(baz)\n",
	"x = foo(y) + 2\nlet value = call(a, b)\n",
	"let value = call(a, b);\nconst other = call(a);\n",
	"def f(a):\n    return a + 1\n\nf(2)\n",
	"fn main() {\n    let v = foo(bar, 1);\n    println!(\"{v}\");\n}\n",
	"<div class=\"a\"><p>text</p></div>\n",
	"{\"key\": [1, 2], \"other\": {\"key\": true}}\n",
	"if (a) { b(); } else { c(1, \"s\"); }\n",
	"<?php\nfoo($a, $b);\n$x->save(1);\necho \"done\";\n",
	"key = \"value\"\n[section]\nother = 2\n",
	"SELECT a, b FROM t WHERE c = 1;\n",
	"(defun f (a) (+ a 1))\n(f 2)\n",
	"# Title\n\nSome *text* and `code`.\n",
];

/// Patterns taken from each language's own parse of the sources, spread over
/// the range of lengths so leaves, statements and whole blocks are all among
/// them.
const PATTERNS_PER_LANGUAGE: usize = 48;

fn is_identifier(text: &str) -> bool {
	let mut chars = text.chars();
	chars
		.next()
		.is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
		&& chars.all(|rest| rest.is_ascii_alphanumeric() || rest == '_')
}

/// Every named node's text in the sources, and each one again with its first
/// identifier leaf replaced by a metavariable.
fn derived_patterns(lang: SupportLang) -> Vec<String> {
	let mut texts = BTreeSet::new();
	for source in SOURCES {
		let ast = lang.document().ast_grep(*source);
		for node in ast.root().dfs().filter(|node| node.is_named()) {
			let text = node.text();
			let text = text.trim();
			if text.is_empty() || text.len() > 120 {
				continue;
			}
			texts.insert(text.to_string());
			let start = node.range().start;
			let leaf = node
				.dfs()
				.find(|leaf| leaf.is_named() && leaf.is_leaf() && is_identifier(&leaf.text()));
			if let Some(leaf) = leaf {
				let range = leaf.range();
				let original = node.text();
				let mut variant = String::with_capacity(original.len() + 2);
				variant.push_str(&original[..range.start - start]);
				variant.push_str("$A");
				variant.push_str(&original[range.end - start..]);
				texts.insert(variant.trim().to_string());
			}
		}
	}
	let mut texts: Vec<String> = texts.into_iter().collect();
	texts.sort_by(|left, right| left.len().cmp(&right.len()).then_with(|| left.cmp(right)));
	if texts.len() <= PATTERNS_PER_LANGUAGE {
		return texts;
	}
	(0..PATTERNS_PER_LANGUAGE)
		.map(|index| texts[index * texts.len() / PATTERNS_PER_LANGUAGE].clone())
		.collect()
}

/// Whether `pattern` matches anywhere in `root`, or `None` when the matcher
/// panics, which is an upstream defect the production search guards.
fn matches_in<D: ast_grep_core::Doc>(
	root: &ast_grep_core::AstGrep<D>,
	pattern: &Pattern,
) -> Option<bool> {
	catch_unwind(AssertUnwindSafe(|| root.root().find(pattern.clone()).is_some())).ok()
}

#[test]
fn a_source_a_pattern_matches_in_holds_its_required_text() {
	let mut violations = Vec::new();
	let mut uncompiled_languages = Vec::new();
	let mut matched_with_requirements = 0_usize;
	let mut matched_elsewhere = 0_usize;
	let mut ruled_out = 0_usize;
	for &lang in SupportLang::all_langs() {
		let document = lang.document();
		let trees: Vec<_> = SOURCES
			.iter()
			.map(|source| document.ast_grep(*source))
			.collect();
		let mut compiled_any = false;
		for text in derived_patterns(lang) {
			let Ok(compiled) = compile_pattern(&text, None, &MatchStrictness::Smart, document) else {
				continue;
			};
			compiled_any = true;
			let home: Vec<bool> = SOURCES
				.iter()
				.map(|source| source.contains(text.as_str()))
				.collect();
			for level in ALL_STRICTNESS {
				assert_eq!(ALL_STRICTNESS[listed(level)], level);
				let mut pattern = compiled.clone();
				pattern.strictness = MatchStrictness::from(level);
				let required = RequiredText::of(&pattern);
				for (index, (source, tree)) in SOURCES.iter().zip(&trees).enumerate() {
					let holds = required.is_in(source.as_bytes());
					if !holds {
						ruled_out += 1;
					}
					if matches_in(tree, &pattern) != Some(true) {
						continue;
					}
					if required.texts().next().is_some() {
						matched_with_requirements += 1;
						if !home[index] {
							matched_elsewhere += 1;
						}
					}
					if !holds {
						violations.push(format!(
							"{lang:?} {level:?}: pattern {text:?} matches in source {index} without {:?}",
							required
								.texts()
								.map(String::from_utf8_lossy)
								.collect::<Vec<_>>()
						));
					}
				}
			}
		}
		if !compiled_any {
			uncompiled_languages.push(lang);
		}
	}
	assert_eq!(violations, Vec::<String>::new());
	assert_eq!(uncompiled_languages, Vec::<SupportLang>::new());
	assert!(
		matched_with_requirements > 5_000,
		"the sweep must match patterns that require text, matched {matched_with_requirements}"
	);
	assert!(
		matched_elsewhere > 1_000,
		"the sweep must match patterns outside the source they came from, matched \
		 {matched_elsewhere}"
	);
	assert!(ruled_out > 50_000, "the sweep must rule sources out, ruled out {ruled_out}");
}

fn required(pattern: &str, lang: SupportLang, strictness: AstMatchStrictness) -> Vec<String> {
	let compiled = compile_pattern(pattern, None, &strictness.into(), lang.document())
		.unwrap_or_else(|err| panic!("{pattern:?} should compile: {err}"));
	RequiredText::of(&compiled)
		.texts()
		.map(|text| String::from_utf8_lossy(text).into_owned())
		.collect()
}

#[test]
fn a_pattern_requires_each_named_leaf_once_longest_first() {
	use AstMatchStrictness::Smart;
	use SupportLang::{Php, Rust, TypeScript};
	assert_eq!(required("foo(bar, 1)", TypeScript, Smart), ["bar", "foo", "1"]);
	assert_eq!(required("foo(foo)", TypeScript, Smart), ["foo"]);
	assert_eq!(required("foo(bar);", TypeScript, Smart), ["bar", "foo"]);
	assert_eq!(required("let total = compute(items);", Rust, Smart), ["compute", "items", "total"]);
	assert_eq!(required("unserialize($_COOKIE[$KEY])", Php, Smart), ["unserialize"]);
}

#[test]
fn a_metavariable_requires_nothing() {
	use AstMatchStrictness::Smart;
	use SupportLang::{Python, TypeScript};
	assert_eq!(required("$F(bar)", TypeScript, Smart), ["bar"]);
	assert_eq!(required("foo($$$ARGS)", TypeScript, Smart), ["foo"]);
	assert_eq!(required("$X", Python, Smart), Vec::<String>::new());
}

#[test]
fn a_signature_pattern_requires_nothing() {
	assert_eq!(
		required("foo(bar, 1)", SupportLang::TypeScript, AstMatchStrictness::Signature),
		Vec::<String>::new()
	);
	for level in ALL_STRICTNESS {
		if level != AstMatchStrictness::Signature {
			assert_eq!(
				required("foo(bar)", SupportLang::TypeScript, level),
				["bar", "foo"],
				"{level:?}"
			);
		}
	}
}

#[test]
fn a_source_must_hold_every_required_text() {
	let compiled = compile_pattern(
		"foo(bar)",
		None,
		&MatchStrictness::Smart,
		SupportLang::TypeScript.document(),
	)
	.expect("the pattern should compile");
	let required = RequiredText::of(&compiled);
	assert!(required.is_in(b"foo(bar)"));
	assert!(required.is_in(b"bar\nfoo"), "a required text is a substring, not a structure");
	assert!(!required.is_in(b"foo(baz)"));
	assert!(!required.is_in(b"fo(bar)"));
	assert!(!required.is_in(b""));
}
