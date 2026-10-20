//! AST-aware structural search and rewrite powered by ast-grep.

use std::{
	cmp::Ordering,
	collections::{BTreeMap, BTreeSet, BinaryHeap, HashMap},
	fs::File,
	io::Read,
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering as AtomicOrdering},
	},
};

use ast_grep_core::{
	Doc, MatchStrictness, Node,
	matcher::Pattern,
	meta_var::{MetaVarEnv, MetaVariable},
	source::{Content, Edit},
	tree_sitter::{LanguageExt, StrDoc},
};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use parking_lot::Mutex;
use veyyon_ast::{
	Grammar, SupportLang,
	ops::{self as shared_ops},
	required_text::RequiredText,
};

use crate::{
	iofs,
	napi_error::{to_napi, to_napi_with},
	task,
};

const DEFAULT_FIND_LIMIT: u32 = 50;

/// Files a walk thread opens before reading the first of them. A tree search is
/// bound by disk latency when its files are not cached, and the walk pool is
/// small, so each thread asks for a batch's reads together: the disk serves 32
/// requests per thread at once instead of one.
const PREFETCH_BATCH: usize = 32;

/// ast-grep pattern strictness (controls how patterns match syntax).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi(string_enum)]
pub enum AstMatchStrictness {
	/// Match at the concrete syntax tree level.
	#[napi(value = "cst")]
	Cst,
	/// Balanced default suitable for most searches.
	#[napi(value = "smart")]
	Smart,
	/// Match at the AST level.
	#[napi(value = "ast")]
	Ast,
	/// More permissive matching.
	#[napi(value = "relaxed")]
	Relaxed,
	/// Match structural signatures.
	#[napi(value = "signature")]
	Signature,
	/// Template-style pattern matching.
	#[napi(value = "template")]
	Template,
}

impl From<AstMatchStrictness> for MatchStrictness {
	fn from(value: AstMatchStrictness) -> Self {
		match value {
			AstMatchStrictness::Cst => Self::Cst,
			AstMatchStrictness::Smart => Self::Smart,
			AstMatchStrictness::Ast => Self::Ast,
			AstMatchStrictness::Relaxed => Self::Relaxed,
			AstMatchStrictness::Signature => Self::Signature,
			AstMatchStrictness::Template => Self::Template,
		}
	}
}

fn resolve_strictness(value: Option<AstMatchStrictness>) -> MatchStrictness {
	value.map_or(MatchStrictness::Smart, Into::into)
}

/// Options for `astGrep`: patterns, scan scope, and match limits.
#[napi(object)]
pub struct AstFindOptions<'env> {
	/// ast-grep patterns to search for (OR across patterns).
	pub patterns:     Option<Vec<String>>,
	/// Language override; otherwise inferred from file extension per candidate.
	pub lang:         Option<String>,
	/// Single file or directory to scan (combined with `glob` when set).
	pub path:         Option<String>,
	/// Optional glob filter relative to the search root.
	pub glob:         Option<String>,
	/// Rule selector for multi-rule ast-grep configurations.
	pub selector:     Option<String>,
	/// Pattern strictness; defaults to smart matching when omitted.
	pub strictness:   Option<AstMatchStrictness>,
	/// Maximum matches to return after `offset` (default applies when omitted).
	pub limit:        Option<u32>,
	/// Number of leading matches to skip before applying `limit`.
	pub offset:       Option<u32>,
	/// When true, include meta-variable bindings per match.
	pub include_meta: Option<bool>,
	/// Reserved for contextual snippets; not used by the current native find
	/// path.
	pub context:      Option<u32>,
	/// Optional cancellation handle (library-specific).
	pub signal:       Option<Unknown<'env>>,
	/// Wall-clock timeout for the worker task in milliseconds.
	pub timeout_ms:   Option<u32>,
}

/// One ast-grep match with source range and optional meta-variables.
#[napi(object)]
pub struct AstFindMatch {
	/// Display path of the matching file.
	pub path:           String,
	/// Matched source text.
	pub text:           String,
	/// Start byte offset in the file (UTF-8 byte index).
	pub byte_start:     u32,
	/// End byte offset in the file (exclusive UTF-8 byte index).
	pub byte_end:       u32,
	/// 1-based start line.
	pub start_line:     u32,
	/// 1-based start column.
	pub start_column:   u32,
	/// 1-based end line.
	pub end_line:       u32,
	/// 1-based end column.
	pub end_column:     u32,
	/// Meta-variable name to captured text, when `includeMeta` was enabled. A
	/// `$$$NAME` capture is the source it spans, in brackets.
	pub meta_variables: Option<HashMap<String, String>>,
}

#[derive(Clone, Eq, PartialEq)]
struct AstFindOrderKey {
	path:         String,
	start_line:   u32,
	start_column: u32,
	end_line:     u32,
	end_column:   u32,
	byte_start:   u32,
	byte_end:     u32,
	sequence:     u64,
}

impl Ord for AstFindOrderKey {
	fn cmp(&self, other: &Self) -> Ordering {
		self
			.path
			.cmp(&other.path)
			.then(self.start_line.cmp(&other.start_line))
			.then(self.start_column.cmp(&other.start_column))
			.then(self.end_line.cmp(&other.end_line))
			.then(self.end_column.cmp(&other.end_column))
			.then(self.byte_start.cmp(&other.byte_start))
			.then(self.byte_end.cmp(&other.byte_end))
			.then(self.sequence.cmp(&other.sequence))
	}
}

impl PartialOrd for AstFindOrderKey {
	fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
		Some(self.cmp(other))
	}
}

#[derive(Eq, PartialEq)]
struct RetainedAstFindMatch {
	key:            AstFindOrderKey,
	text:           String,
	meta_variables: Option<HashMap<String, String>>,
}

impl Ord for RetainedAstFindMatch {
	fn cmp(&self, other: &Self) -> Ordering {
		self.key.cmp(&other.key)
	}
}

impl PartialOrd for RetainedAstFindMatch {
	fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
		Some(self.cmp(other))
	}
}

fn retained_find_capacity(offset: u32, limit: u32) -> usize {
	usize::try_from(offset.saturating_add(limit).saturating_add(1)).unwrap_or(usize::MAX)
}

fn should_retain_match(
	retained: &BinaryHeap<RetainedAstFindMatch>,
	capacity: usize,
	key: &AstFindOrderKey,
) -> bool {
	if retained.len() < capacity {
		return true;
	}
	retained
		.peek()
		.is_some_and(|worst_retained| key.cmp(&worst_retained.key).is_lt())
}

fn retain_bounded_match(
	retained: &mut BinaryHeap<RetainedAstFindMatch>,
	capacity: usize,
	candidate: RetainedAstFindMatch,
) {
	if retained.len() < capacity {
		retained.push(candidate);
		return;
	}
	if let Some(mut worst_retained) = retained.peek_mut()
		&& candidate.key.cmp(&worst_retained.key).is_lt()
	{
		*worst_retained = candidate;
	}
}

fn page_retained_matches(
	retained: BinaryHeap<RetainedAstFindMatch>,
	offset: u32,
	limit: u32,
) -> (Vec<RetainedAstFindMatch>, bool) {
	let mut retained_matches = retained.into_vec();
	retained_matches.sort_by(|left, right| left.key.cmp(&right.key));
	let offset = usize::try_from(offset).unwrap_or(usize::MAX);
	let limit = usize::try_from(limit).unwrap_or(usize::MAX);
	let limit_reached = retained_matches.len().saturating_sub(offset) > limit;
	let matches = retained_matches
		.into_iter()
		.skip(offset)
		.take(limit)
		.collect::<Vec<_>>();
	(matches, limit_reached)
}

fn retained_to_find_match(retained: RetainedAstFindMatch) -> AstFindMatch {
	let RetainedAstFindMatch { key, text, meta_variables } = retained;
	AstFindMatch {
		path: key.path,
		text,
		byte_start: key.byte_start,
		byte_end: key.byte_end,
		start_line: key.start_line,
		start_column: key.start_column,
		end_line: key.end_line,
		end_column: key.end_column,
		meta_variables,
	}
}

/// Aggregated search statistics and any parse or compile diagnostics.
#[napi(object)]
pub struct AstFindResult {
	/// Page of matches after sort, offset, and limit.
	pub matches:            Vec<AstFindMatch>,
	/// Total matches found before paging (can exceed `matches.length`).
	pub total_matches:      u32,
	/// Distinct files that contained at least one match.
	pub files_with_matches: u32,
	/// Files examined for the query.
	pub files_searched:     u32,
	/// True when results were truncated by `limit`.
	pub limit_reached:      bool,
	/// Non-fatal parse or pattern errors collected during the run.
	pub parse_errors:       Option<Vec<String>>,
}

/// Options for `astMatch`: run ast-grep patterns against an in-memory source
/// string instead of files on disk.
#[napi(object)]
pub struct AstMatchOptions<'env> {
	/// Source code to match against (parsed in memory, never read from disk).
	pub source:       String,
	/// Language of `source` (required; e.g. "ts", "tsx", "rust", "python").
	pub lang:         String,
	/// ast-grep patterns to search for (OR across patterns).
	pub patterns:     Vec<String>,
	/// Rule selector for multi-rule ast-grep configurations.
	pub selector:     Option<String>,
	/// Pattern strictness; defaults to smart matching when omitted.
	pub strictness:   Option<AstMatchStrictness>,
	/// Maximum matches to return after `offset` (default applies when omitted).
	pub limit:        Option<u32>,
	/// Number of leading matches to skip before applying `limit`.
	pub offset:       Option<u32>,
	/// When true, include meta-variable bindings per match.
	pub include_meta: Option<bool>,
	/// Optional cancellation handle (library-specific).
	pub signal:       Option<Unknown<'env>>,
	/// Wall-clock timeout for the worker task in milliseconds.
	pub timeout_ms:   Option<u32>,
}

/// Result of an in-memory `astMatch` run.
#[napi(object)]
pub struct AstMatchResult {
	/// Page of matches after sort, offset, and limit.
	pub matches:       Vec<AstFindMatch>,
	/// Total matches found before paging (can exceed `matches.length`).
	pub total_matches: u32,
	/// True when results were truncated by `limit`.
	pub limit_reached: bool,
	/// Non-fatal parse or pattern-compile errors collected during the run.
	pub parse_errors:  Option<Vec<String>>,
}

/// Options for `astEdit`: rewrite rules, scan scope, safety limits, and
/// dry-run.
#[napi(object)]
pub struct AstReplaceOptions<'env> {
	/// Map of pattern string to replacement template.
	pub rewrites:            Option<HashMap<String, String>>,
	/// Language override; otherwise inferred from discovered files.
	pub lang:                Option<String>,
	/// Single file or directory to rewrite.
	pub path:                Option<String>,
	/// Optional glob filter within the search root.
	pub glob:                Option<String>,
	/// Rule selector for multi-rule configurations.
	pub selector:            Option<String>,
	/// Pattern strictness for rewrites.
	pub strictness:          Option<AstMatchStrictness>,
	/// When true (default), compute changes without writing files.
	pub dry_run:             Option<bool>,
	/// Cap on replacement applications across all files.
	pub max_replacements:    Option<u32>,
	/// Cap on distinct files that may be modified.
	pub max_files:           Option<u32>,
	/// Fail the operation when a file cannot be parsed for rewriting.
	pub fail_on_parse_error: Option<bool>,
	/// Optional cancellation handle.
	pub signal:              Option<Unknown<'env>>,
	/// Wall-clock timeout for the worker task in milliseconds.
	pub timeout_ms:          Option<u32>,
}

/// One textual replacement applied to a file (before/after slice and
/// coordinates).
#[napi(object)]
pub struct AstReplaceChange {
	/// File path for this change.
	pub path:           String,
	/// Original matched text.
	pub before:         String,
	/// Replacement text.
	pub after:          String,
	/// Start byte offset of the replaced span.
	pub byte_start:     u32,
	/// End byte offset of the replaced span (exclusive).
	pub byte_end:       u32,
	/// Length of deleted text in bytes (may differ from `byteEnd - byteStart`
	/// for edge cases).
	pub deleted_length: u32,
	/// 1-based start line of the match.
	pub start_line:     u32,
	/// 1-based start column.
	pub start_column:   u32,
	/// 1-based end line.
	pub end_line:       u32,
	/// 1-based end column.
	pub end_column:     u32,
}

/// Per-file replacement count after an `astEdit` run.
#[napi(object)]
pub struct AstReplaceFileChange {
	/// File that had replacements.
	pub path:  String,
	/// Number of replacements in that file.
	pub count: u32,
}

/// Summary of an ast-grep rewrite pass, including whether disk writes occurred.
#[napi(object)]
pub struct AstReplaceResult {
	/// Individual replacement records (may be large).
	pub changes:            Vec<AstReplaceChange>,
	/// Replacement counts grouped by file.
	pub file_changes:       Vec<AstReplaceFileChange>,
	/// Total replacements applied or previewed.
	pub total_replacements: u32,
	/// Files that had at least one replacement.
	pub files_touched:      u32,
	/// Files considered for rewriting.
	pub files_searched:     u32,
	/// False when `dryRun` prevented writing.
	pub applied:            bool,
	/// True when limits stopped further replacements.
	pub limit_reached:      bool,
	/// Parse or pattern errors when not failing the whole operation.
	pub parse_errors:       Option<Vec<String>>,
}

struct FileCandidate {
	absolute_path: PathBuf,
	display_path:  String,
}

struct PendingFileChange {
	change: AstReplaceChange,
	edit:   Edit<String>,
}

struct PendingWrite {
	absolute_path: PathBuf,
	output:        String,
}

fn to_u32(value: usize) -> u32 {
	value.min(u32::MAX as usize) as u32
}

fn resolve_supported_lang(value: &str) -> Result<SupportLang> {
	shared_ops::resolve_supported_lang(value).map_err(to_napi)
}

fn resolve_language(lang: Option<&str>, file_path: &Path) -> Result<SupportLang> {
	shared_ops::resolve_language(lang, file_path).map_err(to_napi)
}

/// Returns true if the file's extension resolves to a supported language.
/// When `lang` is explicitly provided, all files are considered candidates
/// (the user chose to treat them as that language). When `lang` is None,
/// only files with recognizable code extensions are included.
fn is_supported_file(file_path: &Path, explicit_lang: Option<&str>) -> bool {
	shared_ops::is_supported_file(file_path, explicit_lang)
}

fn infer_single_replace_lang(
	candidates: &[FileCandidate],
	ct: &task::CancelToken,
) -> Result<String> {
	let mut inferred = BTreeSet::new();
	let mut unresolved = Vec::new();
	for candidate in candidates {
		ct.heartbeat()?;
		match resolve_language(None, &candidate.absolute_path) {
			Ok(language) => {
				inferred.insert(language.canonical_name().to_string());
			},
			Err(err) => unresolved.push(format!("{}: {}", candidate.display_path, err)),
		}
	}
	if !unresolved.is_empty() {
		let details = unresolved
			.into_iter()
			.map(|entry| format!("- {entry}"))
			.collect::<Vec<_>>()
			.join("\n");
		return Err(Error::from_reason(format!(
			"`lang` is required for ast_edit when language cannot be inferred from all \
			 files:\n{details}"
		)));
	}
	if inferred.is_empty() {
		return Err(Error::from_reason(
			"`lang` is required for ast_edit when no files match path/glob".to_string(),
		));
	}
	if inferred.len() > 1 {
		return Err(Error::from_reason(format!(
			"`lang` is required for ast_edit when path/glob resolves to multiple languages: {}",
			inferred.into_iter().collect::<Vec<_>>().join(", ")
		)));
	}
	Ok(inferred.into_iter().next().expect("non-empty inferred set"))
}
fn normalize_search_path(path: Option<String>) -> Result<PathBuf> {
	let raw = path.unwrap_or_else(|| ".".to_string());
	let candidate = PathBuf::from(raw.trim());
	let absolute = if candidate.is_absolute() {
		candidate
	} else {
		std::env::current_dir()
			.map_err(|err| to_napi_with("Failed to resolve cwd", err))?
			.join(candidate)
	};
	Ok(std::fs::canonicalize(&absolute).unwrap_or(absolute))
}

/// The files a search or a rewrite reads: one named file, or the files a walk
/// of a directory accepts.
enum SearchScope {
	File(FileCandidate),
	Tree { root: PathBuf, request: veyyon_walker::WalkRequest },
}

fn resolve_scope(path: Option<String>, glob: Option<&str>) -> Result<SearchScope> {
	let search_path = normalize_search_path(path)?;
	let metadata =
		std::fs::metadata(&search_path).map_err(|err| to_napi_with("Path not found", err))?;
	if metadata.is_file() {
		let display_path = search_path
			.file_name()
			.and_then(|name| name.to_str())
			.map_or_else(
				|| search_path.to_string_lossy().into_owned(),
				std::string::ToString::to_string,
			);
		return Ok(SearchScope::File(FileCandidate { absolute_path: search_path, display_path }));
	}
	if !metadata.is_dir() {
		return Err(Error::from_reason(format!(
			"Search path must be a file or directory: {}",
			search_path.display()
		)));
	}

	let mentions_node_modules = glob.is_some_and(|value| value.contains("node_modules"));
	let mut filter =
		veyyon_walker::WalkFilter::files_only().node_modules_unless_mentioned(mentions_node_modules);
	// Unbounded unless a glob says otherwise: with no glob every file is a
	// candidate.
	let mut depth_limit = usize::MAX;
	if let Some(glob) = glob.map(str::trim).filter(|value| !value.is_empty()) {
		let compiled = veyyon_walker::CompiledWalkGlob::compile(glob, false)
			.map_err(|err| to_napi_with("Invalid glob pattern", err))?;
		depth_limit = compiled.depth_bound();
		filter = filter.glob(compiled);
	}
	// Uncached: the scan cache keeps every entry under the root, accepted or
	// not, which for a tree of millions of files is a gigabyte held by a search
	// that reads each file once.
	let request = veyyon_walker::WalkRequest::new(&search_path)
		.hidden(true)
		.gitignore(true)
		.skip_git(true)
		.follow_links(veyyon_walker::FollowLinks::Never)
		.detail(veyyon_walker::WalkDetail::Minimal)
		.order(veyyon_walker::WalkOrder::Path)
		.emit_root(false)
		.depth(1, depth_limit)
		.directory_errors(veyyon_walker::DirectoryErrorMode::SkipSkippable)
		.cache(false)
		.filter(filter);
	Ok(SearchScope::Tree { root: search_path, request })
}

/// Every file of the scope, sorted by display path.
fn collect_candidates(
	path: Option<String>,
	glob: Option<&str>,
	ct: &task::CancelToken,
) -> Result<Vec<FileCandidate>> {
	let (root, request) = match resolve_scope(path, glob)? {
		SearchScope::File(file) => return Ok(vec![file]),
		SearchScope::Tree { root, request } => (root, request),
	};
	let mut files: Vec<_> = request
		.collect_files_with_heartbeat(|| ct.heartbeat())
		.map_err(iofs::map_walker_error)?
		.into_iter()
		.map(|entry| FileCandidate {
			absolute_path: entry.absolute_path(&root),
			display_path:  entry.path,
		})
		.collect();

	files.sort_by(|a, b| a.display_path.cmp(&b.display_path));
	Ok(files)
}

fn compile_pattern<L: Grammar>(
	pattern: &str,
	selector: Option<&str>,
	strictness: &MatchStrictness,
	lang: L,
) -> Result<Pattern> {
	shared_ops::compile_pattern(pattern, selector, strictness, lang).map_err(to_napi)
}

fn apply_edits(content: &str, edits: &[Edit<String>]) -> Result<String> {
	shared_ops::apply_edits(content, edits).map_err(to_napi)
}

fn normalize_pattern_list(patterns: Option<Vec<String>>) -> Result<Vec<String>> {
	let mut normalized = Vec::new();
	let mut seen = BTreeSet::new();
	for raw in patterns.unwrap_or_default() {
		let pattern = raw.trim();
		if pattern.is_empty() || seen.contains(pattern) {
			continue;
		}
		let owned = if pattern.len() == raw.len() {
			raw
		} else {
			pattern.to_string()
		};
		seen.insert(owned.clone());
		normalized.push(owned);
	}
	if normalized.is_empty() {
		return Err(Error::from_reason(
			"`patterns` is required and must include at least one non-empty pattern".to_string(),
		));
	}
	Ok(normalized)
}

fn normalize_rewrite_map(
	rewrites: Option<HashMap<String, String>>,
) -> Result<Vec<(String, String)>> {
	let mut normalized = Vec::new();
	for (pattern, rewrite) in rewrites.unwrap_or_default() {
		if pattern.is_empty() {
			return Err(Error::from_reason(
				"`rewrites` keys must be non-empty pattern strings".to_string(),
			));
		}
		normalized.push((pattern, rewrite));
	}
	if normalized.is_empty() {
		return Err(Error::from_reason(
			"`rewrites` is required and must include at least one pattern->rewrite mapping"
				.to_string(),
		));
	}
	normalized.sort_by(|left, right| left.0.cmp(&right.0));
	Ok(normalized)
}

/// One pattern compiled for one language, with the text a source holds
/// wherever the pattern can match in it.
struct LanguagePattern {
	pattern:  Pattern,
	required: RequiredText,
}

/// Every pattern of a search compiled for one language, in pattern order: the
/// compiled pattern, or why it does not compile for that language.
type LanguagePatterns = Arc<[std::result::Result<LanguagePattern, String>]>;

/// A structure search over files that arrive in any order, on any thread.
///
/// The patterns are compiled for a language when the first file in it
/// arrives, and each file's tally is merged as soon as the file is searched,
/// so a run holds its best `capacity` matches and its diagnostics, never a
/// list of the files it searches.
struct FindRun<'a> {
	patterns:       &'a [String],
	lang:           Option<&'a str>,
	selector:       Option<&'a str>,
	strictness:     &'a MatchStrictness,
	capacity:       usize,
	include_meta:   bool,
	compiled:       Mutex<HashMap<SupportLang, LanguagePatterns>>,
	files_searched: AtomicUsize,
	tally:          Mutex<FindTally>,
	/// Files the walk accepted that no thread has opened yet: absolute path,
	/// then display path.
	pending:        Mutex<Vec<(PathBuf, String)>>,
}

/// What a finished [`FindRun`] found, before paging.
struct FindOutcome {
	retained:           BinaryHeap<RetainedAstFindMatch>,
	total_matches:      u32,
	files_with_matches: BTreeSet<String>,
	files_searched:     u32,
	/// Pattern compile errors in pattern order, then file diagnostics by path.
	diagnostics:        Vec<String>,
}

impl<'a> FindRun<'a> {
	fn new(
		patterns: &'a [String],
		lang: Option<&'a str>,
		selector: Option<&'a str>,
		strictness: &'a MatchStrictness,
		capacity: usize,
		include_meta: bool,
	) -> Self {
		Self {
			patterns,
			lang,
			selector,
			strictness,
			capacity,
			include_meta,
			compiled: Mutex::new(HashMap::new()),
			files_searched: AtomicUsize::new(0),
			tally: Mutex::new(FindTally::default()),
			pending: Mutex::new(Vec::with_capacity(PREFETCH_BATCH)),
		}
	}

	/// Search every file of `scope`. A tree's files are searched on the walker
	/// pool as the walk yields them, a batch at a time.
	fn search_scope(&self, scope: &SearchScope, ct: &task::CancelToken) -> Result<()> {
		match scope {
			SearchScope::File(file) => self.search_file(&file.absolute_path, &file.display_path, ct),
			SearchScope::Tree { request, .. } => {
				request
					.for_each_file_candidate_parallel(
						|file| {
							if is_supported_file(&file.path, self.lang) {
								let full = {
									let mut pending = self.pending.lock();
									pending.push((file.path.clone(), file.relative.clone()));
									(pending.len() >= PREFETCH_BATCH).then(|| {
										std::mem::replace(&mut *pending, Vec::with_capacity(PREFETCH_BATCH))
									})
								};
								if let Some(batch) = full {
									self.search_batch(batch, ct)?;
								}
							}
							Ok(veyyon_walker::ParallelWalkControl::Continue)
						},
						|| ct.heartbeat(),
					)
					.map_err(iofs::map_walker_error)?;
				let rest = std::mem::take(&mut *self.pending.lock());
				self.search_batch(rest, ct)
			},
		}
	}

	/// Open every file of `batch`, asking the system to read each ahead, then
	/// search them in order: the first read waits for one file, not the batch.
	fn search_batch(&self, batch: Vec<(PathBuf, String)>, ct: &task::CancelToken) -> Result<()> {
		let opened: Vec<_> = batch
			.into_iter()
			.map(|(path, display_path)| {
				let file = File::open(&path).ok();
				#[cfg(target_os = "linux")]
				if let Some(file) = &file {
					advise_will_read(file);
				}
				(path, display_path, file)
			})
			.collect();
		for (path, display_path, file) in opened {
			self.search_opened(&path, &display_path, file, ct)?;
		}
		Ok(())
	}

	/// Search one file, when its name is one a search reads.
	fn search_file(&self, path: &Path, display_path: &str, ct: &task::CancelToken) -> Result<()> {
		if !is_supported_file(path, self.lang) {
			return Ok(());
		}
		self.search_opened(path, display_path, None, ct)
	}

	/// Search one supported file, reading it from `file` when it is already
	/// open and opening it by path otherwise.
	fn search_opened(
		&self,
		path: &Path,
		display_path: &str,
		file: Option<File>,
		ct: &task::CancelToken,
	) -> Result<()> {
		self.files_searched.fetch_add(1, AtomicOrdering::Relaxed);
		let found = match resolve_language(self.lang, path) {
			Ok(language) => {
				let patterns = self.patterns_for(language, ct)?;
				// A file the batch could not open is opened again by path, so it
				// reports the error a read by path reports.
				let read = || match file {
					Some(mut file) => {
						let mut source = String::new();
						file.read_to_string(&mut source).map(|_| source)
					},
					None => std::fs::read_to_string(path),
				};
				find_in_file(
					read,
					display_path,
					language,
					&patterns,
					self.capacity,
					self.include_meta,
					ct,
				)?
			},
			Err(err) => FindTally::diagnostic(display_path, err.to_string()),
		};
		if !found.is_empty() {
			let mut tally = self.tally.lock();
			let merged = std::mem::take(&mut *tally).absorb(found, self.capacity);
			*tally = merged;
		}
		Ok(())
	}

	/// The run's patterns compiled for `language`, compiled on first use.
	fn patterns_for(
		&self,
		language: SupportLang,
		ct: &task::CancelToken,
	) -> Result<LanguagePatterns> {
		let mut compiled = self.compiled.lock();
		if let Some(patterns) = compiled.get(&language) {
			return Ok(Arc::clone(patterns));
		}
		let mut patterns = Vec::with_capacity(self.patterns.len());
		for pattern in self.patterns {
			ct.heartbeat()?;
			patterns.push(
				compile_pattern(pattern, self.selector, self.strictness, language.document())
					.map(|pattern| LanguagePattern { required: RequiredText::of(&pattern), pattern })
					.map_err(|err| err.to_string()),
			);
		}
		let patterns: LanguagePatterns = patterns.into();
		compiled.insert(language, Arc::clone(&patterns));
		Ok(patterns)
	}

	fn finish(self) -> FindOutcome {
		let FindTally { retained, total_matches, files_with_matches, mut parse_errors } =
			self.tally.into_inner();
		let mut compiled: Vec<_> = self.compiled.into_inner().into_iter().collect();
		compiled.sort_unstable_by_key(|(language, _)| language.canonical_name());
		// A pattern that compiles for none of the languages searched reports why
		// for each of them; one that compiles for some of them is searched there.
		let mut diagnostics = Vec::new();
		for (index, pattern) in self.patterns.iter().enumerate() {
			if compiled.iter().any(|(_, patterns)| patterns[index].is_ok()) {
				continue;
			}
			for (language, patterns) in &compiled {
				if let Err(error) = &patterns[index] {
					diagnostics.push(format!("{pattern}: {}: {error}", language.canonical_name()));
				}
			}
		}
		parse_errors.sort_unstable_by(|left, right| left.0.cmp(&right.0));
		diagnostics.extend(
			parse_errors
				.into_iter()
				.map(|(path, error)| format!("{path}: {error}")),
		);
		FindOutcome {
			retained,
			total_matches,
			files_with_matches,
			files_searched: to_u32(self.files_searched.into_inner()),
			diagnostics,
		}
	}
}

/// Search source files with ast-grep patterns; returns a promise resolved on a
/// worker thread.
#[napi]
pub fn ast_grep(options: AstFindOptions<'_>) -> task::Promise<AstFindResult> {
	let AstFindOptions {
		patterns,
		lang,
		path,
		glob,
		selector,
		strictness,
		limit,
		offset,
		include_meta,
		context: _,
		signal,
		timeout_ms,
	} = options;

	let ct = task::CancelToken::new(timeout_ms, signal);
	let normalized_limit = limit.unwrap_or(DEFAULT_FIND_LIMIT).max(1);
	let normalized_offset = offset.unwrap_or(0);

	task::blocking("ast_grep", ct, move |ct| {
		let patterns = normalize_pattern_list(patterns)?;
		let strictness = resolve_strictness(strictness);
		let lang = lang.as_deref().map(str::trim).filter(|v| !v.is_empty());
		let scope = resolve_scope(path, glob.as_deref())?;
		let run = FindRun::new(
			&patterns,
			lang,
			selector.as_deref(),
			&strictness,
			retained_find_capacity(normalized_offset, normalized_limit),
			include_meta.unwrap_or(false),
		);
		run.search_scope(&scope, &ct)?;
		let FindOutcome { retained, total_matches, files_with_matches, files_searched, diagnostics } =
			run.finish();

		let (matches, limit_reached) =
			page_retained_matches(retained, normalized_offset, normalized_limit);
		let matches = matches
			.into_iter()
			.map(retained_to_find_match)
			.collect::<Vec<_>>();

		Ok(AstFindResult {
			matches,
			total_matches,
			files_with_matches: to_u32(files_with_matches.len()),
			files_searched,
			limit_reached,
			parse_errors: (!diagnostics.is_empty()).then_some(diagnostics),
		})
	})
}

/// What a set of files contributed to an [`ast_grep`]: its best `capacity`
/// matches, its match count, the files that matched, and each file's
/// diagnostic as its display path and the error.
#[derive(Default)]
struct FindTally {
	retained:           BinaryHeap<RetainedAstFindMatch>,
	total_matches:      u32,
	files_with_matches: BTreeSet<String>,
	parse_errors:       Vec<(String, String)>,
}

impl FindTally {
	fn diagnostic(display_path: &str, error: String) -> Self {
		Self { parse_errors: vec![(display_path.to_owned(), error)], ..Self::default() }
	}

	const fn is_empty(&self) -> bool {
		self.total_matches == 0 && self.parse_errors.is_empty()
	}

	/// This tally and `next` together.
	fn absorb(mut self, mut next: Self, capacity: usize) -> Self {
		if next.retained.len() > self.retained.len() {
			std::mem::swap(&mut self.retained, &mut next.retained);
		}
		for candidate in next.retained {
			retain_bounded_match(&mut self.retained, capacity, candidate);
		}
		self.total_matches = self.total_matches.saturating_add(next.total_matches);
		self.files_with_matches.append(&mut next.files_with_matches);
		self.parse_errors.append(&mut next.parse_errors);
		self
	}
}

/// A match's bindings as the source they cover: a single capture is its
/// node's text, and a multi capture (`$$$NAME`) the source from its first node
/// to its last, in brackets. Listing a multi capture node by node, as
/// ast-grep's own conversion does, prints the comma between two arguments as an
/// element of its own: `foo($$$A)` over `foo(a, b)` bound `[a, ,, b]`.
fn binding_texts<D: Doc>(env: &MetaVarEnv<'_, D>) -> HashMap<String, String> {
	let mut texts = HashMap::new();
	for var in env.get_matched_variables() {
		let source = env
			.get_var_bytes(&var)
			.map(<D::Source as Content>::encode_bytes);
		match var {
			MetaVariable::Capture(name, _) => {
				if let Some(source) = source {
					texts.insert(name, source.into_owned());
				}
			},
			MetaVariable::MultiCapture(name) => {
				texts.insert(name, format!("[{}]", source.unwrap_or_default()));
			},
			MetaVariable::Dropped(_) | MetaVariable::Multiple => {},
		}
	}
	texts
}

/// Whether the tree under `root` holds an ERROR node. tree-sitter records on
/// every node whether its subtree holds an error or a missing node, so a clean
/// tree is answered without visiting a node, and only a tree marked with one
/// is walked to tell an ERROR node from a missing one.
fn holds_error_node<L: LanguageExt>(root: &Node<'_, StrDoc<L>>) -> bool {
	root.get_inner_node().has_error() && root.dfs().any(|node| node.is_error())
}

/// Ask the kernel to start reading `file` into the page cache without waiting
/// for it. The advice changes no result: when it fails, the read that follows
/// waits for the disk as it would have.
#[cfg(target_os = "linux")]
fn advise_will_read(file: &File) {
	use std::os::fd::AsRawFd;
	// SAFETY: `file` holds the descriptor open for the call, and the advice reads
	// and writes no memory of this process.
	unsafe {
		libc::posix_fadvise(file.as_raw_fd(), 0, 0, libc::POSIX_FADV_WILLNEED);
	}
}

/// Search one file for every pattern compiled for its language, keeping its
/// best `capacity` matches. `read` returns the file's source, and is not called
/// when no pattern compiled for the language.
///
/// A pattern whose required text the file lacks cannot match in it, and a file
/// no pattern can match in is not parsed, so it reports no parse error either.
fn find_in_file(
	read: impl FnOnce() -> std::io::Result<String>,
	display_path: &str,
	language: SupportLang,
	patterns: &[std::result::Result<LanguagePattern, String>],
	capacity: usize,
	include_meta: bool,
	ct: &task::CancelToken,
) -> Result<FindTally> {
	ct.heartbeat()?;
	let mut tally = FindTally::default();
	if !patterns.iter().any(std::result::Result::is_ok) {
		return Ok(tally);
	}
	let source = match read() {
		Ok(source) => source,
		Err(err) => return Ok(FindTally::diagnostic(display_path, err.to_string())),
	};
	let runnable_patterns: Vec<&Pattern> = patterns
		.iter()
		.filter_map(|compiled| compiled.as_ref().ok())
		.filter(|compiled| compiled.required.is_in(source.as_bytes()))
		.map(|compiled| &compiled.pattern)
		.collect();
	if runnable_patterns.is_empty() {
		return Ok(tally);
	}

	let ast = language.document().ast_grep(source);
	if holds_error_node(&ast.root()) {
		tally.parse_errors.push((
			display_path.to_owned(),
			"parse error (syntax tree contains error nodes)".to_string(),
		));
	}
	// Matches in different files differ in path, so a file numbers its own:
	// the sequence orders two patterns' matches of one node as one pass did.
	let mut sequence = 0u64;
	for pattern in runnable_patterns {
		ct.heartbeat()?;
		for matched in ast.root().find_all(pattern.clone()) {
			ct.heartbeat()?;
			tally.total_matches = tally.total_matches.saturating_add(1);
			let range = matched.range();
			let start = matched.start_pos();
			let end = matched.end_pos();
			let key = AstFindOrderKey {
				path: display_path.to_owned(),
				start_line: to_u32(start.line().saturating_add(1)),
				start_column: to_u32(start.column(matched.get_node()).saturating_add(1)),
				end_line: to_u32(end.line().saturating_add(1)),
				end_column: to_u32(end.column(matched.get_node()).saturating_add(1)),
				byte_start: to_u32(range.start),
				byte_end: to_u32(range.end),
				sequence,
			};
			sequence = sequence.saturating_add(1);
			if should_retain_match(&tally.retained, capacity, &key) {
				let meta_variables = include_meta.then(|| binding_texts(matched.get_env()));
				retain_bounded_match(&mut tally.retained, capacity, RetainedAstFindMatch {
					key,
					text: matched.text().into_owned(),
					meta_variables,
				});
			}
		}
	}
	if tally.total_matches > 0 {
		tally.files_with_matches.insert(display_path.to_owned());
	}
	Ok(tally)
}

/// Match ast-grep patterns against an in-memory source string; returns a
/// promise resolved on a worker thread.
///
/// This is the file-free counterpart to [`ast_grep`]: callers that already hold
/// the source (streaming buffers, generated code, editor contents) avoid a
/// temp-file round trip. `lang` is required since there is no path to infer it
/// from.
#[napi]
pub fn ast_match(options: AstMatchOptions<'_>) -> task::Promise<AstMatchResult> {
	let AstMatchOptions {
		source,
		lang,
		patterns,
		selector,
		strictness,
		limit,
		offset,
		include_meta,
		signal,
		timeout_ms,
	} = options;

	let ct = task::CancelToken::new(timeout_ms, signal);
	let normalized_limit = limit.unwrap_or(DEFAULT_FIND_LIMIT).max(1);
	let normalized_offset = offset.unwrap_or(0);

	task::blocking("ast_match", ct, move |ct| {
		let patterns = normalize_pattern_list(Some(patterns))?;
		let strictness = resolve_strictness(strictness);
		let include_meta = include_meta.unwrap_or(false);
		let lang_str = lang.trim();
		if lang_str.is_empty() {
			return Err(Error::from_reason("`lang` is required for ast_match"));
		}
		let language = resolve_supported_lang(lang_str)?;

		let mut parse_errors = Vec::new();
		let mut compiled_patterns = Vec::with_capacity(patterns.len());
		for pattern in &patterns {
			ct.heartbeat()?;
			match compile_pattern(pattern, selector.as_deref(), &strictness, language) {
				Ok(compiled) => compiled_patterns.push(compiled),
				Err(err) => parse_errors.push(format!("{pattern}: {err}")),
			}
		}

		let retained_capacity = retained_find_capacity(normalized_offset, normalized_limit);
		let mut retained_matches = BinaryHeap::new();
		let mut total_matches = 0u32;
		let mut match_sequence = 0u64;
		if !compiled_patterns.is_empty() {
			let ast = language.ast_grep(&source);
			if holds_error_node(&ast.root()) {
				parse_errors.push("parse error (syntax tree contains error nodes)".to_string());
			}
			for pattern in &compiled_patterns {
				ct.heartbeat()?;
				for matched in ast.root().find_all(pattern.clone()) {
					ct.heartbeat()?;
					total_matches = total_matches.saturating_add(1);
					let range = matched.range();
					let start = matched.start_pos();
					let end = matched.end_pos();
					let key = AstFindOrderKey {
						path:         String::new(),
						start_line:   to_u32(start.line().saturating_add(1)),
						start_column: to_u32(start.column(matched.get_node()).saturating_add(1)),
						end_line:     to_u32(end.line().saturating_add(1)),
						end_column:   to_u32(end.column(matched.get_node()).saturating_add(1)),
						byte_start:   to_u32(range.start),
						byte_end:     to_u32(range.end),
						sequence:     match_sequence,
					};
					match_sequence = match_sequence.saturating_add(1);
					if should_retain_match(&retained_matches, retained_capacity, &key) {
						let meta_variables = include_meta.then(|| binding_texts(matched.get_env()));
						retain_bounded_match(
							&mut retained_matches,
							retained_capacity,
							RetainedAstFindMatch {
								key,
								text: matched.text().into_owned(),
								meta_variables,
							},
						);
					}
				}
			}
		}

		let (matches, limit_reached) =
			page_retained_matches(retained_matches, normalized_offset, normalized_limit);
		let matches = matches
			.into_iter()
			.map(retained_to_find_match)
			.collect::<Vec<_>>();

		Ok(AstMatchResult {
			matches,
			total_matches,
			limit_reached,
			parse_errors: (!parse_errors.is_empty()).then_some(parse_errors),
		})
	})
}

/// Apply ast-grep rewrite rules to matching files; honors `dryRun` and returns
/// a promise.
#[napi]
pub fn ast_edit(options: AstReplaceOptions<'_>) -> task::Promise<AstReplaceResult> {
	let AstReplaceOptions {
		rewrites,
		lang,
		path,
		glob,
		selector,
		strictness,
		dry_run,
		max_replacements,
		max_files,
		fail_on_parse_error,
		signal,
		timeout_ms,
	} = options;

	let ct = task::CancelToken::new(timeout_ms, signal);
	task::blocking("ast_edit", ct, move |ct| {
		ast_edit_blocking(
			ct,
			rewrites,
			lang,
			path,
			glob,
			selector,
			strictness,
			dry_run,
			max_replacements,
			max_files,
			fail_on_parse_error,
		)
	})
}

#[allow(
	clippy::too_many_arguments,
	reason = "napi-exposed wrapper mirrors the JS-facing argument list"
)]
fn ast_edit_blocking(
	ct: task::CancelToken,
	rewrites: Option<HashMap<String, String>>,
	lang: Option<String>,
	path: Option<String>,
	glob: Option<String>,
	selector: Option<String>,
	strictness: Option<AstMatchStrictness>,
	dry_run: Option<bool>,
	max_replacements: Option<u32>,
	max_files: Option<u32>,
	fail_on_parse_error: Option<bool>,
) -> Result<AstReplaceResult> {
	let rewrite_rules = normalize_rewrite_map(rewrites)?;
	let strictness = resolve_strictness(strictness);
	let dry_run = dry_run.unwrap_or(true);
	let max_replacements = max_replacements.unwrap_or(u32::MAX).max(1);
	let max_files = max_files.unwrap_or(u32::MAX).max(1);
	let fail_on_parse_error = fail_on_parse_error.unwrap_or(false);

	let lang_str = lang.as_deref().map(str::trim).filter(|v| !v.is_empty());
	let candidates: Vec<_> = collect_candidates(path, glob.as_deref(), &ct)?
		.into_iter()
		.filter(|candidate| is_supported_file(&candidate.absolute_path, lang_str))
		.collect();
	let effective_lang = if let Some(lang) = lang_str {
		lang.to_string()
	} else {
		infer_single_replace_lang(&candidates, &ct)?
	};

	let language = resolve_supported_lang(&effective_lang)?.document();
	let mut parse_errors = Vec::new();
	let mut compiled_rules = Vec::new();
	for (pattern, rewrite) in rewrite_rules {
		ct.heartbeat()?;
		match compile_pattern(&pattern, selector.as_deref(), &strictness, language) {
			Ok(compiled) => compiled_rules.push((rewrite, RequiredText::of(&compiled), compiled)),
			Err(err) => {
				if fail_on_parse_error {
					return Err(err);
				}
				parse_errors.push(format!("{pattern}: {err}"));
			},
		}
	}
	if compiled_rules.is_empty() {
		return Ok(AstReplaceResult {
			file_changes:       vec![],
			total_replacements: 0,
			files_touched:      0,
			files_searched:     to_u32(candidates.len()),
			applied:            !dry_run,
			limit_reached:      false,
			parse_errors:       (!parse_errors.is_empty()).then_some(parse_errors),
			changes:            vec![],
		});
	}

	let mut changes = Vec::new();
	let mut file_counts: BTreeMap<String, u32> = BTreeMap::new();
	let mut files_touched = 0u32;
	let mut limit_reached = false;
	// Stage writes in memory so a later compute error cannot leave earlier
	// files partially modified on disk; flush only after the whole pass succeeds.
	let mut pending_writes: Vec<PendingWrite> = Vec::new();

	for candidate in &candidates {
		ct.heartbeat()?;
		let source = match std::fs::read_to_string(&candidate.absolute_path) {
			Ok(source) => source,
			Err(err) => {
				if fail_on_parse_error {
					return Err(to_napi_with(&candidate.display_path, err));
				}
				parse_errors.push(format!("{}: {err}", candidate.display_path));
				continue;
			},
		};

		// A rule whose required text the file lacks cannot match in it. A file
		// no rule can match in is not parsed, unless every file must parse.
		let runnable_rules: Vec<_> = compiled_rules
			.iter()
			.filter(|(_, required, _)| required.is_in(source.as_bytes()))
			.collect();
		if runnable_rules.is_empty() && !fail_on_parse_error {
			continue;
		}

		let ast = language.ast_grep(&source);
		if holds_error_node(&ast.root()) {
			let parse_issue =
				format!("{}: parse error (syntax tree contains error nodes)", candidate.display_path);
			if fail_on_parse_error {
				return Err(Error::from_reason(parse_issue));
			}
			parse_errors.push(parse_issue);
			continue;
		}

		let mut file_changes = Vec::new();
		let mut reached_max_replacements = false;
		'patterns: for (rewrite, _, compiled) in runnable_rules {
			for matched in ast.root().find_all(compiled.clone()) {
				ct.heartbeat()?;
				let edit = matched.replace_by(rewrite.as_str());
				// Multiple rules matching the same node with the same output are one
				// deterministic edit; list and count it once instead of staging a
				// duplicate that trips the apply-time overlap check.
				let duplicate = file_changes.iter().any(|entry: &PendingFileChange| {
					entry.edit.position == edit.position
						&& entry.edit.deleted_length == edit.deleted_length
						&& entry.edit.inserted_text == edit.inserted_text
				});
				if duplicate {
					continue;
				}
				if changes.len() + file_changes.len() >= max_replacements as usize {
					limit_reached = true;
					reached_max_replacements = true;
					break 'patterns;
				}
				let range = matched.range();
				let start = matched.start_pos();
				let end = matched.end_pos();
				let after = String::from_utf8(edit.inserted_text.clone()).map_err(|err| {
					Error::from_reason(format!(
						"{}: replacement text is not valid UTF-8: {err}",
						candidate.display_path
					))
				})?;
				file_changes.push(PendingFileChange {
					change: AstReplaceChange {
						path: candidate.display_path.clone(),
						before: matched.text().into_owned(),
						after,
						byte_start: to_u32(range.start),
						byte_end: to_u32(range.end),
						deleted_length: to_u32(edit.deleted_length),
						start_line: to_u32(start.line().saturating_add(1)),
						start_column: to_u32(start.column(matched.get_node()).saturating_add(1)),
						end_line: to_u32(end.line().saturating_add(1)),
						end_column: to_u32(end.column(matched.get_node()).saturating_add(1)),
					},
					edit,
				});
			}
		}

		if file_changes.is_empty() {
			if reached_max_replacements {
				break;
			}
			continue;
		}
		if files_touched >= max_files {
			limit_reached = true;
			break;
		}
		files_touched = files_touched.saturating_add(1);
		file_counts.insert(candidate.display_path.clone(), to_u32(file_changes.len()));

		if !dry_run {
			let edits: Vec<Edit<String>> = file_changes
				.iter()
				.map(|entry| Edit {
					position:       entry.edit.position,
					deleted_length: entry.edit.deleted_length,
					inserted_text:  entry.edit.inserted_text.clone(),
				})
				.collect();
			let output = apply_edits(&source, &edits)?;
			if output != source {
				pending_writes
					.push(PendingWrite { absolute_path: candidate.absolute_path.clone(), output });
			}
		}

		changes.extend(file_changes.into_iter().map(|entry| entry.change));
		if reached_max_replacements {
			break;
		}
	}

	if !dry_run {
		for write in &pending_writes {
			ct.heartbeat()?;
			std::fs::write(&write.absolute_path, &write.output).map_err(|err| {
				to_napi_with(format_args!("Failed to write {}", write.absolute_path.display()), err)
			})?;
		}
	}

	let file_changes = file_counts
		.into_iter()
		.map(|(path, count)| AstReplaceFileChange { path, count })
		.collect::<Vec<_>>();

	Ok(AstReplaceResult {
		file_changes,
		total_replacements: to_u32(changes.len()),
		files_touched,
		files_searched: to_u32(candidates.len()),
		applied: !dry_run,
		limit_reached,
		parse_errors: (!parse_errors.is_empty()).then_some(parse_errors),
		changes,
	})
}

#[cfg(test)]
mod tests {
	use std::{fmt::Write as _, fs};

	use veyyon_test_scratch::TempTree;

	use super::*;

	fn make_temp_tree() -> TempTree {
		let root = veyyon_test_scratch::scratch_dir("natives-ast-glob");
		fs::create_dir_all(root.join("nested")).expect("temp nested dir should be created");
		fs::write(root.join("a.ts"), "const a = 1;\n").expect("temp file a.ts should be written");
		fs::write(root.join("nested").join("b.ts"), "const b = 2;\n")
			.expect("temp file nested/b.ts should be written");
		root
	}

	fn retained_test_match(line: u32) -> RetainedAstFindMatch {
		RetainedAstFindMatch {
			key:            AstFindOrderKey {
				path:         "file.ts".to_string(),
				start_line:   line,
				start_column: 1,
				end_line:     line,
				end_column:   2,
				byte_start:   line - 1,
				byte_end:     line,
				sequence:     u64::from(line),
			},
			text:           String::new(),
			meta_variables: None,
		}
	}

	#[test]
	fn retained_find_matches_keep_only_page_window() {
		let capacity = retained_find_capacity(1, 2);
		let mut retained = BinaryHeap::new();
		let mut materialized_payloads = 0usize;
		for line in 1..=100 {
			let candidate = retained_test_match(line);
			if should_retain_match(&retained, capacity, &candidate.key) {
				materialized_payloads += 1;
				retain_bounded_match(&mut retained, capacity, candidate);
			}
		}

		let (page, limit_reached) = page_retained_matches(retained, 1, 2);
		let lines = page
			.into_iter()
			.map(|retained| retained.key.start_line)
			.collect::<Vec<_>>();

		assert_eq!(materialized_payloads, capacity);
		assert!(limit_reached);
		assert_eq!(lines, vec![2, 3]);
	}

	type FoundView = (String, [u32; 6], u64, String, Vec<(String, String)>);

	fn view(found: &RetainedAstFindMatch) -> FoundView {
		let key = &found.key;
		let mut meta: Vec<_> = found
			.meta_variables
			.clone()
			.unwrap_or_default()
			.into_iter()
			.collect();
		meta.sort();
		(
			key.path.clone(),
			[
				key.start_line,
				key.start_column,
				key.end_line,
				key.end_column,
				key.byte_start,
				key.byte_end,
			],
			key.sequence,
			found.text.clone(),
			meta,
		)
	}

	/// Search `root` as `astGrep` does, keeping every match.
	fn search_all(root: &Path, patterns: &[String]) -> FindOutcome {
		let strictness = MatchStrictness::Smart;
		let run = FindRun::new(patterns, None, None, &strictness, usize::MAX, true);
		let scope = resolve_scope(Some(root.to_string_lossy().into_owned()), None)
			.expect("the scope should resolve");
		run.search_scope(&scope, &task::CancelToken::default())
			.expect("the search should succeed");
		run.finish()
	}

	/// WHY: a structure search walked its tree into a list and then searched
	/// the list. It now searches each file as the parallel walk yields it, in
	/// no fixed order, and merges each file's tally under a lock.
	///
	/// The class this closes is any difference the arrival order or the merge
	/// makes: a match kept or dropped at the page boundary, the order of two
	/// patterns' matches of one node, a count, a matched file, the file count,
	/// or a diagnostic out of path order. The reference searches the files one
	/// after another in path order with nothing bounded; the streamed search
	/// must give its result for every page window.
	///
	/// What it does not catch: a cancellation that lands mid-search, which
	/// fails the search either way and which the search-abort suite drives.
	#[test]
	fn a_streamed_search_returns_what_one_pass_over_the_files_returns() {
		assert!(
			veyyon_walker::walk_workers() > 1,
			"the walker pool must have workers to split the files"
		);
		let root = veyyon_test_scratch::scratch_dir("natives-ast-parallel-find");
		for index in 0..96_usize {
			let dir = root.join(format!("d{}", index % 7));
			fs::create_dir_all(&dir).expect("fixture dir should be created");
			let mut source = String::new();
			for call in 0..(index * 5 % 13) {
				write!(source, "foo({call});\nbar({index}, {call});\n")
					.expect("writing to a String cannot fail");
			}
			if index % 11 == 3 {
				source.push_str("const = ;\n");
			}
			fs::write(dir.join(format!("f{index:03}.ts")), source)
				.expect("fixture file should be written");
		}
		for index in 0..4 {
			fs::write(
				root
					.join(format!("d{index}"))
					.join(format!("bad{index}.ts")),
				[0xff, 0xfe, 0xfd],
			)
			.expect("unreadable fixture should be written");
		}
		// A file the batch cannot open reports what a read by path reports. It
		// holds no call, so where it opens (as root) it reports nothing.
		let locked = root.join("d5").join("locked.ts");
		fs::write(&locked, "const locked = 1;\n").expect("locked fixture should be written");
		#[cfg(unix)]
		let locked_fails = {
			use std::os::unix::fs::PermissionsExt;
			fs::set_permissions(&locked, fs::Permissions::from_mode(0o000))
				.expect("locked fixture should lose its permissions");
			File::open(&locked).is_err()
		};
		#[cfg(not(unix))]
		let locked_fails = false;

		let ct = task::CancelToken::default();
		let strictness = MatchStrictness::Smart;
		let patterns = ["foo($A)", "foo($$$ARGS)", "bar($$$)"].map(String::from);
		let root_path = Some(root.path().to_string_lossy().into_owned());

		let reference = FindRun::new(&patterns, None, None, &strictness, usize::MAX, true);
		for candidate in collect_candidates(root_path.clone(), None, &ct)
			.expect("candidate collection should succeed")
		{
			reference
				.search_file(&candidate.absolute_path, &candidate.display_path, &ct)
				.expect("a file search should succeed");
		}
		let FindOutcome {
			retained,
			total_matches: total,
			files_with_matches: files,
			files_searched,
			diagnostics: errors,
		} = reference.finish();
		let mut all = retained.into_vec();
		all.sort_by(|left, right| left.key.cmp(&right.key));
		// Every unreadable file, and every broken file that holds `foo` or
		// `bar`; `f091.ts` is broken and holds neither, so it is not parsed.
		let mut diagnosed: Vec<String> = (0..4)
			.map(|index| format!("d{index}/bad{index}.ts"))
			.chain(
				(0..96_usize)
					.filter(|index| index % 11 == 3 && index * 5 % 13 > 0)
					.map(|index| format!("d{}/f{index:03}.ts", index % 7)),
			)
			.chain(locked_fails.then(|| "d5/locked.ts".to_owned()))
			.collect();
		diagnosed.sort();
		assert_eq!(
			errors
				.iter()
				.map(|error| error.split(": ").next().unwrap_or_default())
				.collect::<Vec<_>>(),
			diagnosed,
			"{errors:?}"
		);
		assert!(
			all.windows(2).any(|pair| {
				pair[0].key.byte_start == pair[1].key.byte_start
					&& pair[0].key.byte_end == pair[1].key.byte_end
					&& pair[0].key.path == pair[1].key.path
			}),
			"the fixture must hold two patterns' matches of one node"
		);

		let scope = resolve_scope(root_path, None).expect("the scope should resolve");
		for (offset, limit) in [(0, 1), (0, 7), (3, 5), (40, 100), (0, 1000), (1500, 400), (0, 5000)]
		{
			let capacity = retained_find_capacity(offset, limit);
			let expected: Vec<FoundView> = all
				.iter()
				.skip(offset as usize)
				.take(limit as usize)
				.map(view)
				.collect();
			let case = format!("offset {offset}, limit {limit}");
			let run = FindRun::new(&patterns, None, None, &strictness, capacity, true);
			run.search_scope(&scope, &ct)
				.expect("the search should succeed");
			let outcome = run.finish();
			assert_eq!(outcome.total_matches, total, "{case}: total");
			assert_eq!(outcome.files_with_matches, files, "{case}: files");
			assert_eq!(outcome.files_searched, files_searched, "{case}: files searched");
			assert_eq!(outcome.diagnostics, errors, "{case}: diagnostics");
			let (page, limit_reached) = page_retained_matches(outcome.retained, offset, limit);
			assert_eq!(page.iter().map(view).collect::<Vec<_>>(), expected, "{case}: page");
			assert_eq!(limit_reached, all.len() > (offset + limit) as usize, "{case}: limit reached");
		}
	}

	#[test]
	fn glob_star_matches_only_direct_children() {
		let tree = make_temp_tree();
		let ct = task::CancelToken::default();
		let candidates =
			collect_candidates(Some(tree.path().to_string_lossy().into_owned()), Some("*.ts"), &ct)
				.expect("candidate collection should succeed");
		let paths = candidates
			.into_iter()
			.map(|file| file.display_path)
			.collect::<Vec<_>>();
		assert_eq!(paths, vec!["a.ts".to_string()]);
	}

	#[test]
	fn glob_double_star_matches_recursively() {
		let tree = make_temp_tree();
		let ct = task::CancelToken::default();
		let candidates =
			collect_candidates(Some(tree.path().to_string_lossy().into_owned()), Some("**/*.ts"), &ct)
				.expect("candidate collection should succeed");
		let paths = candidates
			.into_iter()
			.map(|file| file.display_path)
			.collect::<Vec<_>>();
		assert_eq!(paths, vec!["a.ts".to_string(), "nested/b.ts".to_string()]);
	}
	fn make_mixed_temp_tree() -> TempTree {
		let root = veyyon_test_scratch::scratch_dir("natives-ast-mixed-lang");
		fs::write(root.join("a.ts"), "const a = 1;\n").expect("temp file a.ts should be written");
		fs::write(root.join("b.rs"), "fn main() {}\n").expect("temp file b.rs should be written");
		root
	}

	#[test]
	fn infers_single_replace_lang_for_uniform_candidates() {
		let tree = make_temp_tree();
		let ct = task::CancelToken::default();
		let candidates =
			collect_candidates(Some(tree.path().to_string_lossy().into_owned()), Some("**/*.ts"), &ct)
				.expect("candidate collection should succeed");
		let inferred =
			infer_single_replace_lang(&candidates, &ct).expect("language should be inferred");
		assert_eq!(inferred, "typescript");
	}

	#[test]
	fn rejects_mixed_replace_lang_inference() {
		let tree = make_mixed_temp_tree();
		let ct = task::CancelToken::default();
		let candidates =
			collect_candidates(Some(tree.path().to_string_lossy().into_owned()), None, &ct)
				.expect("candidate collection should succeed");
		let err = infer_single_replace_lang(&candidates, &ct)
			.expect_err("mixed language inference should fail");
		assert!(err.to_string().contains("multiple languages"));
	}
	#[test]
	fn resolves_supported_language_aliases() {
		assert_eq!(resolve_supported_lang("ts").ok(), Some(SupportLang::TypeScript));
		assert_eq!(resolve_supported_lang("jsx").ok(), Some(SupportLang::JavaScript));
		assert_eq!(resolve_supported_lang("rs").ok(), Some(SupportLang::Rust));
		assert_eq!(resolve_supported_lang("kotlin").ok(), Some(SupportLang::Kotlin));
		assert_eq!(resolve_supported_lang("bash").ok(), Some(SupportLang::Bash));
		assert_eq!(resolve_supported_lang("c").ok(), Some(SupportLang::C));
		assert_eq!(resolve_supported_lang("cpp").ok(), Some(SupportLang::Cpp));
		assert_eq!(resolve_supported_lang("tla").ok(), Some(SupportLang::Tlaplus));
		assert_eq!(resolve_supported_lang("pluscal").ok(), Some(SupportLang::Tlaplus));
		assert_eq!(resolve_supported_lang("emacs-lisp").ok(), Some(SupportLang::EmacsLisp));
		assert_eq!(resolve_supported_lang("elisp").ok(), Some(SupportLang::EmacsLisp));
		assert_eq!(resolve_supported_lang("el").ok(), Some(SupportLang::EmacsLisp));
		assert_eq!(resolve_supported_lang("f90").ok(), Some(SupportLang::Fortran));
		assert!(resolve_supported_lang("brainfuck").is_err());
	}

	#[test]
	fn applies_non_overlapping_edits() {
		let source = "const answer = 41;";
		let edits = vec![
			Edit::<String> { position: 6, deleted_length: 6, inserted_text: b"value".to_vec() },
			Edit::<String> { position: 15, deleted_length: 2, inserted_text: b"42".to_vec() },
		];
		let output = apply_edits(source, &edits).expect("edits should apply");
		assert_eq!(output, "const value = 42;");
	}

	#[test]
	fn rejects_overlapping_edits() {
		let source = "abcdef";
		let edits = vec![
			Edit::<String> { position: 1, deleted_length: 3, inserted_text: b"x".to_vec() },
			Edit::<String> { position: 2, deleted_length: 1, inserted_text: b"y".to_vec() },
		];
		assert!(apply_edits(source, &edits).is_err());
	}

	#[test]
	fn dedupes_byte_identical_edits() {
		let source = "abcdef";
		let edits = vec![
			Edit::<String> { position: 1, deleted_length: 3, inserted_text: b"x".to_vec() },
			Edit::<String> { position: 1, deleted_length: 3, inserted_text: b"x".to_vec() },
		];
		let output = apply_edits(source, &edits).expect("identical edits should collapse to one");
		assert_eq!(output, "axef");
	}

	#[test]
	fn ast_edit_dedupes_identical_matches_across_rules() {
		let tree = veyyon_test_scratch::scratch_dir("natives-ast-dedupe");
		let file_path = tree.join("a.ts");
		fs::write(&file_path, "const b = foo(bar);\n").expect("temp file a.ts should be written");

		// Both rules match the same call node and produce the byte-identical
		// replacement; the deterministic edit must apply once, not error as an
		// ambiguous overlap.
		let mut rewrites = HashMap::new();
		rewrites.insert("foo($X)".to_string(), "qux($X)".to_string());
		rewrites.insert("foo(bar)".to_string(), "qux(bar)".to_string());

		let result = ast_edit_blocking(
			task::CancelToken::default(),
			Some(rewrites),
			Some("ts".to_string()),
			Some(tree.path().to_string_lossy().into_owned()),
			None,
			None,
			None,
			Some(false),
			None,
			None,
			None,
		)
		.expect("identical duplicate matches should apply cleanly");

		assert_eq!(result.total_replacements, 1, "duplicate match must be counted once");
		assert_eq!(
			fs::read_to_string(&file_path).expect("a.ts should be readable"),
			"const b = qux(bar);\n",
		);
	}

	/// A PHP file that closes PHP with `?>` and goes on as HTML is searched and
	/// rewritten whole.
	///
	/// Such a file parsed under the PHP-only grammar, which reads the HTML as
	/// an error: the search missed the call after it and reported a parse
	/// error, and the rewrite skipped the file. `veyyon_ast`'s
	/// `document_grammar` suite pins the patterns to the grammar files parse
	/// with; this drives both tools through their own paths.
	#[test]
	fn a_php_file_that_goes_on_as_html_is_searched_and_rewritten_whole() {
		let root = veyyon_test_scratch::scratch_dir("natives-ast-php-html");
		let source = "<?php\nfunction render($items) {\n    file_put_contents('a', $items);\n    \
		              ?>\n    <ul><?php foreach ($items as $item): ?><li><?= $item ?></li><?php \
		              endforeach; ?></ul>\n    <?php\n    file_put_contents('b', $items);\n}\n";
		fs::write(root.join("view.php"), source).expect("view.php should be written");
		let pattern = "file_put_contents($$$ARGS);".to_string();
		let outcome = search_all(root.path(), std::slice::from_ref(&pattern));
		assert_eq!(outcome.diagnostics, Vec::<String>::new());
		let mut found: Vec<(u32, String)> = outcome
			.retained
			.into_vec()
			.into_iter()
			.map(|found| (found.key.start_line, found.text))
			.collect();
		found.sort();
		assert_eq!(found, [
			(3, "file_put_contents('a', $items);".to_string()),
			(7, "file_put_contents('b', $items);".to_string()),
		]);

		let rewrites = HashMap::from([(pattern, "safe_put($$$ARGS);".to_string())]);
		let result = ast_edit_blocking(
			task::CancelToken::default(),
			Some(rewrites),
			Some("php".to_string()),
			Some(root.path().to_string_lossy().into_owned()),
			None,
			None,
			None,
			Some(false),
			None,
			None,
			Some(true),
		)
		.expect("the rewrite should succeed");
		assert_eq!(result.total_replacements, 2);
		assert_eq!(
			fs::read_to_string(root.join("view.php")).expect("view.php should be readable"),
			source.replace("file_put_contents(", "safe_put("),
		);
	}

	/// A `$$$` binding is the source its nodes span. ast-grep's own conversion
	/// lists the nodes one by one, so the comma between two arguments became an
	/// element of its own (`[a, ,, b]`) that appears nowhere in the file. Every
	/// language whose argument list separates with a token produced it; this
	/// covers four, the empty capture, a capture written without spaces and a
	/// single capture beside them.
	#[test]
	fn a_multi_capture_binds_the_source_it_spans() {
		let root = veyyon_test_scratch::scratch_dir("natives-ast-multi-capture");
		fs::write(root.join("a.ts"), "foo(a, b);\nfoo();\nfoo(x,y);\nbar(z);\n")
			.expect("a.ts should be written");
		fs::write(root.join("b.py"), "foo(a, b)\n").expect("b.py should be written");
		fs::write(root.join("c.rs"), "fn main() {\n    foo(a, b);\n}\n")
			.expect("c.rs should be written");
		fs::write(root.join("d.php"), "<?php\nfoo($a, $b);\n").expect("d.php should be written");
		let patterns = ["foo($$$A)".to_string(), "bar($X)".to_string()];

		let outcome = search_all(root.path(), &patterns);
		assert_eq!(outcome.diagnostics, Vec::<String>::new());
		type Found = (String, u32, Vec<(String, String)>);
		let mut found: Vec<Found> = outcome
			.retained
			.into_vec()
			.into_iter()
			.map(|found| {
				let mut bindings: Vec<_> = found
					.meta_variables
					.unwrap_or_default()
					.into_iter()
					.collect();
				bindings.sort();
				(found.key.path, found.key.start_line, bindings)
			})
			.collect();
		found.sort();
		let bound = |name: &str, value: &str| vec![(name.to_string(), value.to_string())];
		assert_eq!(found, [
			("a.ts".to_string(), 1, bound("A", "[a, b]")),
			("a.ts".to_string(), 2, bound("A", "[]")),
			("a.ts".to_string(), 3, bound("A", "[x,y]")),
			("a.ts".to_string(), 4, bound("X", "z")),
			("b.py".to_string(), 1, bound("A", "[a, b]")),
			("c.rs".to_string(), 2, bound("A", "[a, b]")),
			("d.php".to_string(), 2, bound("A", "[$a, $b]")),
		]);
	}

	/// WHY: every parsed file was walked node by node to look for an ERROR
	/// node. tree-sitter marks each node whose subtree holds an error or a
	/// missing node, so `holds_error_node` walks only a marked tree.
	///
	/// The class this closes is a tree reported clean or broken by the mark
	/// alone: a grammar whose ERROR node left the root unmarked, or a missing
	/// node taken for an error. Every language is swept over broken and clean
	/// sources and compared with the full walk, and the sweep must hold trees
	/// of both kinds. It does not catch a grammar none of these sources breaks.
	#[test]
	fn an_error_node_is_found_whether_or_not_the_tree_is_walked() {
		const SOURCES: &[&str] = &[
			"",
			"x",
			"x = 1",
			"foo(",
			"foo(bar",
			"a = ;",
			"}",
			"{",
			"if (",
			"(((",
			"\"",
			"<?php foo(",
			"def f(:",
			"fn f( {",
			"<div",
			"1 +",
			"SELECT FROM",
		];
		let (mut with_error, mut missing_only) = (0_usize, 0_usize);
		let mut disagreements = Vec::new();
		for &lang in SupportLang::all_langs() {
			let document = lang.document();
			for source in SOURCES {
				let ast = document.ast_grep(*source);
				let root = ast.root();
				let walked = root.dfs().any(|node| node.is_error());
				if walked {
					with_error += 1;
				} else if root.get_inner_node().has_error() {
					missing_only += 1;
				}
				if holds_error_node(&root) != walked {
					disagreements.push(format!("{} {source:?}", lang.canonical_name()));
				}
			}
		}
		assert_eq!(disagreements, Vec::<String>::new());
		assert!(with_error > 100, "the sweep must hold trees with an ERROR node, held {with_error}");
		assert!(missing_only > 0, "the sweep must hold a tree marked only by a missing node");
	}

	/// WHY: a structure search parsed every file in scope, so a search for a
	/// rare call over millions of files parsed millions of files that could not
	/// hold it. A file without a pattern's required text is now skipped before
	/// the parse.
	///
	/// The class this closes is a skip that changes what a caller is told: a
	/// file is parsed, and its parse error reported, when the required text of
	/// at least one pattern is all in it, for a search and a rewrite alike, and
	/// a rewrite that must parse every file still parses every file. That the
	/// skip is sound, that a file it rules out holds no match, is the
	/// `required_text` sweep in `veyyon_ast`.
	#[test]
	fn a_file_that_cannot_hold_a_match_is_not_parsed() {
		let root = veyyon_test_scratch::scratch_dir("natives-ast-required-text");
		for (name, source) in [
			("holds.ts", "foo(bar);\nconst = ;\n"),
			("half.ts", "foo(baz);\nconst = ;\n"),
			("second.ts", "qux(1);\nconst = ;\n"),
			("neither.ts", "const = ;\n"),
		] {
			fs::write(root.join(name), source).expect("fixture file should be written");
		}
		let parse_error =
			|name: &str| format!("{name}: parse error (syntax tree contains error nodes)");

		let outcome = search_all(root.path(), &["foo(bar)".to_string(), "qux($A)".to_string()]);
		assert_eq!(outcome.files_searched, 4);
		assert_eq!(outcome.diagnostics, [parse_error("holds.ts"), parse_error("second.ts")]);
		let mut found: Vec<_> = outcome
			.retained
			.into_vec()
			.into_iter()
			.map(|found| (found.key.path, found.text))
			.collect();
		found.sort();
		assert_eq!(found, [
			("holds.ts".to_string(), "foo(bar)".to_string()),
			("second.ts".to_string(), "qux(1)".to_string()),
		]);

		let rewrite = |fail_on_parse_error| {
			ast_edit_blocking(
				task::CancelToken::default(),
				Some(HashMap::from([("foo(bar)".to_string(), "done(bar)".to_string())])),
				Some("ts".to_string()),
				Some(root.path().to_string_lossy().into_owned()),
				None,
				None,
				None,
				Some(true),
				None,
				None,
				Some(fail_on_parse_error),
			)
		};
		let lenient = rewrite(false).expect("a lenient rewrite should succeed");
		assert_eq!(lenient.files_searched, 4);
		assert_eq!(lenient.parse_errors, Some(vec![parse_error("holds.ts")]));
		let strict = rewrite(true)
			.err()
			.expect("a strict rewrite parses every file");
		assert_eq!(strict.reason, parse_error("half.ts"));
	}

	fn make_apply_failure_tree() -> TempTree {
		let root = veyyon_test_scratch::scratch_dir("natives-ast-apply-fail");
		// `a.ts` rewrites cleanly under both rules (one applies, the other doesn't
		// match).
		fs::write(root.join("a.ts"), "const a = bar;\n").expect("temp file a.ts should be written");
		// `b.ts` matches both rules with nested ranges (`foo(bar)` contains `bar`),
		// so `apply_edits` rejects the combined edit set with an overlap error.
		fs::write(root.join("b.ts"), "const b = foo(bar);\n")
			.expect("temp file b.ts should be written");
		root
	}

	#[test]
	fn ast_edit_does_not_partially_write_when_apply_fails() {
		let tree = make_apply_failure_tree();
		let a_path = tree.join("a.ts");
		let b_path = tree.join("b.ts");
		let a_before = fs::read_to_string(&a_path).expect("a.ts should be readable");
		let b_before = fs::read_to_string(&b_path).expect("b.ts should be readable");

		let mut rewrites = HashMap::new();
		rewrites.insert("bar".to_string(), "baz".to_string());
		rewrites.insert("foo($X)".to_string(), "qux($X)".to_string());

		let result = ast_edit_blocking(
			task::CancelToken::default(),
			Some(rewrites),
			Some("ts".to_string()),
			Some(tree.path().to_string_lossy().into_owned()),
			None,
			None,
			None,
			Some(false),
			None,
			None,
			None,
		);
		assert!(result.is_err(), "expected ast_edit to error on overlapping edits");

		assert_eq!(
			fs::read_to_string(&a_path).expect("a.ts should still be readable"),
			a_before,
			"a.ts must not be written when the apply pass fails on a later file",
		);
		assert_eq!(
			fs::read_to_string(&b_path).expect("b.ts should still be readable"),
			b_before,
			"b.ts must remain unmodified after apply failure",
		);
	}
}
