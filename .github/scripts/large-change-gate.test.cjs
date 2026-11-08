const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { evaluate, inspectHistory } = require('./large-change-gate.cjs');
const sha = 'a'.repeat(40);
for (const [files, level] of [[1000, null], [1001, 'warning'], [5000, 'warning'], [5001, 'error']]) {
  test(`net and individual commit thresholds at ${files}`, () => {
    for (const report of [{ netFiles: files, commits: [] }, { netFiles: 0, commits: [{ sha, files }] }]) {
      const result = evaluate(report, []);
      assert.equal(result.findings[0]?.level ?? null, level);
      assert.equal(result.failed, level === 'error');
    }
  });
}
test('only the exact approval label permits oversized changes', () => {
  const report = { netFiles: 14498, commits: [{ sha, files: 14498 }] };
  assert.equal(evaluate(report, ['large-change-approved']).failed, false);
  assert.equal(evaluate(report, ['large-change-approved']).findings.length, 2);
  assert.equal(evaluate(report, ['size:exempt', 'Large-change-approved']).failed, true);
});
test('invalid metadata fails closed', () => {
  for (const report of [null, { netFiles: -1, commits: [] }, { netFiles: 1, commits: [{}] }, { netFiles: NaN, commits: [] }]) {
    assert.throws(() => evaluate(report, []), /Invalid/);
  }
});
test('real git deletion and restoration fail despite an empty net diff', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'file-count-test-'));
  const git = (args, input) => execFileSync('git', ['-C', directory, ...args], {
    encoding: 'utf8', input, windowsHide: true, timeout: 30000,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Guard test', GIT_AUTHOR_EMAIL: 'guard@example.invalid',
      GIT_COMMITTER_NAME: 'Guard test', GIT_COMMITTER_EMAIL: 'guard@example.invalid' },
  }).trim();
  try {
    git(['init', '--bare']);
    const blob = git(['hash-object', '-w', '--stdin'], 'fixture\n');
    const tree = git(['mktree'], Array.from({ length: 5001 }, (_, i) => `100644 blob ${blob}\tfile-${String(i).padStart(5, '0')}\n`).join(''));
    const empty = git(['mktree'], '');
    const base = git(['commit-tree', tree, '-m', 'base']);
    const deletion = git(['commit-tree', empty, '-p', base, '-m', 'delete']);
    const head = git(['commit-tree', tree, '-p', deletion, '-m', 'restore']);
    const report = inspectHistory(directory, base, head);
    assert.equal(report.netFiles, 0);
    assert.deepEqual(report.commits.map(commit => commit.files), [5001, 5001]);
    assert.equal(evaluate(report, []).failed, true);
    assert.equal(evaluate(report, ['large-change-approved']).failed, false);
    assert.throws(() => inspectHistory(directory, '--unsafe', head), /Expected full/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
