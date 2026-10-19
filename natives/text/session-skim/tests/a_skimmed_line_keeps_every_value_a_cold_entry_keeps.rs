//! The report of a session line is the record a load keeps for that line's cold
//! entry.
//!
//! WHY: a load that parses the skim's report instead of the line keeps the
//! report's values as the entry's resident values, and parses the line itself
//! only when the report is a bare length. A report that copies a value the
//! parse of the line would decode differently, that keeps a value the
//! load moves, or that projects a line `JSON.parse` would refuse, puts a wrong
//! value into the session or keeps a record the full load drops. These tests
//! pin each rule the projection applies: what moves, what stays byte for byte,
//! what is counted for the stand-in, and every line it must hand back to the
//! caller's parser instead.
//!
//! They do not compare against the load in JavaScript; the kernel's equivalence
//! suite loads one file both ways and compares every entry.

use std::{fmt::Write as _, fs, io::Write as _};

use serde_json::{Value, json};
use veyyon_session_skim::{MAX_DEPTH, SkimRules, project_line, skim_file};
use veyyon_test_scratch::scratch_dir;

fn rules() -> SkimRules {
	let names = |names: &[&str]| names.iter().map(|name| name.as_bytes().to_vec()).collect();
	SkimRules {
		min_line_bytes:        64,
		min_string_units:      16,
		resident_keys:         names(&["type", "id", "parentId", "timestamp"]),
		message_resident_keys: names(&["usage"]),
		large_string_prefixes: names(&["blob:sha256:", "blobtext:sha256:"]),
		whole_entry_types:     names(&["session", "compaction"]),
		raw_lines:             0,
		max_line_bytes:        1 << 20,
		output_bytes:          usize::MAX,
	}
}

fn report_with(line: &[u8], rules: &SkimRules) -> Value {
	let mut out = Vec::new();
	project_line(line, rules, &mut out);
	serde_json::from_slice(&out).expect("a report is one JSON value")
}

fn report(line: &str) -> Value {
	report_with(line.as_bytes(), &rules())
}

/// A string of `units` ASCII letters.
fn letters(units: usize) -> String {
	"x".repeat(units)
}

mod what_moves {
	use super::*;

	#[test]
	fn a_moved_value_becomes_an_empty_value_of_its_kind_and_every_other_value_is_copied() {
		let id = letters(40);
		let line = format!(
			r#"{{"type":"custom","id":"{id}","data":{{"a":[1,2]}},"list":[1,{{"b":2}}],"note":"{}","flag":true,"count":-1.5e3,"short":"hi","none":null}}"#,
			letters(16)
		);
		let value = report(&line);
		assert_eq!(
			value,
			json!([
				line.len(),
				{"type":"custom","id":id,"data":{},"list":[],"note":"_","flag":true,"count":-1.5e3,"short":"hi","none":null},
				0b11100,
				0,
				-1,
				0
			])
		);
	}

	#[test]
	fn a_resident_key_is_copied_whatever_its_size() {
		let line = format!(
			r#"{{"type":"custom","id":"{}","parentId":{{"x":1}},"payload":{{"y":2}}}}"#,
			letters(300)
		);
		let value = report(&line);
		assert_eq!(value[1]["id"], json!(letters(300)));
		assert_eq!(value[1]["parentId"], json!({"x":1}));
		assert_eq!(value[2], json!(0b1000));
	}

	#[test]
	fn a_message_entry_keeps_its_message_and_projects_the_members_of_it() {
		let line = format!(
			r#"{{"type":"message","id":"a","message":{{"role":"assistant","content":[{{"type":"text","text":"{}"}}],"usage":{{"input":1,"output":2,"cacheRead":0,"cacheWrite":0}},"model":"m","stopReason":"{}"}}}}"#,
			letters(20),
			letters(16)
		);
		let value = report(&line);
		assert_eq!(
			value[1],
			json!({"type":"message","id":"a","message":{"role":"assistant","content":[],"usage":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0},"model":"m","stopReason":"_"}})
		);
		assert_eq!(value[2], json!(0), "the message itself never moves");
		assert_eq!(value[3], json!(0b10010));
	}

	#[test]
	fn a_message_that_is_not_an_object_moves_as_any_other_member() {
		let line = format!(
			r#"{{"type":"message","id":"a","message":[{{"role":"user"}}],"pad":"{}"}}"#,
			letters(40)
		);
		let value = report(&line);
		assert_eq!(value[1]["message"], json!([]));
		assert_eq!(value[2], json!(0b1100));
		assert_eq!(value[4], json!(-1));
	}

	#[test]
	fn the_message_of_an_entry_of_another_type_moves() {
		let line = format!(
			r#"{{"type":"custom","id":"a","message":{{"role":"user","content":"{}"}}}}"#,
			letters(40)
		);
		let value = report(&line);
		assert_eq!(value[1]["message"], json!({}));
		assert_eq!(value[2], json!(0b100));
		assert_eq!(value[3], json!(0));
	}

	#[test]
	fn a_short_line_is_reported_whole() {
		let short = r#"{"type":"custom","data":{"a":1}}"#;
		assert_eq!(report(short), json!([short.len(), {"type":"custom","data":{"a":1}}]));
		let compaction = r#"{"type":"compaction","data":{"a":1}}"#;
		assert_eq!(
			report(compaction),
			json!([compaction.len(), {"type":"compaction","data":{"a":1}}])
		);
	}

	#[test]
	fn a_long_line_that_names_a_whole_type_has_no_type_or_moves_nothing_is_handed_back() {
		for line in [
			format!(r#"{{"type":"compaction","id":"c","preserveData":{{"a":"{}"}}}}"#, letters(60)),
			format!(r#"{{"type":"session","id":"s","cwd":"{}"}}"#, letters(60)),
			format!(
				r#"{{"type":"compacti\u006fn","id":"c","preserveData":{{"a":"{}"}}}}"#,
				letters(60)
			),
			format!(r#"{{"id":"c","type":"compaction","preserveData":{{"a":"{}"}}}}"#, letters(60)),
			format!(r#"{{"id":"a","data":{{"a":"{}"}}}}"#, letters(60)),
			format!(r#"{{"type":7,"id":"a","data":{{"a":"{}"}}}}"#, letters(60)),
			format!(r#"{{"type":"custom","id":"{}","n":1,"s":"short"}}"#, letters(60)),
		] {
			assert_eq!(report(&line), json!(line.len()), "{line}");
		}
	}

	#[test]
	fn a_type_that_only_starts_with_a_whole_type_is_projected() {
		let line = format!(r#"{{"type":"compactionx","id":"c","data":{{"a":"{}"}}}}"#, letters(60));
		let value = report(&line);
		assert_eq!(value[1], json!({"type":"compactionx","id":"c","data":{}}));
		assert_eq!(value[2], json!(0b100));
	}
}

mod string_size {
	use super::*;

	/// Whether the string `body` moves: a line that moves nothing is handed
	/// back.
	fn moves(body: &str) -> bool {
		let line = format!(r#"{{"type":"custom","id":"{}","s":"{body}"}}"#, letters(60));
		let value = report(&line);
		if value == json!(line.len()) {
			return false;
		}
		assert_eq!(value.as_array().map(Vec::len), Some(6), "{line}");
		true
	}

	#[test]
	fn a_string_moves_at_the_unit_count_not_the_byte_count() {
		assert!(!moves(&letters(15)));
		assert!(moves(&letters(16)));
		// Two bytes, one unit each.
		assert!(!moves(&"é".repeat(15)));
		assert!(moves(&"é".repeat(16)));
		// Three bytes, one unit each.
		assert!(!moves(&"€".repeat(15)));
		assert!(moves(&"€".repeat(16)));
		// Four bytes, two units each.
		assert!(!moves(&format!("{}x", "😀".repeat(7))));
		assert!(moves(&"😀".repeat(8)));
	}

	#[test]
	fn an_escape_counts_as_the_unit_it_decodes_to() {
		assert!(!moves(&"\\n".repeat(15)));
		assert!(moves(&"\\n".repeat(16)));
		assert!(!moves(&"\\u00e9".repeat(15)));
		assert!(moves(&"\\u00e9".repeat(16)));
		assert!(!moves(&"\\ud83d\\ude00".repeat(7)));
		assert!(moves(&"\\ud83d\\ude00".repeat(8)));
	}

	#[test]
	fn a_short_string_moves_when_it_decodes_to_a_moving_prefix() {
		assert!(moves("blob:sha256:ab"));
		assert!(moves("blobtext:sha256:"));
		assert!(moves("blob\\u003asha256:ab"));
		assert!(moves("\\u0062lob:sha256:"));
		assert!(!moves("xblob:sha256:"));
		assert!(!moves("blob:sha25"));
	}
}

mod stand_in {
	use super::*;

	fn assistant(content: &str) -> String {
		format!(
			r#"{{"type":"message","id":"a","message":{{"role":"assistant","content":{content},"usage":{{"input":1,"output":2,"cacheRead":0,"cacheWrite":0}},"pad":"{}"}}}}"#,
			letters(40)
		)
	}

	#[test]
	fn an_assistant_message_counts_the_tool_call_blocks_its_moved_content_held() {
		let content = r#"[{"type":"toolCall","id":"1"},{"type":"text","text":"t"},{"type":"toolCall","type":"text"},{"type":"text","type":"toolCall"},{"type":"tool\u0043all"},"toolCall",["toolCall"],{"kind":"toolCall"}]"#;
		assert_eq!(report(&assistant(content))[4], json!(3));
		assert_eq!(report(&assistant("[]"))[4], json!(0));
	}

	#[test]
	fn a_message_without_moved_array_content_or_another_role_counts_nothing() {
		let text = assistant(&format!(r#""{}""#, letters(40)));
		assert_eq!(report(&text)[4], json!(-1));
		let user = assistant(r#"[{"type":"toolCall"}]"#).replace("assistant", "user");
		assert_eq!(report(&user)[4], json!(-1));
	}

	fn tool_result(tool: &str, details: &str) -> String {
		format!(
			r#"{{"type":"message","id":"a","message":{{"role":"toolResult","toolName":"{tool}","content":[{{"type":"text","text":"{}"}}],"details":{details}}}}}"#,
			letters(40)
		)
	}

	#[test]
	fn a_task_result_reports_the_last_usage_its_moved_details_held() {
		let usage = r#"{"input":3,"output":4,"cost":{"total":0.5}}"#;
		assert_eq!(
			report(&tool_result("task", &format!(r#"{{"agents":[],"usage":{usage}}}"#)))[5],
			json!({"input":3,"output":4,"cost":{"total":0.5}})
		);
		assert_eq!(report(&tool_result("task", r#"{"usage":{"a":1},"usage":[2]}"#))[5], json!([2]));
		assert_eq!(report(&tool_result("ta\\u0073k", r#"{"usage":{"a":1}}"#))[5], json!({"a":1}));
	}

	#[test]
	fn a_task_result_whose_details_hold_no_usage_object_reports_null() {
		for details in [
			r#"{"agents":[]}"#,
			r#"{"usage":7}"#,
			r#"{"usage":null}"#,
			r#"{"usage":{"a":1},"usage":"x"}"#,
			"[1]",
		] {
			assert_eq!(report(&tool_result("task", details))[5], Value::Null, "{details}");
		}
	}

	#[test]
	fn a_result_of_another_tool_reports_no_usage() {
		assert_eq!(report(&tool_result("read", r#"{"usage":{"a":1}}"#))[5], json!(0));
	}
}

mod remote_window {
	use super::*;

	/// The rules a load uses: a compaction is projected rather than whole.
	fn window_rules() -> SkimRules {
		SkimRules { whole_entry_types: vec![b"session".to_vec()], ..rules() }
	}

	fn window_report(line: &str) -> Value {
		report_with(line.as_bytes(), &window_rules())
	}

	fn compaction(preserve: &str) -> String {
		format!(
			r#"{{"type":"compaction","id":"c","summary":"{}","details":{{"readFiles":["a"]}},"firstKeptEntryId":"k","preserveData":{preserve}}}"#,
			letters(40)
		)
	}

	const REMOTE: &str = r#"{"version":1,"provider":"p","api":"a","model":"m","window":[{"type":"compaction","encrypted_content":"e"}],"compactedAt":"t"}"#;

	#[test]
	fn the_window_moves_and_every_other_value_of_the_compaction_is_copied() {
		let line = compaction(&format!(r#"{{"other":{{"x":[1]}},"remoteCompaction":{REMOTE}}}"#));
		assert_eq!(
			window_report(&line),
			json!([
				line.len(),
				{
					"type":"compaction",
					"id":"c",
					"summary":letters(40),
					"details":{"readFiles":["a"]},
					"firstKeptEntryId":"k",
					"preserveData":{
						"other":{"x":[1]},
						"remoteCompaction":{"version":1,"provider":"p","api":"a","model":"m","window":[],"compactedAt":"t"}
					}
				},
				0,
				0b10000,
				-1,
				0
			])
		);
	}

	#[test]
	fn every_large_member_of_the_remote_compaction_moves() {
		let remote = format!(r#"{{"model":"{}","window":"short","extra":{{"a":1}}}}"#, letters(16));
		let value = window_report(&compaction(&format!(r#"{{"remoteCompaction":{remote}}}"#)));
		assert_eq!(
			value[1]["preserveData"],
			json!({"remoteCompaction":{"model":"_","window":"short","extra":{}}})
		);
		assert_eq!(value[2], json!(0));
		assert_eq!(value[3], json!(0b101));
	}

	#[test]
	fn a_compaction_without_a_remote_compaction_object_moves_nothing_and_is_handed_back() {
		let summary_only = format!(
			r#"{{"type":"compaction","id":"c","summary":"{}","details":{{"a":[1]}}}}"#,
			letters(60)
		);
		for line in [
			summary_only,
			compaction(r#"{"other":{"x":[1]}}"#),
			compaction(r#"{"remoteCompaction":[{"window":[1]}]}"#),
			compaction(r#"{"remoteCompaction":"window"}"#),
			compaction(r#"{"remoteCompaction":{"version":1,"api":"a"}}"#),
			compaction(r#"[{"remoteCompaction":{"window":[1]}}]"#),
		] {
			assert_eq!(window_report(&line), json!(line.len()), "{line}");
		}
	}

	#[test]
	fn a_short_compaction_is_reported_whole() {
		let line = r#"{"type":"compaction","preserveData":{"remoteCompaction":{"window":[1]}}}"#;
		let rules = SkimRules { min_line_bytes: line.len() + 1, ..window_rules() };
		assert_eq!(
			report_with(line.as_bytes(), &rules),
			json!([line.len(), {"type":"compaction","preserveData":{"remoteCompaction":{"window":[1]}}}])
		);
	}

	#[test]
	fn the_preserve_data_of_another_entry_type_moves_as_any_other_member() {
		let preserve = format!(r#"{{"\u0061":1,"remoteCompaction":{REMOTE}}}"#);
		let custom = format!(
			r#"{{"type":"custom","id":"a","pad":"{}","preserveData":{preserve}}}"#,
			letters(40)
		);
		let value = window_report(&custom);
		assert_eq!(value[1], json!({"type":"custom","id":"a","pad":"_","preserveData":{}}));
		assert_eq!(value[2], json!(0b1100));
		assert_eq!(value[3], json!(0));
		let message = format!(
			r#"{{"type":"message","id":"a","message":{{"role":"user","content":"{}"}},"preserveData":{preserve}}}"#,
			letters(40)
		);
		let value = window_report(&message);
		assert_eq!(value[1]["preserveData"], json!({}));
		assert_eq!(value[2], json!(0b1000));
		assert_eq!(value[3], json!(0b10));
	}

	#[test]
	fn a_remote_compaction_key_a_parse_reads_otherwise_hands_the_compaction_back() {
		for preserve in [
			format!(r#"{{"remote\u0043ompaction":{REMOTE}}}"#),
			format!(r#"{{"remoteCompaction":{REMOTE},"remoteCompaction":{{"window":"x"}}}}"#),
			format!(r#"{{"remoteCompaction":{{"window":"x"}},"remoteCompaction":{REMOTE}}}"#),
			format!(r#"{{"remoteCompaction":{REMOTE},"remote\u0043ompaction":{{"window":"x"}}}}"#),
			r#"{"remoteCompaction":{"wind\u006fw":[1]}}"#.to_owned(),
			r#"{"remoteCompaction":{"window":[1],"window":[2]}}"#.to_owned(),
			r#"{"remoteCompaction":{"0":[1],"window":[2]}}"#.to_owned(),
			format!(r#"{{"1":2,"remoteCompaction":{REMOTE}}}"#),
		] {
			let line = compaction(&preserve);
			assert_eq!(window_report(&line), json!(line.len()), "{line}");
		}
	}

	#[test]
	fn an_escaped_or_repeated_preserve_data_key_hands_the_compaction_back() {
		for line in [
			format!(
				r#"{{"type":"compaction","id":"c","pad":"{}","preserve\u0044ata":{{"remoteCompaction":{REMOTE}}}}}"#,
				letters(40)
			),
			format!(
				r#"{{"type":"compaction","id":"c","preserveData":{{"remoteCompaction":{REMOTE}}},"preserveData":{{}}}}"#
			),
		] {
			assert_eq!(window_report(&line), json!(line.len()), "{line}");
		}
	}
}

mod handed_back {
	use super::*;

	fn assert_handed_back(line: &[u8]) {
		assert_eq!(
			report_with(line, &rules()),
			json!(line.len()),
			"{}",
			String::from_utf8_lossy(line)
		);
	}

	fn padded(body: &str) -> String {
		format!(r#"{{"type":"custom","id":"{}",{body}}}"#, letters(60))
	}

	#[test]
	fn a_line_that_is_not_one_strict_json_object_is_handed_back() {
		for body in [
			r#""a":[1,],"b":{"x":1}"#,
			r#""a":{"x":1,},"b":1"#,
			"a:1",
			"'a':1",
			r#""a":"\x""#,
			r#""a":"\u12""#,
			r#""a":01"#,
			r#""a":1."#,
			r#""a":.5"#,
			r#""a":1e"#,
			r#""a":+1"#,
			r#""a":tru"#,
			r#""a":nul"#,
			r#""a":"unterminated"#,
		] {
			assert_handed_back(padded(body).as_bytes());
		}
		for line in [
			format!("{} x", padded(r#""a":{"x":1}"#)),
			format!("{}{}", padded(r#""a":{"x":1}"#), padded(r#""b":1"#)),
			format!(r#"[{{"a":"{}"}}]"#, letters(80)),
			format!(r#""{}""#, letters(80)),
		] {
			assert_handed_back(line.as_bytes());
		}
	}

	#[test]
	fn a_line_holding_a_control_byte_invalid_utf8_or_a_byte_order_mark_is_handed_back() {
		assert_handed_back(padded("\"a\":\"tab\there\"").as_bytes());
		assert_handed_back(padded("\"a\":\t{\"x\":1}").as_bytes());
		let mut invalid = padded(r#""a":"xx""#).into_bytes();
		let at = invalid.len() - 3;
		invalid[at] = 0xff;
		assert_handed_back(&invalid);
		let mut bom = b"\xEF\xBB\xBF".to_vec();
		bom.extend_from_slice(padded(r#""a":{"x":1}"#).as_bytes());
		assert_handed_back(&bom);
	}

	#[test]
	fn an_analyzed_key_the_mask_cannot_name_exactly_hands_the_line_back() {
		assert_handed_back(padded(r#""a":{"x":1},"a":2"#).as_bytes());
		assert_handed_back(padded(r#""t\u0079pe":"message""#).as_bytes());
		assert_handed_back(padded(r#""1a":{"x":1}"#).as_bytes());
		let many = (0..30)
			.map(|index| format!(r#""k{index}":1"#))
			.collect::<Vec<_>>()
			.join(",");
		assert_handed_back(padded(&many).as_bytes());
		let message = |body: &str| {
			format!(
				r#"{{"type":"message","id":"{}","message":{{"role":"user",{body}}}}}"#,
				letters(60)
			)
		};
		assert_handed_back(message(r#""content":"a","content":"b""#).as_bytes());
		assert_handed_back(message(r#""cont\u0065nt":[]"#).as_bytes());
		assert_handed_back(message(r#""content":[{"t\u0079pe":"toolCall"}]"#).as_bytes());
		assert_handed_back(message(r#""details":{"us\u0061ge":{}}"#).as_bytes());
	}

	#[test]
	fn a_key_deeper_than_the_analysis_reads_is_copied_or_moved_as_it_is() {
		let line = padded(r#""a":{"x":1,"x":2,"\u0031":3},"b":"s""#);
		let value = report(&line);
		assert_eq!(value[1]["a"], json!({}));
		assert_eq!(value[2], json!(0b100));
	}

	#[test]
	fn a_line_nested_deeper_than_the_limit_is_handed_back() {
		let nest = |depth: usize| format!("{}1{}", "[".repeat(depth), "]".repeat(depth));
		// The entry is depth 1, so a member's array is depth 2.
		let at_limit = padded(&format!(r#""a":{}"#, nest(MAX_DEPTH as usize - 1)));
		assert_eq!(report(&at_limit)[2], json!(0b100));
		assert_handed_back(padded(&format!(r#""a":{}"#, nest(MAX_DEPTH as usize))).as_bytes());
	}
}

mod file {
	use super::*;

	fn line_reports(skimmed: &[u8]) -> Vec<Value> {
		skimmed
			.split(|&byte| byte == b'\n')
			.filter(|line| !line.is_empty())
			.map(|line| serde_json::from_slice(line).unwrap())
			.collect()
	}

	#[test]
	fn every_complete_line_after_the_start_is_reported_in_order_and_the_end_stops_before_a_partial_one()
	 {
		let dir = scratch_dir("session-skim-file");
		let path = dir.path().join("session.jsonl");
		let lines = [
			r#"{"type":"title","title":"t"}"#.to_owned(),
			r#"{"type":"session","id":"s"}"#.to_owned(),
			format!(r#"{{"type":"custom","id":"a","data":{{"x":"{}"}}}}"#, letters(80)),
			String::new(),
			r#"{"type":"custom","id":"b"}"#.to_owned(),
		];
		let mut text = lines.join("\n");
		text.push('\n');
		let complete = text.len();
		text.push_str(r#"{"type":"custom","id":"partial""#);
		fs::write(&path, &text).unwrap();
		let file = fs::File::open(&path).unwrap();
		let skimmed = skim_file(&file, 0, &SkimRules { raw_lines: 2, ..rules() }).unwrap();
		assert_eq!(skimmed.end, complete as u64);
		let reports = line_reports(&skimmed.lines);
		assert_eq!(reports.len(), lines.len());
		assert_eq!(reports[0], json!(lines[0].len()));
		assert_eq!(reports[1], json!(lines[1].len()));
		assert_eq!(reports[2][1], json!({"type":"custom","id":"a","data":{}}));
		assert_eq!(reports[3], json!(0));
		assert_eq!(reports[4], json!([lines[4].len(), {"type":"custom","id":"b"}]));

		let from_second = skim_file(&file, lines[0].len() as u64 + 1, &rules()).unwrap();
		assert_eq!(from_second.end, complete as u64);
		assert_eq!(line_reports(&from_second.lines).len(), lines.len() - 1);
	}

	#[test]
	fn the_skim_stops_before_a_line_longer_than_the_caller_reads() {
		let dir = scratch_dir("session-skim-limit");
		let path = dir.path().join("session.jsonl");
		let short = r#"{"type":"custom","id":"a"}"#;
		let long = format!(r#"{{"type":"custom","id":"b","s":"{}"}}"#, letters(200));
		fs::write(&path, format!("{short}\n{long}\n{short}\n")).unwrap();
		let file = fs::File::open(&path).unwrap();
		let skimmed = skim_file(&file, 0, &SkimRules { max_line_bytes: 100, ..rules() }).unwrap();
		assert_eq!(skimmed.end, short.len() as u64 + 1);
		assert_eq!(line_reports(&skimmed.lines).len(), 1);
	}

	#[test]
	fn a_line_spanning_two_reads_is_reported_once_and_whole() {
		let dir = scratch_dir("session-skim-blocks");
		let path = dir.path().join("session.jsonl");
		let mut file = fs::File::create(&path).unwrap();
		let rules = SkimRules { max_line_bytes: 64 << 20, ..rules() };
		let mut expected = Vec::new();
		let mut written = 0_usize;
		let mut index = 0;
		// Past several reads of the skim's buffer, with lines of several sizes
		// crossing them, and lines longer than one buffer.
		while written < (34 << 20) {
			let units = if index % 40 == 39 {
				9 << 20
			} else {
				1 + (index * 7919) % 300_000
			};
			let pad = letters(units);
			let line =
				format!(r#"{{"type":"custom","id":"{index}","data":{{"s":"{pad}"}},"n":{index}}}"#);
			file.write_all(line.as_bytes()).unwrap();
			file.write_all(b"\n").unwrap();
			written += line.len() + 1;
			let mut report = Vec::new();
			project_line(line.as_bytes(), &rules, &mut report);
			expected.push(serde_json::from_slice::<Value>(&report).unwrap());
			index += 1;
		}
		drop(file);
		let file = fs::File::open(&path).unwrap();
		let skimmed = skim_file(&file, 0, &rules).unwrap();
		assert_eq!(skimmed.end, written as u64);
		assert_eq!(line_reports(&skimmed.lines), expected);
	}

	#[test]
	fn a_skim_that_reaches_its_output_bound_ends_on_a_line_the_next_skim_starts_from() {
		let dir = scratch_dir("session-skim-bound");
		let path = dir.path().join("session.jsonl");
		let mut text = String::new();
		// Several of the skim's blocks of lines that each move a value.
		for index in 0..12_000 {
			let pad = letters(1 + (index * 7919) % 3000);
			writeln!(text, r#"{{"type":"custom","id":"{index}","data":{{"s":"{pad}"}}}}"#).unwrap();
		}
		fs::write(&path, &text).unwrap();
		let file = fs::File::open(&path).unwrap();
		let whole = skim_file(&file, 0, &rules()).unwrap();
		assert_eq!(whole.end, text.len() as u64);

		let bound = whole.lines.len() / 4;
		let rules = SkimRules { output_bytes: bound, ..rules() };
		let mut lines = Vec::new();
		let mut start = 0;
		let mut skims = 0;
		loop {
			let skimmed = skim_file(&file, start, &rules).unwrap();
			skims += 1;
			assert!(skims <= 12, "a skim from {start} made no progress toward the end");
			if skimmed.end == start {
				assert!(skimmed.lines.is_empty());
				break;
			}
			// A skim stops once its output reaches the bound, and only at the end.
			assert!(skimmed.end == whole.end || skimmed.lines.len() >= bound);
			lines.extend_from_slice(&skimmed.lines);
			start = skimmed.end;
		}
		assert!(skims > 2);
		assert_eq!(start, whole.end);
		assert_eq!(line_reports(&lines), line_reports(&whole.lines));
	}

	#[test]
	fn an_empty_file_reports_nothing() {
		let dir = scratch_dir("session-skim-empty");
		let path = dir.path().join("session.jsonl");
		fs::write(&path, "").unwrap();
		let file = fs::File::open(&path).unwrap();
		let skimmed = skim_file(&file, 0, &rules()).unwrap();
		assert_eq!(skimmed.end, 0);
		assert!(skimmed.lines.is_empty());
	}
}
