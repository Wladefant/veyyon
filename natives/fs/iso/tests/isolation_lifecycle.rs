//! Integration tests for the isolation backend lifecycle, candidate resolution,
//! error handling, failure teardown, and change diffing.

use std::{fs, path::Path};

use veyyon_iso::{BackendKind, ChangeKind, auto_order, backend, default_backend, resolve};
use veyyon_test_scratch::scratch_dir;

#[tokio::test]
async fn test_rcopy_lifecycle_and_diff() {
	let lower_scratch = scratch_dir("iso-rcopy-lower");
	let merged_scratch = scratch_dir("iso-rcopy-merged");

	let lower = lower_scratch.join("source");
	let merged = merged_scratch.join("workspace");
	fs::create_dir_all(&lower).expect("create lower directory");
	fs::write(lower.join("kept.txt"), "unchanged content\n").expect("write kept.txt");
	fs::write(lower.join("to_edit.txt"), "original line 1\noriginal line 2\n")
		.expect("write to_edit.txt");
	fs::write(lower.join("to_delete.txt"), "delete me\n").expect("write to_delete.txt");

	let backend = backend(BackendKind::Rcopy);
	assert_eq!(backend.kind(), BackendKind::Rcopy);

	let probe = backend.probe();
	assert!(probe.available, "Rcopy backend must always be available");
	assert!(probe.reason.is_none());

	// Start isolation
	backend.start(&lower, &merged).expect("start isolation");
	assert!(merged.exists(), "merged workspace must exist after start");
	assert_eq!(fs::read_to_string(merged.join("kept.txt")).unwrap(), "unchanged content\n");

	// Make changes in merged (with size difference for plain diff without git)
	fs::write(merged.join("to_edit.txt"), "original line 1\nmodified line 2 is longer\n")
		.expect("edit file");
	fs::remove_file(merged.join("to_delete.txt")).expect("delete file");
	fs::write(merged.join("created.txt"), "new file content\n").expect("create file");

	// Verify lower is completely untouched
	assert_eq!(
		fs::read_to_string(lower.join("to_edit.txt")).unwrap(),
		"original line 1\noriginal line 2\n"
	);
	assert!(lower.join("to_delete.txt").exists());
	assert!(!lower.join("created.txt").exists());

	// Capture diff
	let diff = backend.diff(&lower, &merged).await.expect("capture diff");
	assert!(!diff.is_empty());
	assert_eq!(diff.files.len(), 3);

	let added = diff
		.files
		.iter()
		.find(|f| f.path == Path::new("created.txt"))
		.expect("find created.txt");
	assert_eq!(added.op, ChangeKind::Added);
	assert!(
		added
			.diff
			.as_ref()
			.unwrap()
			.contains("new file mode 100644")
	);
	assert!(added.diff.as_ref().unwrap().contains("+new file content"));

	let modified = diff
		.files
		.iter()
		.find(|f| f.path == Path::new("to_edit.txt"))
		.expect("find to_edit.txt");
	assert_eq!(modified.op, ChangeKind::Modified);
	assert!(modified.diff.as_ref().unwrap().contains("-original line 2"));
	assert!(
		modified
			.diff
			.as_ref()
			.unwrap()
			.contains("+modified line 2 is longer")
	);

	let removed = diff
		.files
		.iter()
		.find(|f| f.path == Path::new("to_delete.txt"))
		.expect("find to_delete.txt");
	assert_eq!(removed.op, ChangeKind::Removed);
	assert!(
		removed
			.diff
			.as_ref()
			.unwrap()
			.contains("deleted file mode 100644")
	);
	assert!(removed.diff.as_ref().unwrap().contains("-delete me"));

	let unified = diff.unified_text();
	assert!(unified.contains("diff --git a/created.txt b/created.txt"));
	assert!(unified.contains("diff --git a/to_edit.txt b/to_edit.txt"));
	assert!(unified.contains("diff --git a/to_delete.txt b/to_delete.txt"));

	// Stop isolation and verify clean teardown
	backend.stop(&merged).expect("stop isolation");
	assert!(!merged.exists(), "merged workspace must be removed after stop");
}

#[test]
fn test_teardown_after_start_failure() {
	let scratch = scratch_dir("iso-fail-teardown");
	let nonexistent_lower = scratch.join("does_not_exist");
	let merged = scratch.join("merged_target");

	let backend = backend(BackendKind::Rcopy);
	let result = backend.start(&nonexistent_lower, &merged);
	assert!(result.is_err(), "start with nonexistent lower must fail");

	// Ensure no partial directory left behind
	assert!(!merged.exists(), "merged target must not exist after failed start");

	// Stopping after failed start must be safe and idempotent
	let stop_res = backend.stop(&merged);
	assert!(stop_res.is_ok(), "stopping after failed start must succeed");
}

#[test]
fn test_start_fails_when_lower_is_not_a_directory() {
	let scratch = scratch_dir("iso-not-dir");
	let file_lower = scratch.join("not_a_dir.txt");
	fs::write(&file_lower, "just a file\n").expect("write file");
	let merged = scratch.join("merged");

	let backend = backend(BackendKind::Rcopy);
	let result = backend.start(&file_lower, &merged);
	let err = result.expect_err("start with regular file must fail");
	assert!(
		err.message().contains("is not a directory"),
		"error message must state path is not a directory: {err}"
	);
}

#[test]
fn test_stop_is_idempotent_on_nonexistent_paths() {
	let scratch = scratch_dir("iso-idempotent-stop");
	let nonexistent = scratch.join("ghost_path");

	let backend = backend(BackendKind::Rcopy);
	assert!(backend.stop(&nonexistent).is_ok());
	assert!(backend.stop(&nonexistent).is_ok());
}

#[test]
fn test_backend_kind_and_probe_exhaustiveness() {
	let all_kinds = [
		BackendKind::Apfs,
		BackendKind::Btrfs,
		BackendKind::Zfs,
		BackendKind::LinuxReflink,
		BackendKind::Overlayfs,
		BackendKind::WindowsBlockClone,
		BackendKind::Projfs,
		BackendKind::Rcopy,
	];

	for kind in all_kinds {
		let b = backend(kind);
		assert_eq!(b.kind(), kind, "backend() must return struct with matching kind()");
		assert_eq!(
			BackendKind::from_str(kind.as_str()),
			Some(kind),
			"from_str round-trip for {}",
			kind.as_str()
		);
		let probe = b.probe();
		if !probe.available {
			assert!(
				probe.reason.is_some(),
				"unavailable probe for {kind:?} must provide a reason string"
			);
		}
	}
}

#[test]
fn test_candidate_resolution_and_fallback() {
	let order = auto_order();
	assert!(!order.is_empty(), "auto_order must not be empty");
	assert_eq!(
		*order.last().unwrap(),
		BackendKind::Rcopy,
		"Rcopy must be the final auto_order fallback"
	);

	// Preferred available backend (Rcopy)
	let res = resolve(Some(BackendKind::Rcopy));
	assert_eq!(res.kind, BackendKind::Rcopy);
	assert!(!res.fell_back);
	assert!(res.candidates.contains(&BackendKind::Rcopy));

	// Preferred unavailable backend on Linux (e.g. Apfs)
	#[cfg(not(target_os = "macos"))]
	{
		let res = resolve(Some(BackendKind::Apfs));
		assert_ne!(res.kind, BackendKind::Apfs);
		assert!(res.fell_back);
		assert!(res.reason.is_some());
	}

	// Automatic resolution without preference
	let auto_res = resolve(None);
	assert!(auto_res.candidates.contains(&BackendKind::Rcopy));
	assert!(backend(auto_res.kind).probe().available);

	// Default backend matches native kind
	assert_eq!(default_backend().kind(), BackendKind::native());
}

#[tokio::test]
async fn test_diff_binary_files() {
	let lower_scratch = scratch_dir("iso-bin-lower");
	let merged_scratch = scratch_dir("iso-bin-merged");

	let lower = lower_scratch.join("source");
	let merged = merged_scratch.join("workspace");
	fs::create_dir_all(&lower).expect("create lower");

	let bin_data_old = vec![0u8, 1, 2, 3, 255, 0, 128];
	let bin_data_new = vec![0u8, 1, 2, 99, 255, 0, 128, 42];
	fs::write(lower.join("data.bin"), &bin_data_old).expect("write binary old");

	let backend = backend(BackendKind::Rcopy);
	backend.start(&lower, &merged).expect("start");

	fs::write(merged.join("data.bin"), &bin_data_new).expect("write binary new");
	fs::write(merged.join("new_bin.dat"), vec![0u8, 255, 0]).expect("write new binary");

	let diff = backend.diff(&lower, &merged).await.expect("diff");
	backend.stop(&merged).expect("stop");

	let modified = diff
		.files
		.iter()
		.find(|f| f.path == Path::new("data.bin"))
		.expect("find data.bin");
	assert_eq!(modified.op, ChangeKind::Modified);
	assert!(modified.diff.is_none(), "binary diff must be None");

	let added = diff
		.files
		.iter()
		.find(|f| f.path == Path::new("new_bin.dat"))
		.expect("find new_bin.dat");
	assert_eq!(added.op, ChangeKind::Added);
	assert!(added.diff.is_none(), "binary diff must be None");
}
