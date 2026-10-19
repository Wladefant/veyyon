//! Session JSONL lines reported as the records a load keeps for cold entries.
//!
//! A load of a session file that holds compacted history parses every line and
//! then moves the large values of each entry a compaction summarized back to
//! disk, behind accessors that read the line again on first use. [`skim_file`]
//! reads such a file once, in parallel, and reports each line as that cold
//! record: every small value copied byte for byte, and each value the load
//! would move replaced by an empty value of the same kind, so the caller parses
//! kilobytes where the line holds megabytes.
//!
//! [`SkimRules`] holds the caller's rules for what moves; this crate applies
//! them and holds none of its own. The field names the projection reads are the
//! session format's: an entry's `type`, `message` and `preserveData`, a
//! message's `role`, `toolName`, `content` and `details`, a content block's
//! `type`, a details object's `usage`, and the `remoteCompaction` object of a
//! compaction's `preserveData`.
//!
//! An entry's stand-in is the object of it whose members move one by one while
//! the object itself stays: a message entry's `message`, and a compaction's
//! `preserveData.remoteCompaction`, which holds the server-side window. A
//! compaction moves nothing else: every context build reads its members.
//!
//! # Output
//!
//! One JSON value per line read, each followed by a line feed:
//! - `n`: the line is `n` bytes and the caller parses it itself. It is one of
//!   the first [`SkimRules::raw_lines`]; or it is at least
//!   [`SkimRules::min_line_bytes`] and moves nothing, so a copy would hold as
//!   many bytes as the line; or the projection cannot state that a JSON parse
//!   of the line gives the values it copies: the line is not one strict JSON
//!   object, holds a byte below U+0020 or invalid UTF-8, nests deeper than
//!   [`MAX_DEPTH`], or has an analyzed key that is escaped, repeated, starts
//!   with a digit, or is past the 31st.
//! - `[n, record]`: a line shorter than [`SkimRules::min_line_bytes`], itself.
//! - `[n, record, keys, standInKeys, toolCalls, taskUsage]`: the projection.
//!   Bit `i` of `keys` is set when the `i`th member of `record` moved, and bit
//!   `i` of `standInKeys` when the `i`th member of the entry's stand-in did.
//!   `toolCalls` is the number of `toolCall` blocks in the moved content of an
//!   assistant message, or -1. `taskUsage` is `0` unless the entry is a `task`
//!   tool result whose details moved; then it is the `usage` member of the
//!   details when that is an object or an array, and `null` otherwise.

use std::{fs::File, io, ops::Range};

use memchr::{memchr_iter, memchr2, memrchr};
use rayon::prelude::*;

/// Nesting depth past which a line is left to the caller's parser.
pub const MAX_DEPTH: u32 = 256;

/// Members of an analyzed object a mask can name: bit 31 would read as a sign
/// in JavaScript.
const MAX_ANALYZED_MEMBERS: usize = 31;

/// Bytes read from the file at a time, before the complete lines among them are
/// projected.
const BLOCK_BYTES: usize = 4 << 20;

/// Bytes of a block one parallel read copies.
const READ_BYTES: usize = 1 << 20;

/// Parallel tasks a block is cut into per thread of the pool, so a task that
/// meets the long lines of a block does not hold up the rest of the pool.
const TASKS_PER_THREAD: usize = 4;

/// What moves out of an entry, as the caller's load decides it.
#[derive(Clone, Debug)]
pub struct SkimRules {
	/// A line shorter than this is reported whole, and a longer one that moves
	/// nothing is left to the caller: the load keeps such an entry in memory.
	pub min_line_bytes:        usize,
	/// A string of at least this many UTF-16 code units moves.
	pub min_string_units:      usize,
	/// An entry's members that never move.
	pub resident_keys:         Vec<Vec<u8>>,
	/// A message's members that never move.
	pub message_resident_keys: Vec<Vec<u8>>,
	/// A string that decodes to a value starting with one of these moves
	/// whatever its length.
	pub large_string_prefixes: Vec<Vec<u8>>,
	/// Entry types that move nothing: the load reads more of them than the
	/// projection keeps.
	pub whole_entry_types:     Vec<Vec<u8>>,
	/// Lines at the start of the read reported by length alone.
	pub raw_lines:             usize,
	/// The longest line the caller reads; the skim stops before a longer one.
	pub max_line_bytes:        usize,
	/// The skim stops at the end of the first block whose lines bring the
	/// output to this many bytes, so a caller that skims again from
	/// [`Skimmed::end`] holds about this much output at a time.
	pub output_bytes:          usize,
}

/// The lines of a file the skim reported, and the offset just past the last of
/// them.
#[derive(Debug)]
pub struct Skimmed {
	/// One JSON value per line, each followed by a line feed (see the crate
	/// documentation).
	pub lines: Vec<u8>,
	/// The offset just past the line feed of the last line reported. A last line
	/// without a line feed, every line from one longer than
	/// [`SkimRules::max_line_bytes`] on, and every line after a block that
	/// brought the output to [`SkimRules::output_bytes`] start here.
	pub end:   u64,
}

/// Report the complete lines of `file` from byte `start` on, up to the end of
/// the file or of the block that brings the output to
/// [`SkimRules::output_bytes`].
///
/// The file is read through `file`'s positional reads only, so the file offset
/// of a descriptor shared with the caller does not move. The next block is read
/// while the lines of the one before it are projected.
///
/// # Errors
/// Returns the error of a read that failed.
pub fn skim_file(file: &File, start: u64, rules: &SkimRules) -> io::Result<Skimmed> {
	let mut lines = Vec::new();
	let mut tasks: Vec<Task> = std::iter::repeat_with(Task::default)
		.take(rayon::current_num_threads() * TASKS_PER_THREAD)
		.collect();
	let mut current = vec![0_u8; BLOCK_BYTES];
	let mut next = vec![0_u8; BLOCK_BYTES];
	let mut filled = read_full(file, &mut current, start)?;
	let mut position = start;
	let mut line_number = 0_usize;
	loop {
		// A read stops short of a full buffer only at the end of the file.
		let at_end = filled < current.len();
		let Some(last) = memrchr(b'\n', &current[..filled]) else {
			if at_end || current.len() > rules.max_line_bytes {
				break;
			}
			// One line fills the buffer.
			current.resize(current.len() * 2, 0);
			filled += read_full(file, &mut current[filled..], position + filled as u64)?;
			continue;
		};
		let consumed = last + 1;
		let carried = filled - consumed;
		if next.len() < current.len() {
			next.resize(current.len(), 0);
		}
		next[..carried].copy_from_slice(&current[consumed..filled]);
		let next_position = position + consumed as u64;
		let (stopped, read) = rayon::join(
			|| project_block(&current[..last], rules, &mut line_number, &mut tasks, &mut lines),
			|| {
				if at_end {
					Ok(0)
				} else {
					read_full(file, &mut next[carried..], next_position + carried as u64)
				}
			},
		);
		if let Some(stop) = stopped {
			return Ok(Skimmed { lines, end: position + stop as u64 });
		}
		if lines.len() >= rules.output_bytes {
			// The next block read is dropped: the caller skims again from here.
			return Ok(Skimmed { lines, end: next_position });
		}
		std::mem::swap(&mut current, &mut next);
		filled = carried + read?;
		position = next_position;
	}
	Ok(Skimmed { lines, end: position })
}

/// Fill `buffer` from `offset` on, stopping short only at the end of the file.
/// The buffer is read in [`READ_BYTES`] pieces at once: one thread copying from
/// the page cache reads a block slower than the pool projects one.
fn read_full(file: &File, buffer: &mut [u8], offset: u64) -> io::Result<usize> {
	let pieces: Vec<(io::Result<usize>, usize)> = buffer
		.par_chunks_mut(READ_BYTES)
		.enumerate()
		.map(|(index, piece)| {
			(read_piece(file, piece, offset + (index * READ_BYTES) as u64), piece.len())
		})
		.collect();
	let mut filled = 0;
	for (read, len) in pieces {
		let read = read?;
		filled += read;
		if read < len {
			break;
		}
	}
	Ok(filled)
}

/// Fill `piece` from `offset` on, stopping short only at the end of the file.
fn read_piece(file: &File, piece: &mut [u8], offset: u64) -> io::Result<usize> {
	let mut filled = 0;
	while filled < piece.len() {
		let read = read_at(file, &mut piece[filled..], offset + filled as u64)?;
		if read == 0 {
			break;
		}
		filled += read;
	}
	Ok(filled)
}

#[cfg(unix)]
fn read_at(file: &File, buffer: &mut [u8], offset: u64) -> io::Result<usize> {
	use std::os::unix::fs::FileExt as _;
	loop {
		match file.read_at(buffer, offset) {
			Err(error) if error.kind() == io::ErrorKind::Interrupted => {},
			result => return result,
		}
	}
}

#[cfg(windows)]
fn read_at(file: &File, buffer: &mut [u8], offset: u64) -> io::Result<usize> {
	use std::os::windows::fs::FileExt as _;
	loop {
		match file.seek_read(buffer, offset) {
			Err(error) if error.kind() == io::ErrorKind::Interrupted => {},
			result => return result,
		}
	}
}

/// The lines of `block`, a run of lines joined by line feeds with no line feed
/// after the last.
fn line_ranges(block: &[u8]) -> impl Iterator<Item = Range<usize>> + '_ {
	let mut begin = 0;
	memchr_iter(b'\n', block)
		.map(Some)
		.chain([None])
		.map(move |feed| {
			let end = feed.unwrap_or(block.len());
			let range = begin..end;
			begin = end + 1;
			range
		})
}

/// What one parallel task of a skim keeps from block to block: its output and
/// the member lists of the line it analyzes. Reusing them leaves the projection
/// without a heap allocation per line, which kept a projection on many threads
/// no faster than on one: a process whose allocator had grown and returned
/// large buffers on each thread served every later one through calls that
/// serialize across threads.
#[derive(Default)]
struct Task {
	out:     Vec<u8>,
	scratch: Scratch,
}

/// The member lists [`analyze`] fills, kept between lines.
#[derive(Default)]
struct Scratch {
	entry:     Vec<Member>,
	message:   Vec<Member>,
	preserved: Vec<Member>,
	remote:    Vec<Member>,
}

/// Report the lines of `block` up to the first longer than
/// [`SkimRules::max_line_bytes`], and return where that one starts in `block`
/// when there is one.
fn project_block(
	block: &[u8],
	rules: &SkimRules,
	line_number: &mut usize,
	tasks: &mut [Task],
	out: &mut Vec<u8>,
) -> Option<usize> {
	let mut ranges: Vec<Range<usize>> = line_ranges(block).collect();
	let stop = ranges
		.iter()
		.position(|range| range.len() > rules.max_line_bytes);
	let stop = stop.map(|index| {
		let start = ranges[index].start;
		ranges.truncate(index);
		start
	});
	let raw = rules
		.raw_lines
		.saturating_sub(*line_number)
		.min(ranges.len());
	for range in &ranges[..raw] {
		write_number(out, range.len());
		out.push(b'\n');
	}
	*line_number += ranges.len();
	let lines = &ranges[raw..];
	let spans = task_spans(lines, tasks.len());
	let tasks = &mut tasks[..spans.len()];
	tasks
		.par_iter_mut()
		.zip(spans.par_iter())
		.for_each(|(task, span)| {
			task.out.clear();
			for range in &lines[span.clone()] {
				project_into(&block[range.clone()], rules, &mut task.scratch, &mut task.out);
				task.out.push(b'\n');
			}
		});
	out.reserve(tasks.iter().map(|task| task.out.len()).sum());
	for task in tasks.iter() {
		out.extend_from_slice(&task.out);
	}
	stop
}

/// `lines` cut into at most `count` runs of consecutive lines holding about as
/// many bytes each.
fn task_spans(lines: &[Range<usize>], count: usize) -> Vec<Range<usize>> {
	let total: usize = lines.iter().map(|range| range.len() + 1).sum();
	let share = total.div_ceil(count.max(1)).max(1);
	let mut spans = Vec::with_capacity(count);
	let mut begin = 0;
	let mut bytes = 0;
	for (index, range) in lines.iter().enumerate() {
		bytes += range.len() + 1;
		if bytes >= share && spans.len() + 1 < count {
			spans.push(begin..index + 1);
			begin = index + 1;
			bytes = 0;
		}
	}
	if begin < lines.len() {
		spans.push(begin..lines.len());
	}
	spans
}

/// Write the report of one line, without the line feed after it.
pub fn project_line(line: &[u8], rules: &SkimRules, out: &mut Vec<u8>) {
	project_into(line, rules, &mut Scratch::default(), out);
}

/// [`project_line`] with the member lists of `scratch`.
fn project_into(line: &[u8], rules: &SkimRules, scratch: &mut Scratch, out: &mut Vec<u8>) {
	if line.len() >= rules.min_line_bytes && leads_with_whole_type(line, rules) {
		write_number(out, line.len());
		return;
	}
	let analyzed = if plain(line) {
		analyze(line, scratch)
	} else {
		Err(Rejected)
	};
	let Ok(entry) = analyzed else {
		write_number(out, line.len());
		return;
	};
	let entry_type = text_member(line, entry.members, b"type");
	let is_type =
		|name: &[u8]| entry_type.is_some_and(|text| decodes_to(text_bytes(line, text), name, true));
	let whole = line.len() < rules.min_line_bytes
		|| entry_type.is_none()
		|| rules.whole_entry_types.iter().any(|name| is_type(name));
	let compaction = is_type(b"compaction");
	let stand_in = if compaction {
		entry.preserved.as_ref().and_then(|(at, preserved)| {
			let (inner, members) = preserved.remote?;
			// A mask names the window's members by position, and a parse keeps the
			// last of two `remoteCompaction` members.
			(check_keys(line, preserved.members).is_ok() && check_keys(line, members).is_ok())
				.then_some(StandIn::Window { at: *at, preserved: preserved.members, inner, members })
		})
	} else if is_type(b"message") {
		entry
			.message
			.as_ref()
			.map(|(at, message)| StandIn::Message { at: *at, message })
	} else {
		None
	};
	// Every context build reads a compaction's members: only its window moves.
	let mut keys = 0_u32;
	if !compaction {
		for (index, member) in entry.members.iter().enumerate() {
			let key = text_bytes(line, member.key);
			let resident = rules.resident_keys.iter().any(|name| name == key)
				|| matches!(stand_in, Some(StandIn::Message { at, .. }) if at == index);
			if !resident && is_large(line, member.kind, rules) {
				keys |= 1 << index;
			}
		}
	}
	let mut stand_in_keys = 0_u32;
	let (members, resident): (&[Member], &[Vec<u8>]) = match stand_in {
		Some(StandIn::Message { message, .. }) => (message.members, &rules.message_resident_keys),
		Some(StandIn::Window { members, .. }) => (members, &[]),
		None => (&[], &[]),
	};
	for (index, member) in members.iter().enumerate() {
		let key = text_bytes(line, member.key);
		if !resident.iter().any(|name| name == key) && is_large(line, member.kind, rules) {
			stand_in_keys |= 1 << index;
		}
	}
	if whole || (keys == 0 && stand_in_keys == 0) {
		if line.len() >= rules.min_line_bytes {
			write_number(out, line.len());
			return;
		}
		out.push(b'[');
		write_number(out, line.len());
		out.push(b',');
		out.extend_from_slice(line);
		out.push(b']');
		return;
	}
	out.push(b'[');
	write_number(out, line.len());
	out.push(b',');
	match stand_in.filter(|_| stand_in_keys != 0) {
		Some(StandIn::Message { at, message }) => {
			let message =
				|out: &mut Vec<u8>| write_members(out, line, message.members, stand_in_keys, None);
			write_members(out, line, entry.members, keys, Some((at, &message)));
		},
		Some(StandIn::Window { at, preserved, inner, members }) => {
			let window = |out: &mut Vec<u8>| write_members(out, line, members, stand_in_keys, None);
			let preserved =
				|out: &mut Vec<u8>| write_members(out, line, preserved, 0, Some((inner, &window)));
			write_members(out, line, entry.members, keys, Some((at, &preserved)));
		},
		None => write_members(out, line, entry.members, keys, None),
	}
	out.push(b',');
	write_number(out, keys as usize);
	out.push(b',');
	write_number(out, stand_in_keys as usize);
	out.push(b',');
	match stand_in {
		Some(StandIn::Message { message, .. }) => {
			write_tool_calls(out, line, message, stand_in_keys);
			out.push(b',');
			write_task_usage(out, line, message, stand_in_keys);
		},
		_ => out.extend_from_slice(b"-1,0"),
	}
	out.push(b']');
}

/// The object of an entry whose members move one by one while the object
/// itself stays.
#[derive(Clone, Copy)]
enum StandIn<'e, 'a> {
	/// A message entry's `message`, member `at` of the entry.
	Message { at: usize, message: &'e Message<'a> },
	/// The `remoteCompaction` object of a compaction, member `inner` of the
	/// `preserveData` object that is member `at` of the entry.
	Window { at: usize, preserved: &'a [Member], inner: usize, members: &'a [Member] },
}

/// A member index and the writer of that member's value in place of the
/// value's bytes.
type NestedWriter<'w> = (usize, &'w dyn Fn(&mut Vec<u8>));

/// Write the object whose members are `members`, each member `mask` states
/// moved replaced by an empty value of its kind, and the member at the index of
/// `nested`, when there is one, written by it.
fn write_members(
	out: &mut Vec<u8>,
	line: &[u8],
	members: &[Member],
	mask: u32,
	nested: Option<NestedWriter<'_>>,
) {
	out.push(b'{');
	for (index, member) in members.iter().enumerate() {
		if index > 0 {
			out.push(b',');
		}
		out.extend_from_slice(&line[member.key.start - 1..=member.key.end]);
		out.push(b':');
		if mask & (1 << index) != 0 {
			write_placeholder(out, member.kind);
		} else if let Some((_, write)) = nested.filter(|(at, _)| *at == index) {
			write(out);
		} else {
			out.extend_from_slice(&line[member.value.clone()]);
		}
	}
	out.push(b'}');
}

/// The number of `toolCall` blocks in the moved content of an assistant
/// message, or -1.
fn write_tool_calls(out: &mut Vec<u8>, line: &[u8], message: &Message, moved: u32) {
	let count = member_index(line, message.members, b"content")
		.filter(|index| moved & (1 << index) != 0)
		.and(message.tool_calls)
		.filter(|_| {
			text_member(line, message.members, b"role")
				.is_some_and(|role| decodes_to(text_bytes(line, role), b"assistant", true))
		});
	match count {
		Some(count) => write_number(out, count as usize),
		None => out.extend_from_slice(b"-1"),
	}
}

/// What a `task` tool result's moved details spent, as `taskUsage` reports it.
fn write_task_usage(out: &mut Vec<u8>, line: &[u8], message: &Message, moved: u32) {
	let details_moved = member_index(line, message.members, b"details")
		.is_some_and(|index| moved & (1 << index) != 0);
	let is_task = text_member(line, message.members, b"role")
		.is_some_and(|role| decodes_to(text_bytes(line, role), b"toolResult", true))
		&& text_member(line, message.members, b"toolName")
			.is_some_and(|name| decodes_to(text_bytes(line, name), b"task", true));
	if !(details_moved && is_task) {
		out.push(b'0');
		return;
	}
	match &message.task_usage {
		Some(range) => out.extend_from_slice(&line[range.clone()]),
		None => out.extend_from_slice(b"null"),
	}
}

fn write_placeholder(out: &mut Vec<u8>, kind: Kind) {
	out.extend_from_slice(match kind {
		Kind::Object => b"{}",
		Kind::Array => b"[]",
		Kind::Text(_) | Kind::Scalar => b"\"_\"",
	});
}

/// Write `value` in decimal.
fn write_number(out: &mut Vec<u8>, mut value: usize) {
	let mut digits = [0_u8; 20];
	let mut at = digits.len();
	loop {
		at -= 1;
		digits[at] = b'0' + (value % 10) as u8;
		value /= 10;
		if value == 0 {
			break;
		}
	}
	out.extend_from_slice(&digits[at..]);
}

/// Whether `line` opens with a `type` member naming one of
/// [`SkimRules::whole_entry_types`] without an escape, the order a session
/// writer puts it in: such a line moves nothing, and is reported without being
/// analyzed.
fn leads_with_whole_type(line: &[u8], rules: &SkimRules) -> bool {
	let Some(rest) = line.strip_prefix(b"{\"type\":\"") else {
		return false;
	};
	rules.whole_entry_types.iter().any(|name| {
		rest
			.strip_prefix(name.as_slice())
			.is_some_and(|tail| tail.first() == Some(&b'"'))
	})
}

/// Whether `line` is valid UTF-8 with no byte below U+0020, which no JSON
/// string holds unescaped and which a session writer never puts between tokens.
fn plain(line: &[u8]) -> bool {
	line
		.chunks(64)
		.all(|chunk| chunk.iter().copied().fold(u8::MAX, u8::min) >= 0x20)
		&& std::str::from_utf8(line).is_ok()
}

/// Whether a value of `kind` moves under `rules`: an object, an array, a string
/// of at least [`SkimRules::min_string_units`] UTF-16 code units, or a string
/// with a moving prefix.
fn is_large(line: &[u8], kind: Kind, rules: &SkimRules) -> bool {
	match kind {
		Kind::Object | Kind::Array => true,
		Kind::Scalar => false,
		Kind::Text(text) => {
			let raw = text_bytes(line, text);
			let min = rules.min_string_units;
			// Each code unit takes one to six bytes of the line: `\uXXXX` is six.
			if raw.len() >= min.saturating_mul(6)
				|| (raw.len() >= min && utf16_units(raw, text.adjust) >= min)
			{
				return true;
			}
			rules
				.large_string_prefixes
				.iter()
				.any(|prefix| decodes_to(raw, prefix, false))
		},
	}
}

/// UTF-16 code units of the string body `raw`, whose escapes are `adjust` bytes
/// longer than the code units they decode to. A lead byte starts one code unit,
/// or two when it starts a four-byte sequence.
fn utf16_units(raw: &[u8], adjust: usize) -> usize {
	let units: usize = raw
		.iter()
		.map(|&byte| usize::from(byte & 0xc0 != 0x80) + usize::from(byte >= 0xf0))
		.sum();
	units - adjust
}

/// Whether the string body `raw` decodes to `expected`, or to a string starting
/// with it when not `whole`. `expected` is ASCII, so a byte of `raw` above 0x7F
/// never matches one of it.
fn decodes_to(raw: &[u8], expected: &[u8], whole: bool) -> bool {
	let mut at = 0;
	for &want in expected {
		let Some(&byte) = raw.get(at) else {
			return false;
		};
		let (unit, width) = if byte == b'\\' {
			escape(raw, at)
		} else {
			(u16::from(byte), 1)
		};
		if unit != u16::from(want) {
			return false;
		}
		at += width;
	}
	!whole || at == raw.len()
}

/// The code unit of the validated escape at `raw[at]`, and its width in bytes.
fn escape(raw: &[u8], at: usize) -> (u16, usize) {
	match raw.get(at + 1).copied().unwrap_or(b'\\') {
		b'b' => (0x08, 2),
		b'f' => (0x0c, 2),
		b'n' => (0x0a, 2),
		b'r' => (0x0d, 2),
		b't' => (0x09, 2),
		b'u' => {
			let unit = raw
				.get(at + 2..at + 6)
				.unwrap_or_default()
				.iter()
				.fold(0_u16, |unit, &digit| (unit << 4) | u16::from(hex_value(digit)));
			(unit, 6)
		},
		other => (u16::from(other), 2),
	}
}

const fn hex_value(digit: u8) -> u8 {
	match digit {
		b'0'..=b'9' => digit - b'0',
		b'a'..=b'f' => digit - b'a' + 10,
		b'A'..=b'F' => digit - b'A' + 10,
		_ => 0,
	}
}

#[derive(Clone, Copy, Debug)]
struct Rejected;

type Scan<T> = Result<T, Rejected>;

/// A string's body: the bytes between its quotes.
#[derive(Clone, Copy, Debug)]
struct Text {
	start:   usize,
	end:     usize,
	escaped: bool,
	/// Bytes the escapes of the body take beyond the code units they decode to.
	adjust:  usize,
}

#[derive(Clone, Copy, Debug)]
enum Kind {
	Object,
	Array,
	Text(Text),
	Scalar,
}

#[derive(Debug)]
struct Member {
	key:   Text,
	value: Range<usize>,
	kind:  Kind,
}

#[derive(Debug)]
struct Message<'a> {
	members:    &'a [Member],
	/// `toolCall` blocks in the content, when the content is an array.
	tool_calls: Option<u32>,
	/// The last `usage` member of the details, when the details are an object
	/// and it is an object or an array.
	task_usage: Option<Range<usize>>,
}

#[derive(Debug)]
struct Entry<'a> {
	members:   &'a [Member],
	/// The index of the `message` member when its value is an object, and that
	/// object.
	message:   Option<(usize, Message<'a>)>,
	/// The index of the `preserveData` member when its value is an object, and
	/// that object.
	preserved: Option<(usize, Preserved<'a>)>,
}

/// A `preserveData` object, whose keys no check has read.
#[derive(Debug)]
struct Preserved<'a> {
	members: &'a [Member],
	/// The index of the `remoteCompaction` member when its value is an object,
	/// and the members of that object, whose keys no check has read.
	remote:  Option<(usize, &'a [Member])>,
}

fn text_bytes(line: &[u8], text: Text) -> &[u8] {
	&line[text.start..text.end]
}

fn member_index(line: &[u8], members: &[Member], name: &[u8]) -> Option<usize> {
	members
		.iter()
		.position(|member| text_bytes(line, member.key) == name)
}

/// The string value of the member `name`, or `None` when it is absent or not a
/// string.
fn text_member(line: &[u8], members: &[Member], name: &[u8]) -> Option<Text> {
	member_index(line, members, name).and_then(|index| match members[index].kind {
		Kind::Text(text) => Some(text),
		_ => None,
	})
}

/// Members of an analyzed object, which an object's key order and a mask must
/// both name: no escaped key, whose name only a decode states, no key a digit
/// starts, which may be an array index that an object lists before every other
/// key, no repeated key, and no more than a mask holds.
fn check_keys(line: &[u8], members: &[Member]) -> Scan<()> {
	if members.len() > MAX_ANALYZED_MEMBERS {
		return Err(Rejected);
	}
	for (index, member) in members.iter().enumerate() {
		let key = text_bytes(line, member.key);
		if member.key.escaped
			|| key.first().is_some_and(u8::is_ascii_digit)
			|| members[..index]
				.iter()
				.any(|earlier| text_bytes(line, earlier.key) == key)
		{
			return Err(Rejected);
		}
	}
	Ok(())
}

/// What [`parse_message`] reads off a message besides its members.
type MessageFacts = (Option<u32>, Option<Range<usize>>);

fn analyze<'s>(line: &[u8], scratch: &'s mut Scratch) -> Scan<Entry<'s>> {
	let Scratch {
		entry: members,
		message: message_members,
		preserved: preserved_members,
		remote: remote_members,
	} = scratch;
	members.clear();
	let mut parser = Parser { bytes: line, at: 0 };
	parser.space();
	let mut message: Option<(usize, MessageFacts)> = None;
	let mut preserved: Option<(usize, Option<usize>)> = None;
	parser.object(1, |parser, key, depth| {
		let start = parser.at;
		let name = if key.escaped {
			&[][..]
		} else {
			text_bytes(line, key)
		};
		let kind = if name == b"message" && parser.peek() == Some(b'{') {
			message = Some((members.len(), parse_message(parser, depth, message_members)?));
			Kind::Object
		} else if name == b"preserveData" && parser.peek() == Some(b'{') {
			let remote = parse_preserved(parser, depth, preserved_members, remote_members)?;
			preserved = Some((members.len(), remote));
			Kind::Object
		} else {
			parser.value(depth)?
		};
		members.push(Member { key, value: start..parser.at, kind });
		Ok(())
	})?;
	parser.space();
	if parser.at != line.len() {
		return Err(Rejected);
	}
	check_keys(line, members)?;
	let remote_members: &'s [Member] = remote_members;
	Ok(Entry {
		members,
		message: message.map(|(at, (tool_calls, task_usage))| {
			(at, Message { members: message_members, tool_calls, task_usage })
		}),
		preserved: preserved.map(|(at, remote)| {
			(at, Preserved {
				members: preserved_members,
				remote:  remote.map(|inner| (inner, remote_members)),
			})
		}),
	})
}

/// Read a `preserveData` object into `members`, and the members of its
/// `remoteCompaction` member into `remote`; return the index of that member
/// when its value is an object. The keys are checked only when the window
/// moves, so an entry that keeps its `preserveData` is projected whatever they
/// are.
fn parse_preserved(
	parser: &mut Parser<'_>,
	depth: u32,
	members: &mut Vec<Member>,
	remote: &mut Vec<Member>,
) -> Scan<Option<usize>> {
	let line = parser.bytes;
	members.clear();
	let mut at = None;
	parser.object(depth + 1, |parser, key, depth| {
		let start = parser.at;
		let kind = if !key.escaped
			&& text_bytes(line, key) == b"remoteCompaction"
			&& parser.peek() == Some(b'{')
		{
			at = Some(members.len());
			remote.clear();
			parser.object(depth + 1, |parser, key, depth| {
				let start = parser.at;
				let kind = parser.value(depth)?;
				remote.push(Member { key, value: start..parser.at, kind });
				Ok(())
			})?;
			Kind::Object
		} else {
			parser.value(depth)?
		};
		members.push(Member { key, value: start..parser.at, kind });
		Ok(())
	})?;
	Ok(at)
}

/// Read a message object into `members`, and return its tool calls and task
/// usage.
fn parse_message(
	parser: &mut Parser<'_>,
	depth: u32,
	members: &mut Vec<Member>,
) -> Scan<MessageFacts> {
	let line = parser.bytes;
	members.clear();
	let mut tool_calls = None;
	let mut task_usage = None;
	parser.object(depth + 1, |parser, key, depth| {
		let start = parser.at;
		let name = if key.escaped {
			&[][..]
		} else {
			text_bytes(line, key)
		};
		let kind = if name == b"content" && parser.peek() == Some(b'[') {
			tool_calls = Some(count_tool_calls(parser, depth)?);
			Kind::Array
		} else if name == b"details" && parser.peek() == Some(b'{') {
			task_usage = details_usage(parser, depth)?;
			Kind::Object
		} else {
			parser.value(depth)?
		};
		members.push(Member { key, value: start..parser.at, kind });
		Ok(())
	})?;
	check_keys(line, members)?;
	Ok((tool_calls, task_usage))
}

/// Blocks of a content array that are objects whose last `type` member is the
/// string `toolCall`.
fn count_tool_calls(parser: &mut Parser<'_>, depth: u32) -> Scan<u32> {
	let line = parser.bytes;
	let mut count = 0;
	parser.array(depth + 1, |parser, depth| {
		if parser.peek() != Some(b'{') {
			return parser.value(depth).map(drop);
		}
		let mut is_call = false;
		parser.object(depth + 1, |parser, key, depth| {
			if key.escaped {
				return Err(Rejected);
			}
			let kind = parser.value(depth)?;
			if text_bytes(line, key) == b"type" {
				is_call = matches!(kind, Kind::Text(text) if decodes_to(text_bytes(line, text), b"toolCall", true));
			}
			Ok(())
		})?;
		count += u32::from(is_call);
		Ok(())
	})?;
	Ok(count)
}

/// The last `usage` member of a details object, when it is an object or an
/// array.
fn details_usage(parser: &mut Parser<'_>, depth: u32) -> Scan<Option<Range<usize>>> {
	let line = parser.bytes;
	let mut usage = None;
	parser.object(depth + 1, |parser, key, depth| {
		if key.escaped {
			return Err(Rejected);
		}
		let start = parser.at;
		let kind = parser.value(depth)?;
		if text_bytes(line, key) == b"usage" {
			usage = matches!(kind, Kind::Object | Kind::Array).then(|| start..parser.at);
		}
		Ok(())
	})?;
	Ok(usage)
}

/// A strict JSON validator over one line, positioned at `at`.
struct Parser<'a> {
	bytes: &'a [u8],
	at:    usize,
}

impl Parser<'_> {
	fn peek(&self) -> Option<u8> {
		self.bytes.get(self.at).copied()
	}

	fn space(&mut self) {
		while matches!(self.peek(), Some(b' ' | b'\t' | b'\r' | b'\n')) {
			self.at += 1;
		}
	}

	fn expect(&mut self, byte: u8) -> Scan<()> {
		if self.peek() != Some(byte) {
			return Err(Rejected);
		}
		self.at += 1;
		Ok(())
	}

	/// One value of any kind.
	fn value(&mut self, depth: u32) -> Scan<Kind> {
		match self.peek() {
			Some(b'{') => {
				self.object(depth + 1, |parser, _, depth| parser.value(depth).map(drop))?;
				Ok(Kind::Object)
			},
			Some(b'[') => {
				self.array(depth + 1, |parser, depth| parser.value(depth).map(drop))?;
				Ok(Kind::Array)
			},
			Some(b'"') => self.text().map(Kind::Text),
			Some(b't') => self.word(b"true"),
			Some(b'f') => self.word(b"false"),
			Some(b'n') => self.word(b"null"),
			Some(b'-' | b'0'..=b'9') => self.number(),
			_ => Err(Rejected),
		}
	}

	/// An object at nesting `depth`, handing each member's key to `member`,
	/// which reads its value.
	fn object(
		&mut self,
		depth: u32,
		mut member: impl FnMut(&mut Self, Text, u32) -> Scan<()>,
	) -> Scan<()> {
		if depth > MAX_DEPTH {
			return Err(Rejected);
		}
		self.expect(b'{')?;
		self.space();
		if self.peek() == Some(b'}') {
			self.at += 1;
			return Ok(());
		}
		loop {
			let key = self.text()?;
			self.space();
			self.expect(b':')?;
			self.space();
			member(self, key, depth)?;
			self.space();
			match self.peek() {
				Some(b',') => {
					self.at += 1;
					self.space();
				},
				Some(b'}') => {
					self.at += 1;
					return Ok(());
				},
				_ => return Err(Rejected),
			}
		}
	}

	/// An array at nesting `depth`, with `element` reading each element.
	fn array(
		&mut self,
		depth: u32,
		mut element: impl FnMut(&mut Self, u32) -> Scan<()>,
	) -> Scan<()> {
		if depth > MAX_DEPTH {
			return Err(Rejected);
		}
		self.expect(b'[')?;
		self.space();
		if self.peek() == Some(b']') {
			self.at += 1;
			return Ok(());
		}
		loop {
			element(self, depth)?;
			self.space();
			match self.peek() {
				Some(b',') => {
					self.at += 1;
					self.space();
				},
				Some(b']') => {
					self.at += 1;
					return Ok(());
				},
				_ => return Err(Rejected),
			}
		}
	}

	fn text(&mut self) -> Scan<Text> {
		self.expect(b'"')?;
		let start = self.at;
		let mut at = start;
		let mut escaped = false;
		let mut adjust = 0;
		loop {
			at += memchr2(b'"', b'\\', &self.bytes[at..]).ok_or(Rejected)?;
			if self.bytes[at] == b'"' {
				self.at = at + 1;
				return Ok(Text { start, end: at, escaped, adjust });
			}
			escaped = true;
			match self.bytes.get(at + 1) {
				Some(b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't') => {
					adjust += 1;
					at += 2;
				},
				Some(b'u') => {
					let digits = self.bytes.get(at + 2..at + 6).ok_or(Rejected)?;
					if !digits.iter().all(u8::is_ascii_hexdigit) {
						return Err(Rejected);
					}
					adjust += 5;
					at += 6;
				},
				_ => return Err(Rejected),
			}
		}
	}

	fn word(&mut self, word: &[u8]) -> Scan<Kind> {
		if !self.bytes[self.at..].starts_with(word) {
			return Err(Rejected);
		}
		self.at += word.len();
		Ok(Kind::Scalar)
	}

	fn digits(&mut self) -> usize {
		let start = self.at;
		while self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
			self.at += 1;
		}
		self.at - start
	}

	fn number(&mut self) -> Scan<Kind> {
		if self.peek() == Some(b'-') {
			self.at += 1;
		}
		match self.peek() {
			Some(b'0') => self.at += 1,
			Some(b'1'..=b'9') => {
				self.digits();
			},
			_ => return Err(Rejected),
		}
		if self.peek() == Some(b'.') {
			self.at += 1;
			if self.digits() == 0 {
				return Err(Rejected);
			}
		}
		if matches!(self.peek(), Some(b'e' | b'E')) {
			self.at += 1;
			if matches!(self.peek(), Some(b'+' | b'-')) {
				self.at += 1;
			}
			if self.digits() == 0 {
				return Err(Rejected);
			}
		}
		Ok(Kind::Scalar)
	}
}
