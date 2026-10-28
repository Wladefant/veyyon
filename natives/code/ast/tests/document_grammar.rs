//! A whole source file is matched under the grammar it parses with.
//!
//! WHY THIS SUITE EXISTS. Structural search and rewrite over files parsed PHP
//! with the PHP-only grammar, the one a pattern written without `<?php` needs.
//! A file that closes PHP with `?>` and continues as HTML is a syntax error to
//! that grammar: error recovery took 802ms on a 147KB plugin source the full
//! grammar parses in 14ms, the search missed calls after the HTML, and a
//! rewrite skipped the file for its error nodes. Files now parse under
//! `SupportLang::document_language` and their patterns are built by
//! `DocumentLang` out of the same grammar's node kinds, which differ from the
//! PHP-only grammar's for every kind after the HTML ones.
//!
//! THE CLASS IT CLOSES. Building a pattern out of one grammar and matching it
//! against a tree of another matches nothing, silently. The sweep fails when a
//! language other than PHP gets a file grammar of its own, because its patterns
//! need the same treatment PHP's got. The parity test pins that a pattern built
//! for files matches what the fragment pattern matched wherever both grammars
//! read the same code, across every strictness, with and without a selector,
//! and fails the same way when the pattern does not compile.
//!
//! WHAT IT DOES NOT CATCH. A PHP source where the grammars disagree, which is
//! every source with HTML in it; the addon's file search and rewrite tests
//! drive that case through the production path.

use std::collections::{BTreeMap, HashMap};

use ast_grep_core::{MatchStrictness, matcher::Pattern, tree_sitter::LanguageExt};
use veyyon_ast::{
	Grammar, SupportLang,
	ops::{AstMatchStrictness, compile_pattern},
};

/// Whether a language parses whole files with another grammar than its
/// patterns, judged by the node kinds the two grammars name.
fn has_a_file_grammar_of_its_own(lang: SupportLang) -> bool {
	let pattern = lang.get_ts_language();
	let file = lang.document_language();
	pattern.node_kind_count() != file.node_kind_count()
		|| (0..pattern.node_kind_count()).any(|id| {
			let id = u16::try_from(id).expect("a node kind id fits in u16");
			pattern.node_kind_for_id(id) != file.node_kind_for_id(id)
				|| pattern.node_kind_is_named(id) != file.node_kind_is_named(id)
		})
}

#[test]
fn only_php_parses_whole_files_with_another_grammar() {
	let split: Vec<SupportLang> = SupportLang::all_langs()
		.iter()
		.copied()
		.filter(|&lang| has_a_file_grammar_of_its_own(lang))
		.collect();
	assert_eq!(split, [SupportLang::Php]);
}

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

/// PHP both grammars read the same way: no `?>` anywhere.
const SOURCES: &[&str] = &[
	"<?php\nnamespace App;\n\nclass Store {\n    private array $items = [];\n\n    public function \
	 save($path) {\n        // persist the items\n        file_put_contents($path, \
	 json_encode($this->items));\n        $this->save();\n        echo \"saved\";\n        return \
	 new Result($path, 1);\n    }\n}\n",
	"<?php\nfunction render($items) {\n    if ($items) {\n        foreach ($items as $item) {\n          \
	 echo $item;\n        }\n    }\n    $total = count($items);\n    file_put_contents('log', \
	 $total);\n    return array($total, $items);\n}\n$cb = function ($x) use ($items) { return $x + 1; \
	 };\nfoo(); bar();\n",
	"<?php\n/* header */\n$a = 1;\n$b = $a . \"x\";\necho $a, $b;\n",
];

/// Patterns without a selector, including ones that do not compile.
const PATTERNS: &[&str] = &[
	"file_put_contents($$$ARGS);",
	"file_put_contents($A, $B)",
	"$X->save()",
	"echo $X;",
	"echo $$$XS;",
	"$a = $V;",
	"$X",
	"$$$",
	"function $F($$$P) { $$$B }",
	"if ($C) { $$$ }",
	"new $C($$$)",
	"array($$$)",
	"return $X;",
	"// persist the items",
	"\"saved\"",
	"foo(); bar();",
	"   ",
];

/// Patterns with the kind of node to take from them.
const CONTEXTUAL: &[(&str, &str)] = &[
	("$X->$M($$$A);", "member_call_expression"),
	("function f() { return $X; }", "return_statement"),
	("$a = $V;", "assignment_expression"),
	("foo(); bar();", "expression_statement"),
	("$X;", "no_such_kind"),
];

#[derive(Debug, PartialEq, Eq)]
struct Found {
	range: std::ops::Range<usize>,
	text:  String,
	env:   BTreeMap<String, String>,
}

fn find<L: Grammar>(lang: L, source: &str, pattern: &Pattern) -> Vec<Found> {
	let ast = lang.ast_grep(source);
	ast.root()
		.find_all(pattern.clone())
		.map(|found| Found {
			range: found.range(),
			text:  found.text().into_owned(),
			env:   HashMap::<String, String>::from(found.get_env().clone())
				.into_iter()
				.collect(),
		})
		.collect()
}

/// What a pattern does in each source: its matches, or why it did not compile.
fn outcome<L: Grammar>(
	lang: L,
	pattern: &str,
	selector: Option<&str>,
	strictness: &MatchStrictness,
) -> Result<Vec<Vec<Found>>, String> {
	let compiled =
		compile_pattern(pattern, selector, strictness, lang).map_err(|e| e.to_string())?;
	Ok(SOURCES
		.iter()
		.map(|source| find(lang, source, &compiled))
		.collect())
}

#[test]
fn a_file_pattern_matches_what_the_fragment_pattern_matches_in_php_both_grammars_read_alike() {
	for source in SOURCES {
		assert!(
			!SupportLang::Php
				.ast_grep(source)
				.root()
				.dfs()
				.any(|node| node.is_error()),
			"the PHP-only grammar must read this source without errors: {source}"
		);
	}
	let fragment = SupportLang::Php;
	let file = SupportLang::Php.document();
	let cases = PATTERNS.iter().map(|&pattern| (pattern, None)).chain(
		CONTEXTUAL
			.iter()
			.map(|&(pattern, selector)| (pattern, Some(selector))),
	);
	let mut matched = 0_usize;
	let mut failed = Vec::new();
	for (pattern, selector) in cases {
		for level in ALL_STRICTNESS {
			assert_eq!(ALL_STRICTNESS[listed(level)], level);
			let strictness = MatchStrictness::from(level);
			let expected = outcome(fragment, pattern, selector, &strictness);
			let actual = outcome(file, pattern, selector, &strictness);
			assert_eq!(actual, expected, "pattern {pattern:?}, selector {selector:?}, {level:?}");
			match expected {
				Ok(per_source) => matched += per_source.iter().map(Vec::len).sum::<usize>(),
				Err(_) => failed.push((pattern, selector)),
			}
		}
	}
	assert!(matched > 1000, "the corpus must exercise matching, matched {matched}");
	failed.dedup();
	assert_eq!(failed, [
		("$$$", None),
		("foo(); bar();", None),
		("   ", None),
		("$X;", Some("no_such_kind")),
	]);
}
