// Copyright 2017 Google Inc.
//
// Use of this source code is governed by a MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

use std::{
	cell::RefCell,
	error::Error,
	ffi::OsString,
	io::Write,
	path::{Path, PathBuf},
};

use veyyon_uutils_ctx::{child_command, cwd, run_child, stderr};

use super::{Matcher, MatcherIO, WalkEntry};

enum Arg {
	FileArg(Vec<OsString>),
	LiteralArg(OsString),
}

pub struct SingleExecMatcher {
	executable:         String,
	args:               Vec<Arg>,
	exec_in_parent_dir: bool,
}

impl SingleExecMatcher {
	pub fn new(
		executable: &str,
		args: &[&str],
		exec_in_parent_dir: bool,
	) -> Result<Self, Box<dyn Error>> {
		let transformed_args = args
			.iter()
			.map(|&a| {
				let parts = a.split("{}").collect::<Vec<_>>();
				if parts.len() == 1 {
					// No {} present
					Arg::LiteralArg(OsString::from(a))
				} else {
					Arg::FileArg(parts.iter().map(OsString::from).collect())
				}
			})
			.collect();

		Ok(Self { executable: executable.to_string(), args: transformed_args, exec_in_parent_dir })
	}
}

impl Matcher for SingleExecMatcher {
	fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
		let path_to_file = if self.exec_in_parent_dir {
			if let Some(f) = file_info.path().file_name() {
				Path::new(".").join(f)
			} else {
				Path::new(".").join(file_info.path())
			}
		} else {
			file_info.display_path().to_path_buf()
		};

		let args: Vec<OsString> = self
			.args
			.iter()
			.map(|arg| match arg {
				Arg::LiteralArg(literal) => literal.clone(),
				Arg::FileArg(parts) => parts.join(path_to_file.as_os_str()),
			})
			.collect();
		// GNU runs `-exec` in find's working directory, and `-execdir` in the
		// directory holding the file. A root path like "/" has no parent and
		// runs from itself; a bare name like "foo" has a parent of "" and runs
		// from find's working directory.
		let dir = match file_info.path().parent() {
			_ if !self.exec_in_parent_dir => cwd(),
			None => file_info.path().to_path_buf(),
			Some(parent) if parent == Path::new("") => cwd(),
			Some(parent) => parent.to_path_buf(),
		};
		let status = child_command(&self.executable, dir).and_then(|mut command| {
			command.args(&args);
			run_child(&mut command)
		});
		match status {
			Ok(status) => status.success(),
			Err(e) => {
				let _ = writeln!(&mut stderr(), "Failed to run {}: {}", self.executable, e);
				false
			},
		}
	}

	fn has_side_effects(&self) -> bool {
		true
	}
}

pub struct MultiExecMatcher {
	executable:         String,
	args:               Vec<OsString>,
	exec_in_parent_dir: bool,
	/// Command to build while matching.
	command:            RefCell<Option<argmax::Command>>,
}

impl MultiExecMatcher {
	pub fn new(
		executable: &str,
		args: &[&str],
		exec_in_parent_dir: bool,
	) -> Result<Self, Box<dyn Error>> {
		let transformed_args = args.iter().map(OsString::from).collect();

		Ok(Self {
			executable: executable.to_string(),
			args: transformed_args,
			exec_in_parent_dir,
			command: RefCell::new(None),
		})
	}

	fn new_command(&self) -> argmax::Command {
		let mut command = argmax::Command::new(&self.executable);
		command.try_args(&self.args).unwrap();
		command
	}

	/// Runs the accumulated arguments as one child, from `dir` when `-execdir`
	/// set one and from find's working directory otherwise.
	fn run_command(
		&self,
		command: &argmax::Command,
		dir: Option<PathBuf>,
		matcher_io: &mut MatcherIO,
	) {
		let status =
			child_command(&self.executable, dir.unwrap_or_else(cwd)).and_then(|mut child| {
				child.args(command.get_args());
				run_child(&mut child)
			});
		match status {
			Ok(status) => {
				if !status.success() {
					matcher_io.set_exit_code(1);
				}
			},
			Err(e) => {
				let _ = writeln!(&mut stderr(), "Failed to run {}: {}", self.executable, e);
				matcher_io.set_exit_code(1);
			},
		}
	}
}

impl Matcher for MultiExecMatcher {
	fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
		let path_to_file = if self.exec_in_parent_dir {
			if let Some(f) = file_info.path().file_name() {
				Path::new(".").join(f)
			} else {
				Path::new(".").join(file_info.path())
			}
		} else {
			file_info.display_path().to_path_buf()
		};
		let mut command = self.command.borrow_mut();
		let command = command.get_or_insert_with(|| self.new_command());

		// Build command, or dispatch it before when it is long enough.
		if command.try_arg(&path_to_file).is_err() {
			let dir = if self.exec_in_parent_dir {
				match file_info.path().parent() {
					// Root paths like "/" have no parent. Run them from the root to match GNU
					// find.
					None => Some(file_info.path().to_path_buf()),
					// Paths like "foo" have a parent of "". Avoid chdir("").
					Some(parent) if parent == Path::new("") => None,
					Some(parent) => Some(parent.to_path_buf()),
				}
			} else {
				None
			};
			self.run_command(command, dir, matcher_io);

			// Reset command status.
			*command = self.new_command();
			if let Err(e) = command.try_arg(&path_to_file) {
				writeln!(
					&mut stderr(),
					"Cannot fit a single argument {}: {}",
					&path_to_file.to_string_lossy(),
					e
				)
				.unwrap();
				matcher_io.set_exit_code(1);
			}
		}
		true
	}

	fn finished_dir(&self, dir: &Path, matcher_io: &mut MatcherIO) {
		// Dispatch command for -execdir.
		if self.exec_in_parent_dir {
			let mut command = self.command.borrow_mut();
			if let Some(command) = command.take() {
				self.run_command(&command, Some(Path::new(".").join(dir)), matcher_io);
			}
		}
	}

	fn finished(&self, matcher_io: &mut MatcherIO) {
		// Dispatch command for -exec.
		if !self.exec_in_parent_dir {
			let mut command = self.command.borrow_mut();
			if let Some(command) = command.take() {
				self.run_command(&command, None, matcher_io);
			}
		}
	}

	fn has_side_effects(&self) -> bool {
		true
	}
}

#[cfg(test)]
/// No tests here, because we need to call out to an external executable. See
/// `tests/exec_unit_tests.rs` instead.
mod tests {}
