#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000,
    windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}
function countPaths(output) {
  return output.split('\0').filter(Boolean).length;
}
function inspectHistory(cwd, base, head) {
  for (const sha of [base, head]) {
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Expected full base and head commit SHAs');
  }
  const ancestor = git(cwd, ['merge-base', base, head]).trim();
  const netFiles = countPaths(git(cwd, ['diff', '--no-renames', '--name-only', '-z', ancestor, head]));
  const commits = git(cwd, ['rev-list', `${base}..${head}`]).trim().split('\n').filter(Boolean).map(sha => {
    const parent = git(cwd, ['show', '-s', '--format=%P', sha]).trim().split(' ')[0];
    const args = parent
      ? ['diff-tree', '--no-renames', '--name-only', '-r', '-z', parent, sha]
      : ['diff-tree', '--root', '--no-commit-id', '--no-renames', '--name-only', '-r', '-z', sha];
    return { sha, files: countPaths(git(cwd, args)) };
  });
  return { netFiles, commits };
}
function evaluate(report, labels) {
  if (!report || !Number.isSafeInteger(report.netFiles) || report.netFiles < 0 ||
      !Array.isArray(report.commits) || !Array.isArray(labels) ||
      !labels.every(label => typeof label === 'string') ||
      !report.commits.every(commit => /^[a-f0-9]{40}$/.test(commit.sha) && Number.isSafeInteger(commit.files) && commit.files >= 0)) {
    throw new Error('Invalid file-count metadata');
  }
  const approved = labels.includes('large-change-approved');
  const findings = [{ scope: 'Net PR diff', files: report.netFiles },
    ...report.commits.map(commit => ({ scope: `Commit ${commit.sha}`, files: commit.files }))]
    .filter(item => item.files > 1000)
    .map(item => ({ ...item, level: item.files > 5000 && !approved ? 'error' : 'warning' }));
  return { approved, findings, failed: findings.some(item => item.level === 'error') };
}
function printResult(report, labels) {
  const result = evaluate(report, labels);
  console.log(JSON.stringify({ ...report, ...result }, null, 2));
  for (const finding of result.findings) {
    console.log(`::${finding.level}::${finding.scope} changes ${finding.files} files. Above 5,000 files requires the large-change-approved label.`);
  }
  return result.failed ? 1 : 0;
}
function run() {
  const args = process.argv.slice(2);
  if (args[0] === '--local') {
    return printResult(inspectHistory(args[1], args[2], args[3]), args.slice(4));
  }
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const pr = event.pull_request;
  const repository = event.repository?.full_name;
  if (!pr || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) throw new Error('Missing PR repository metadata');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'large-change-gate-'));
  try {
    git(directory, ['init', '--bare']);
    git(directory, ['remote', 'add', 'origin', `https://github.com/${repository}.git`]);
    // Only trees and commits are needed. Never check out or execute PR content.
    git(directory, ['config', 'remote.origin.promisor', 'true']);
    git(directory, ['config', 'remote.origin.partialclonefilter', 'blob:none']);
    git(directory, ['fetch', '--filter=blob:none', '--no-tags', 'origin', pr.base.sha, pr.head.sha]);
    return printResult(inspectHistory(directory, pr.base.sha, pr.head.sha), pr.labels.map(label => label.name));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
if (require.main === module) {
  try { process.exitCode = run(); }
  catch (error) { console.error(`::error::Large-change guard failed: ${error.message}`); process.exitCode = 1; }
}
module.exports = { inspectHistory, evaluate };
