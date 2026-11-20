import { execFileSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = realpathSync('.');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const files = new Set(manifest.files);
const nativeAttachments = new Set([
  'README.md', 'LICENSE', 'NOTICE', 'config.example.yaml', '.env.example', 'docs/agent_skills.md',
]);
const sharedResourceRoots = new Set(['rules', 'debug-wiki', 'skills']);

function releaseSource(file) {
  if (typeof file !== 'string' || !/^(?:\.env\.example|[A-Za-z0-9][\w./-]*)$/u.test(file)
    || path.posix.normalize(file) !== file) {
    throw new Error(`Invalid release file path: ${file}`);
  }
  const source = path.join(root, file);
  if (!lstatSync(source, { throwIfNoEntry: false })?.isFile() || realpathSync(source) !== source) {
    throw new Error(`Expected a regular release file at ${file}`);
  }
  return source;
}

function copyNativeAttachments(destination) {
  if (!destination) throw new Error('Specify a standalone package staging directory.');
  for (const file of files) {
    if (sharedResourceRoots.has(file.split('/')[0])) nativeAttachments.add(file);
  }
  for (const file of nativeAttachments) {
    const source = releaseSource(file);
    const target = path.join(destination, file);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
}

function verifyNpmPackage() {
  const requiredEntries = [
    ...Object.values(manifest.bin),
    ...Object.values(manifest.exports).flatMap(entry => Object.values(entry)),
  ].map(file => file.replace(/^\.\//u, ''));
  for (const file of requiredEntries) {
    if (!files.has(file)) throw new Error(`Missing npm entry in package.json files: ${file}`);
  }
  for (const file of files) releaseSource(file);

  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('Run this check with npm run package:verify.');
  const cache = mkdtempSync(path.join(os.tmpdir(), 'xcompiler-pack-'));
  try {
    // Lifecycle checks have already run on the outer call. Ignore them in the inner dry run.
    const output = execFileSync(process.execPath, [
      npm, 'pack', '--dry-run', '--json', '--offline', '--ignore-scripts', '--cache', cache,
    ], { encoding: 'utf8' });
    const [pack] = JSON.parse(output);
    const actual = new Set(pack.files.map(entry => entry.path));
    const expected = new Set([...files, 'package.json']);
    const missing = [...expected].filter(file => !actual.has(file));
    const unexpected = [...actual].filter(file => !expected.has(file));
    if (missing.length || unexpected.length) {
      throw new Error(`Unexpected npm package contents. Missing: ${missing.join(', ') || 'none'}. Extra: ${unexpected.join(', ') || 'none'}.`);
    }
    console.log(`Verified ${actual.size} npm package files.`);
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}

const [action, destination] = process.argv.slice(2);
if (action === 'copy') copyNativeAttachments(destination);
else if (action === 'verify-npm') verifyNpmPackage();
else throw new Error('Expected copy or verify-npm.');
