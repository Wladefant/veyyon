#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ts } from 'ts-morph';

const root = process.cwd();
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}
const base = option('--base', 'origin/main');
const head = option('--head', 'HEAD');
const changedFile = option('--changed-files', null);
const dryRun = args.includes('--dry-run');
const changed = changedFile
  ? JSON.parse(fs.readFileSync(changedFile, 'utf8'))
  : execFileSync('git', ['diff', '--name-only', '-z', `${base}...${head}`], { encoding: 'utf8' }).split('\0').filter(Boolean);
const normalize = file => file.replaceAll(path.sep, '/').replace(/^\.\//, '');
const codeRx = /\.(?:[cm]?[jt]sx?)$/;
const testRx = /(?:\.test|\.spec)\.[cm]?[jt]sx?$/;
const jsTsRx = /\.(?:[cm]?[jt]sx?)$/;
const allTracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean).map(normalize).filter(file => fs.existsSync(file));
const sourceFiles = allTracked.filter(file => jsTsRx.test(file));
const tests = new Set(sourceFiles.filter(file => testRx.test(file)));
const changedSet = new Set(changed.map(normalize));
const deletedChanged = new Set([...changedSet].filter(file => !fs.existsSync(file)));
const changedCode = [...changedSet].filter(file => codeRx.test(file));
const roots = changedCode;
const configs = new Map();
const parsed = new Map();
const packageDirs = new Map();
const packageRecords = [];
const barrelCache = new Map();
const resolutionCache = new Map();
const exportLeafCache = new Map();
const moduleResolutionCaches = new WeakMap();
const moduleLeafCache = new Map();

for (const file of allTracked.filter(file => file.endsWith('package.json'))) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    continue;
  }
  const dir = normalize(path.dirname(file));
  packageRecords.push({ dir: dir === '.' ? '' : dir, name: manifest.name, manifest });
  if (manifest.name) packageDirs.set(manifest.name, dir === '.' ? '' : dir);
}
const optionsByDirectory = new Map();

const defaultCompilerOptions = {};
function optionsFor(file) {
  const importerPath = path.resolve(root, file);
  let dir = path.dirname(importerPath);
  if (optionsByDirectory.has(dir)) return optionsByDirectory.get(dir);
  while (dir === root || dir.startsWith(`${root}${path.sep}`)) {
    const config = path.join(dir, 'tsconfig.json');
    if (fs.existsSync(config)) {
      if (!configs.has(config)) {
        const read = ts.readConfigFile(config, ts.sys.readFile);
        const configHost = { ...ts.sys, readDirectory: () => [] };
        configs.set(config, ts.parseJsonConfigFileContent(read.config ?? {}, configHost, dir).options);
      }
      const options = configs.get(config);
      optionsByDirectory.set(path.dirname(importerPath), options);
      return options;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  optionsByDirectory.set(path.dirname(importerPath), defaultCompilerOptions);
  return defaultCompilerOptions;
}

function resolveUncached(specifier, importer) {
  const compilerOptions = optionsFor(importer);
  let moduleCache = moduleResolutionCaches.get(compilerOptions);
  if (!moduleCache) {
    moduleCache = ts.createModuleResolutionCache(root, value => value, compilerOptions);
    moduleResolutionCaches.set(compilerOptions, moduleCache);
  }
  const tsResolved = ts.resolveModuleName(specifier, path.resolve(root, importer), compilerOptions, ts.sys, moduleCache).resolvedModule?.resolvedFileName;
  if (tsResolved) {
    const rel = normalize(path.relative(root, tsResolved));
    if (fs.existsSync(path.resolve(root, rel))) return rel;
  }
  let bases = [];
  for (const [name, dir] of packageDirs) {
    if (specifier === name || specifier.startsWith(`${name}/`)) {
      const sub = specifier.slice(name.length).replace(/^\//, '');
      bases = [path.join(root, dir, sub), path.join(root, dir, 'src', sub)];
      break;
    }
  }
  if (!bases.length && specifier.startsWith('.')) bases = [path.resolve(root, path.dirname(importer), specifier)];
  for (let base of bases) {
    if (/\.js$/.test(base) && fs.existsSync(base.slice(0, -3) + '.ts')) base = base.slice(0, -3) + '.ts';
    for (const candidate of [base, ...['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'].map(ext => base + ext), ...['index.ts', 'index.tsx', 'index.js', 'index.jsx'].map(index => path.join(base, index))]) {
      if ((fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || deletedChanged.has(normalize(path.relative(root, candidate)))) return normalize(path.relative(root, candidate));
    }
  }
  return null;
}
function resolve(specifier, importer) {
  const key = `${importer}\0${specifier}`;
  if (!resolutionCache.has(key)) resolutionCache.set(key, resolveUncached(specifier, importer));
  return resolutionCache.get(key);
}

function astFor(file) {
  if (parsed.has(file)) return parsed.get(file);
  const source = fs.readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') || file.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const value = { ast, source };
  parsed.set(file, value);
  return value;
}

const ordinaryReverse = new Map();
const symbolReverse = new Map();
const conservativeReverse = new Map();
function edge(graph, dependency, consumer) {
  if (!graph.has(dependency)) graph.set(dependency, new Set());
  graph.get(dependency).add(consumer);
}
function pureBarrel(file) {
  if (deletedChanged.has(file)) return false;
  if (barrelCache.has(file)) return barrelCache.get(file);
  const { ast } = astFor(file);
  const pure = ast.statements.length > 0 && ast.statements.every(statement => ts.isExportDeclaration(statement) && Boolean(statement.moduleSpecifier));
  barrelCache.set(file, pure);
  return pure;
}
function bindingHasName(binding, name) {
  if (ts.isIdentifier(binding)) return binding.text === name;
  if (ts.isObjectBindingPattern(binding) || ts.isArrayBindingPattern(binding)) return binding.elements.some(element => !ts.isOmittedExpression(element) && bindingHasName(element.name, name));
  return false;
}
function moduleExportLeaves(file, exportName, seen = new Set()) {
  const key = `${file}\0${exportName}`;
  if (seen.size === 0 && exportLeafCache.has(key)) return new Set(exportLeafCache.get(key));
  if (seen.has(key)) return new Set();
  const nextSeen = new Set(seen);
  nextSeen.add(key);
  if (deletedChanged.has(file)) {
    const result = new Set([file]);
    if (seen.size === 0) exportLeafCache.set(key, result);
    return new Set(result);
  }
  const { ast } = astFor(file);
  if (!pureBarrel(file)) {
    const hasExport = ast.statements.some(statement => {
      if (ts.isExportDeclaration(statement)) {
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) return statement.exportClause.elements.some(element => element.name.text === exportName);
        if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
          if (!statement.exportClause) return exportName !== 'default';
          if (ts.isNamespaceExport(statement.exportClause)) return statement.exportClause.name.text === exportName;
        }
      }
      if (exportName === 'default') return ts.isExportAssignment(statement) || statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword);
      if (statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.some(declaration => bindingHasName(declaration.name, exportName));
        if ('name' in statement && statement.name && ts.isIdentifier(statement.name)) return statement.name.text === exportName;
      }
      return false;
    });
    const result = hasExport ? new Set([file]) : new Set();
    if (seen.size === 0) exportLeafCache.set(key, result);
    return new Set(result);
  }
  const explicit = new Set();
  const stars = new Set();
  for (const statement of ast.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const target = resolve(statement.moduleSpecifier.text, file);
    if (!target) continue;
    if (!statement.exportClause) {
      if (exportName !== 'default') for (const leaf of exportName === '*' ? moduleLeaves(target, new Set(nextSeen)) : moduleExportLeaves(target, exportName, new Set(nextSeen))) stars.add(leaf);
    } else if (ts.isNamespaceExport(statement.exportClause)) {
      if (exportName === '*' || exportName === statement.exportClause.name.text) for (const leaf of moduleLeaves(target, new Set(nextSeen))) explicit.add(leaf);
    } else if (ts.isNamedExports(statement.exportClause)) {
      for (const item of statement.exportClause.elements) if (exportName === '*' || item.name.text === exportName) {
        const original = item.propertyName?.text ?? item.name.text;
        for (const leaf of moduleExportLeaves(target, original, new Set(nextSeen))) explicit.add(leaf);
      }
    }
  }
  const matches = explicit.size ? explicit : stars;
  if (matches.size) matches.add(file);
  if (seen.size === 0) exportLeafCache.set(key, matches);
  return new Set(matches);
}
function moduleLeaves(file, seen = new Set()) {
  if (seen.size === 0 && moduleLeafCache.has(file)) return new Set(moduleLeafCache.get(file));
  if (deletedChanged.has(file)) return new Set([file]);
  if (seen.has(file)) return new Set();
  const nextSeen = new Set(seen);
  nextSeen.add(file);
  if (!pureBarrel(file)) return new Set([file]);
  const leaves = new Set();
  const { ast } = astFor(file);
  for (const statement of ast.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const target = resolve(statement.moduleSpecifier.text, file);
    if (target) for (const leaf of moduleLeaves(target, new Set(nextSeen))) leaves.add(leaf);
  }
  if (leaves.size) leaves.add(file);
  if (seen.size === 0) moduleLeafCache.set(file, leaves);
  return new Set(leaves);
}

for (const file of sourceFiles) {
  const { ast } = astFor(file);
  for (const statement of ast.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const dependency = resolve(statement.moduleSpecifier.text, file);
      if (!dependency) continue;
      const clause = statement.importClause;
      if (!pureBarrel(dependency)) {
        edge(ordinaryReverse, dependency, file);
      } else if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && !clause.name) {
        for (const binding of clause.namedBindings.elements) {
          for (const leaf of moduleExportLeaves(dependency, binding.propertyName?.text ?? binding.name.text)) edge(symbolReverse, leaf, file);
        }
        edge(ordinaryReverse, dependency, file);
      } else {
        edge(ordinaryReverse, dependency, file);
        for (const leaf of moduleLeaves(dependency)) edge(conservativeReverse, leaf, file);
      }
    } else if (!pureBarrel(file) && ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      const dependency = resolve(statement.moduleSpecifier.text, file);
      if (dependency) edge(ordinaryReverse, dependency, file);
    }
  }
  const raw = ast.getFullText();
  const dynamicPatterns = [/(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g];
  for (const pattern of dynamicPatterns) for (const match of raw.matchAll(pattern)) {
    const dependency = resolve(match[1], file);
    if (dependency) {
      edge(ordinaryReverse, dependency, file);
      if (pureBarrel(dependency)) for (const leaf of moduleLeaves(dependency)) edge(conservativeReverse, leaf, file);
    }
  }
}

// Build a tracked-path index and conservative edges from literal references in any tracked file.
const trackedPathForms = new Map();
function addPathForm(form, target) {
  if (form.length < 3 || /(^|\/)index(?:\.[^/]+)?$/.test(form) || /(^|\/)(?:test|spec|index)$/.test(form)) return;
  if (!trackedPathForms.has(form)) trackedPathForms.set(form, new Set());
  trackedPathForms.get(form).add(target);
}
for (const target of allTracked) {
  const noExt = target.replace(/\.(?:[cm]?[jt]sx?|json|ya?ml|md|txt|snap|toml|lock)$/, '');
  addPathForm(target, target);
  addPathForm(noExt, target);
}
for (const target of changedSet) {
  const noExt = target.replace(/\.(?:[cm]?[jt]sx?|json|ya?ml|md|txt|snap|toml|lock)$/, '');
  addPathForm(target, target);
  addPathForm(noExt, target);
}
const refReverse = new Map();
const quotedPath = /(['"])([^'"\r\n]{1,512})\1/g;
for (const consumer of allTracked) {
  if (!fs.existsSync(consumer) || fs.statSync(consumer).size > 2_000_000) continue;
  const text = fs.readFileSync(consumer, 'utf8');
  if (text.includes('\0')) continue;
  const literalsFound = [];
  const moduleRanges = [];
  if (jsTsRx.test(consumer)) {
    const { ast } = astFor(consumer);
    for (const statement of ast.statements) {
      if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier) moduleRanges.push([statement.moduleSpecifier.getStart(ast), statement.moduleSpecifier.getEnd()]);
    }
    const visit = node => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literalsFound.push({ value: node.text, start: node.getStart(ast) });
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) moduleRanges.push([arg.getStart(ast), arg.getEnd()]);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  } else {
    for (const match of text.matchAll(quotedPath)) literalsFound.push({ value: match[2], start: match.index });
  }
  for (const { value: rawValue, start } of literalsFound) {
    if (moduleRanges.some(([from, to]) => start >= from && start < to)) continue;
    const value = rawValue.replaceAll('\\/', '/');
    const candidates = new Set([value, value.replace(/^\.\//, '')]);
    if (value.startsWith('.')) candidates.add(normalize(path.relative(root, path.resolve(root, path.dirname(consumer), value))));
    for (const candidate of candidates) for (const target of trackedPathForms.get(normalize(candidate)) ?? []) {
      if (target !== consumer) edge(refReverse, target, consumer);
    }
  }
}

// CLI names are only connected from process/CLI invocation context and only if the entry is affected.
const binEntries = [];
for (const { dir, manifest } of packageRecords) {
  const bins = typeof manifest.bin === 'string' ? { [manifest.name?.split('/').at(-1) ?? '']: manifest.bin } : manifest.bin ?? {};
  for (const [name, entry] of Object.entries(bins)) {
    const target = resolvePackageEntry(dir, entry);
    if (name && target) binEntries.push({ name, target });
  }
}
function resolvePackageEntry(dir, entry) {
  const base = path.resolve(root, dir, entry);
  for (const candidate of [base, ...['.js', '.mjs', '.cjs', '.ts', '.tsx'].map(ext => base + ext)]) if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return normalize(path.relative(root, candidate));
  return null;
}
const cliReverse = new Map();
for (const consumer of allTracked) {
  if (!fs.existsSync(consumer) || fs.statSync(consumer).size > 1_000_000) continue;
  const text = fs.readFileSync(consumer, 'utf8');
  if (text.includes('\0')) continue;
  for (const { name, target } of binEntries) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const directCall = new RegExp(`\\b(?:spawn|spawnSync|exec|execFile|execFileSync|execSync|execa|execaCommand|crossSpawn)\\s*\\(\\s*(['"\`])${escaped}(?=$|[^\\w.-])`, 'i');
    const commandLine = new RegExp(`\\b(?:bun|node|npx|pnpm|yarn)\\s+(?:run|exec|x)\\s+${escaped}(?=$|[^\\w.-])`, 'i');
    if (directCall.test(text) || commandLine.test(text)) edge(cliReverse, target, consumer);
  }
}

const reverse = new Map();
for (const graph of [ordinaryReverse, symbolReverse, conservativeReverse, refReverse, cliReverse]) for (const [dependency, consumers] of graph) for (const consumer of consumers) edge(reverse, dependency, consumer);
function reachableFrom(rootFile, graphs = [reverse]) {
  const seen = new Set([rootFile]);
  const queue = [rootFile];
  for (let i = 0; i < queue.length; i++) {
    for (const graph of graphs) for (const next of graph.get(queue[i]) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  }
  return seen;
}
function owningPackage(file) {
  return packageRecords.filter(record => record.dir && (file === record.dir || file.startsWith(`${record.dir}/`))).sort((a, b) => b.dir.length - a.dir.length)[0] ?? null;
}
const selected = new Set([...tests].filter(test => changedSet.has(test)));
const decisions = [];
for (const changedRoot of changedSet) {
  const reachable = reachableFrom(changedRoot);
  const reachedTests = [...reachable].filter(file => tests.has(file));
  const owner = roots.includes(changedRoot) ? owningPackage(changedRoot) : null;
  const ownedTests = owner ? [...tests].filter(test => test.startsWith(`${owner.dir}/`) && !packageRecords.some(nested => nested.dir !== owner.dir && nested.dir.startsWith(`${owner.dir}/`) && test.startsWith(`${nested.dir}/`))) : [];
  const hub = roots.includes(changedRoot) && tests.size > 0 && reachedTests.length / tests.size > 0.25;
  const fallbackEvidence = hub && owner ? [...reachableFrom(changedRoot, [refReverse, cliReverse])].filter(file => tests.has(file)) : [];
  const perRoot = hub && owner ? [...new Set([...ownedTests, ...fallbackEvidence])] : reachedTests;
  for (const test of perRoot) selected.add(test);
  decisions.push({ root: changedRoot, reachedTests: reachedTests.length, mode: hub && owner ? `owning-package:${owner.dir}` : 'transitive', selectedTests: perRoot.length });
}
const selectedList = [...selected].sort();
const touchedPackageDirs = [...new Set(packageRecords.filter(record => record.dir && [...changedSet].some(file => file === record.dir || file.startsWith(`${record.dir}/`))).map(record => record.dir))];
const touchedPackages = packageRecords.filter(record => record.dir && touchedPackageDirs.includes(record.dir)).map(record => record.name).filter(Boolean).sort();
const rustChanged = [...changedSet].some(file => /\.rs$/.test(file) || /(?:^|\/)Cargo\.(?:toml|lock)$/.test(file));
const tsChanged = changedCode.some(file => /\.(?:[cm]?ts|tsx)$/.test(file));

console.log(`Changed files (${changed.length}):\n${changed.map(file => `  ${file}`).join('\n')}`);
console.log(`Selection roots (${decisions.length}):\n${decisions.map(item => `  ${item.root}: ${item.mode}; transitive tests=${item.reachedTests}; selected=${item.selectedTests}`).join('\n')}`);
console.log(`Selected related tests (${selectedList.length}):\n${selectedList.join('\n') || '(none)'}`);
if (dryRun) process.exit(0);
if (!process.env.RELATED_TESTS || !process.env.TOUCHED_PACKAGES || !process.env.RECEIPT || !process.env.GITHUB_OUTPUT) throw new Error('RELATED_TESTS, TOUCHED_PACKAGES, RECEIPT, and GITHUB_OUTPUT are required outside --dry-run');
fs.writeFileSync(process.env.RELATED_TESTS, selectedList.join('\n') + (selectedList.length ? '\n' : ''));
fs.writeFileSync(process.env.TOUCHED_PACKAGES, touchedPackages.join('\n') + (touchedPackages.length ? '\n' : ''));
fs.appendFileSync(process.env.GITHUB_OUTPUT, `ts_changed=${tsChanged}\nrust_changed=${rustChanged}\n`);
const receipt = fs.readFileSync(process.env.RECEIPT, 'utf8');
fs.writeFileSync(process.env.RECEIPT, receipt.replace(/^selected-tests=0$/m, `selected-tests=${selectedList.length}`));
