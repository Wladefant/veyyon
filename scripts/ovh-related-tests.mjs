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
const typecheckPlanned = args.includes('--typecheck-planned');
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
const typecheckCoverage = new Map();
const typecheckOwners = packageRecords.filter(record => record.dir)
  .sort((a, b) => b.dir.length - a.dir.length);
const typecheckDirs = new Set(changedCode.filter(file => /\.(?:[cm]?ts|tsx)$/.test(file))
  .map(file => typecheckOwners.find(record => file.startsWith(`${record.dir}/`))?.dir).filter(Boolean));
function typeOnlyCovered(file) {
  if (!typecheckPlanned) return false;
  if (typecheckCoverage.has(file)) return typecheckCoverage.get(file);
  const owner = typecheckOwners.find(record => file.startsWith(`${record.dir}/`));
  const covered = Boolean(owner && typecheckDirs.has(owner.dir));
  typecheckCoverage.set(file, covered);
  return covered;
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
// Keep export paths even in checked packages: downstream importers may be unchecked.
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
      const clause = statement.importClause;
      if (typeOnlyCovered(file) && (clause?.isTypeOnly || clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && !clause.name && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every(binding => binding.isTypeOnly))) continue;
      const dependency = resolve(statement.moduleSpecifier.text, file);
      if (!dependency) continue;
      if (!pureBarrel(dependency)) {
        edge(ordinaryReverse, dependency, file);
      } else if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && !clause.name) {
        const valueBindings = clause.namedBindings.elements.filter(binding => !typeOnlyCovered(file) || !binding.isTypeOnly);
        for (const binding of valueBindings) {
          for (const leaf of moduleExportLeaves(dependency, binding.propertyName?.text ?? binding.name.text)) edge(symbolReverse, leaf, file);
        }
        edge(ordinaryReverse, dependency, file);
        // Without a purity proof, every value re-export can evaluate a side-effectful module.
        for (const leaf of moduleLeaves(dependency)) edge(conservativeReverse, leaf, file);
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

// Build conservative edges from literal references in tracked files.
const trackedPathForms = new Map();
function addPathForm(form, target) {
  if (form.length < 3 || /(^|\/)index(?:\.[^/]+)?$/.test(form) || /(^|\/)(?:test|spec|index)$/.test(form)) return;
  if (!trackedPathForms.has(form)) trackedPathForms.set(form, new Set());
  trackedPathForms.get(form).add(target);
}
for (const target of new Set([...allTracked, ...changedSet])) {
  const noExt = target.replace(/\.(?:[cm]?[jt]sx?|json|ya?ml|md|txt|snap|toml|lock)$/, '');
  addPathForm(target, target);
  addPathForm(noExt, target);
}
const refReverse = new Map();
const quotedPath = /(['"])([^'"\r\n]{1,512})\1/g;
function pathAliases(ast) {
  const joins = new Set(), resolves = new Set(), dirnames = new Set(), fileURLToPaths = new Set();
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const source = statement.moduleSpecifier.text, clause = statement.importClause, bindings = clause?.namedBindings;
    if ((source === 'node:path' || source === 'path') && clause?.name) {
      joins.add(`${clause.name.text}.join`); resolves.add(`${clause.name.text}.resolve`); dirnames.add(`${clause.name.text}.dirname`);
    }
    if ((source === 'node:path' || source === 'path') && bindings && ts.isNamespaceImport(bindings)) {
      joins.add(`${bindings.name.text}.join`); resolves.add(`${bindings.name.text}.resolve`); dirnames.add(`${bindings.name.text}.dirname`);
    }
    if ((source === 'node:path' || source === 'path') && bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
      const imported = item.propertyName?.text ?? item.name.text, local = item.name.text;
      if (imported === 'join') joins.add(local);
      if (imported === 'resolve') resolves.add(local);
      if (imported === 'dirname') dirnames.add(local);
    }
    if ((source === 'node:url' || source === 'url') && clause?.name) fileURLToPaths.add(`${clause.name.text}.fileURLToPath`);
    if ((source === 'node:url' || source === 'url') && bindings && ts.isNamespaceImport(bindings)) fileURLToPaths.add(`${bindings.name.text}.fileURLToPath`);
    if ((source === 'node:url' || source === 'url') && bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
      if ((item.propertyName?.text ?? item.name.text) === 'fileURLToPath') fileURLToPaths.add(item.name.text);
    }
  }
  return { joins, resolves, dirnames, fileURLToPaths };
}
for (const consumer of allTracked) {
  if (!fs.existsSync(consumer) || fs.statSync(consumer).size > 2_000_000) continue;
  const text = fs.readFileSync(consumer, 'utf8');
  if (text.includes('\0')) continue;
  const literalsFound = [];
  const moduleRanges = [];
  const pathRanges = [];
  const staticPaths = [];
  if (jsTsRx.test(consumer)) {
    const { ast } = astFor(consumer);
    const aliases = pathAliases(ast);
    const bindings = new Map();
    for (const statement of ast.statements) if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0) {
      for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.initializer) bindings.set(declaration.name.text, declaration.initializer);
    }
    const metaUrl = Symbol('import.meta.url');
    const evalNode = (node, seen = new Set(), depth = 0) => {
      if (!node || depth > 20) return null;
      if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) return evalNode(node.expression, seen, depth + 1);
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
      if (ts.isIdentifier(node)) {
        if (seen.has(node.text) || !bindings.has(node.text)) return null;
        const next = new Set(seen); next.add(node.text);
        return evalNode(bindings.get(node.text), next, depth + 1);
      }
      if (ts.isPropertyAccessExpression(node) && ts.isMetaProperty(node.expression)) {
        if (node.name.text === 'url') return metaUrl;
        if (node.name.text === 'dirname') return path.dirname(path.resolve(root, consumer));
        if (node.name.text === 'filename') return path.resolve(root, consumer);
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(ast);
        const args = node.arguments.map(arg => evalNode(arg, seen, depth + 1));
        if (aliases.fileURLToPaths.has(callee) && args[0] === metaUrl) return path.resolve(root, consumer);
        if (aliases.dirnames.has(callee) && typeof args[0] === 'string') return path.dirname(args[0]);
        if (aliases.joins.has(callee) || aliases.resolves.has(callee)) {
          if (args.some(value => value === null || typeof value !== 'string')) return null;
          return aliases.resolves.has(callee) ? path.resolve(root, ...args) : path.join(...args);
        }
        if (callee === 'process.cwd' && args.length === 0) return root;
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.Plus) {
        const left = evalNode(node.left, seen, depth + 1), right = evalNode(node.right, seen, depth + 1);
        return typeof left === 'string' && typeof right === 'string' ? left + right : null;
      }
      return null;
    };
    const visit = node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        moduleRanges.push([node.moduleSpecifier.getStart(ast), node.moduleSpecifier.getEnd()]);
      }
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literalsFound.push({ value: node.text, start: node.getStart(ast) });
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(ast);
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
          const arg = node.arguments[0];
          if (arg && ts.isStringLiteral(arg)) moduleRanges.push([arg.getStart(ast), arg.getEnd()]);
        }
        if (aliases.joins.has(callee) || aliases.resolves.has(callee)) {
          for (const arg of node.arguments) pathRanges.push([arg.getStart(ast), arg.getEnd()]);
          const value = evalNode(node);
          if (value !== null) staticPaths.push(value);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  } else {
    for (const match of text.matchAll(quotedPath)) literalsFound.push({ value: match[2], start: match.index });
  }
  const addReference = candidate => {
    const normalized = normalize(candidate);
    for (const target of trackedPathForms.get(normalized) ?? []) if (target !== consumer) edge(refReverse, target, consumer);
  };
  for (const staticPath of staticPaths) addReference(path.relative(root, path.resolve(root, staticPath)));
  for (const { value: rawValue, start } of literalsFound) {
    if (moduleRanges.some(([from, to]) => start >= from && start < to) || pathRanges.some(([from, to]) => start >= from && start < to)) continue;
    const value = rawValue.replaceAll('\\/', '/');
    if (value.startsWith('.')) addReference(path.relative(root, path.resolve(root, path.dirname(consumer), value)));
    else if (value.includes('/')) addReference(value.replace(/^\//, ''));
    else addReference(path.relative(root, path.resolve(root, path.dirname(consumer), value)));
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
function reachableFrom(rootFile) {
  const distances = new Map([[rootFile, 0]]);
  const queue = [rootFile];
  for (let i = 0; i < queue.length; i++) {
    const file = queue[i];
    for (const next of reverse.get(file) ?? []) if (!distances.has(next)) {
      distances.set(next, distances.get(file) + 1);
      queue.push(next);
    }
  }
  return distances;
}
const selected = new Set([...tests].filter(test => changedSet.has(test)));
const decisions = [];
for (const changedRoot of changedSet) {
  const distances = reachableFrom(changedRoot);
  const reachedTests = [...distances.keys()].filter(file => tests.has(file))
    .sort((a, b) => distances.get(a) - distances.get(b) || (a < b ? -1 : a > b ? 1 : 0));
  for (const test of reachedTests) selected.add(test);
  decisions.push({ root: changedRoot, reachedTests: reachedTests.length, mode: 'transitive', selectedTests: reachedTests.length });
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
