//! The text a source must contain before a pattern can match anywhere in it.
//!
//! The matcher compares a named leaf of the pattern (an identifier, a literal,
//! a name) with a node of the source by kind and by text, and no strictness but
//! `Signature` lets it skip one. A node's text is a slice of the source, so a
//! source that does not contain the text of every named leaf holds no match,
//! and a search can tell that with a substring scan instead of a parse.
//!
//! Unnamed leaves (punctuation, keywords) are not required: the matcher
//! compares only their kind, and `Ast` and `Relaxed` skip them. A metavariable
//! matches any text. `Signature` compares kinds alone, so it requires nothing.

use ast_grep_core::{
	MatchStrictness,
	matcher::{Pattern, PatternNode},
};
use memchr::memmem::Finder;

/// The texts every match of one pattern contains.
pub struct RequiredText {
	/// Longest first: a longer text occurs in fewer sources, so a source that
	/// cannot match is usually ruled out by the first scan.
	finders: Vec<Finder<'static>>,
}

impl RequiredText {
	#[must_use]
	pub fn of(pattern: &Pattern) -> Self {
		let mut texts = Vec::new();
		if !matches!(pattern.strictness, MatchStrictness::Signature) {
			collect_named_leaf_texts(&pattern.node, &mut texts);
		}
		texts.sort_unstable_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
		texts.dedup();
		Self {
			finders: texts
				.into_iter()
				.map(|text| Finder::new(text.as_bytes()).into_owned())
				.collect(),
		}
	}

	/// Whether the pattern can match anywhere in `source`.
	#[must_use]
	pub fn is_in(&self, source: &[u8]) -> bool {
		self
			.finders
			.iter()
			.all(|finder| finder.find(source).is_some())
	}

	/// The required texts, longest first.
	pub fn texts(&self) -> impl Iterator<Item = &[u8]> {
		self.finders.iter().map(Finder::needle)
	}
}

fn collect_named_leaf_texts<'p>(node: &'p PatternNode, texts: &mut Vec<&'p str>) {
	match node {
		PatternNode::Terminal { text, is_named: true, .. } if !text.is_empty() => texts.push(text),
		PatternNode::Terminal { .. } | PatternNode::MetaVar { .. } => {},
		PatternNode::Internal { children, .. } => {
			for child in children {
				collect_named_leaf_texts(child, texts);
			}
		},
	}
}
