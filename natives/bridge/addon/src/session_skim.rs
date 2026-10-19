//! The session skim of `veyyon-session-skim` over a descriptor the caller holds
//! open.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::{napi_error::to_napi_with, task};

/// What moves out of a session entry, as the load that parses the skim decides
/// it.
#[napi(object)]
pub struct SessionSkimRules {
	/// A line shorter than this many bytes is reported whole.
	pub min_line_bytes:        u32,
	/// A string of at least this many UTF-16 code units moves.
	pub min_string_length:     u32,
	/// An entry's members that never move.
	pub resident_keys:         Vec<String>,
	/// A message's members that never move.
	pub message_resident_keys: Vec<String>,
	/// A compaction's members that move; every other member of it stays.
	pub compaction_moved_keys: Vec<String>,
	/// A string starting with one of these moves whatever its length.
	pub large_string_prefixes: Vec<String>,
	/// Entry types reported whole.
	pub whole_entry_types:     Vec<String>,
	/// Lines at the start of the read reported by length alone.
	pub raw_lines:             u32,
	/// The longest line the caller reads; the skim stops before a longer one.
	pub max_line_bytes:        f64,
	/// The skim stops at the end of the first block whose lines bring its
	/// output to this many bytes; the caller skims again from `end`.
	pub output_bytes:          f64,
}

/// The skim of a session file: one JSON value per line, and where the lines it
/// covers end.
#[napi(object)]
pub struct SessionSkim {
	/// One JSON value per line, each followed by a line feed.
	pub lines: Buffer,
	/// The offset just past the line feed of the last line reported.
	pub end:   f64,
}

fn names(names: Vec<String>) -> Vec<Vec<u8>> {
	names.into_iter().map(String::into_bytes).collect()
}

/// Skim the session file open at descriptor `fd` from byte `start`, reading it
/// on the thread pool through a duplicate of `fd`, so the caller may close its
/// own once the promise settles.
///
/// Each line is reported as the record the load keeps for a cold entry: small
/// values copied, each value `rules` moves replaced by an empty value of its
/// kind (see `veyyon_session_skim`).
#[napi]
pub fn skim_session_file(
	fd: i32,
	start: f64,
	rules: SessionSkimRules,
) -> Result<task::Promise<SessionSkim>> {
	let file = duplicate(fd)?;
	let rules = veyyon_session_skim::SkimRules {
		min_line_bytes:        rules.min_line_bytes as usize,
		min_string_units:      rules.min_string_length as usize,
		resident_keys:         names(rules.resident_keys),
		message_resident_keys: names(rules.message_resident_keys),
		compaction_moved_keys: names(rules.compaction_moved_keys),
		large_string_prefixes: names(rules.large_string_prefixes),
		whole_entry_types:     names(rules.whole_entry_types),
		raw_lines:             rules.raw_lines as usize,
		max_line_bytes:        rules.max_line_bytes.max(0.0) as usize,
		output_bytes:          rules.output_bytes.max(0.0) as usize,
	};
	let start = start.max(0.0) as u64;
	Ok(task::blocking("session_skim", (), move |_| {
		let skimmed = veyyon_session_skim::skim_file(&file, start, &rules)
			.map_err(|error| to_napi_with("session skim: reading the session file failed", error))?;
		Ok(SessionSkim { lines: skimmed.lines.into(), end: skimmed.end as f64 })
	}))
}

#[cfg(unix)]
fn duplicate(fd: i32) -> Result<std::fs::File> {
	use std::os::fd::BorrowedFd;
	if fd < 0 {
		return Err(Error::from_reason(format!("session skim: descriptor {fd} is negative")));
	}
	// SAFETY: the caller holds `fd` open for the duration of this call, which
	// duplicates it before returning; the duplicate is what the thread pool reads.
	let borrowed = unsafe { BorrowedFd::borrow_raw(fd) };
	borrowed
		.try_clone_to_owned()
		.map(std::fs::File::from)
		.map_err(|error| {
			to_napi_with(format_args!("session skim: duplicating descriptor {fd} failed"), error)
		})
}

#[cfg(not(unix))]
fn duplicate(fd: i32) -> Result<std::fs::File> {
	Err(Error::from_reason(format!(
		"session skim: descriptor {fd} is not a POSIX descriptor; a session is skimmed only where \
		 its file is pinned by one"
	)))
}
