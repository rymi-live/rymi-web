// Fails the publish if a published path is missing or a workspace: specifier
// would ship. Paths resolve from this package, so the same script runs in the
// monorepo and in the rymi-web mirror.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function fail(field) {
  console.error(field);
  process.exit(1);
}

function checkDeps(deps, label) {
  if (!deps) return;
  for (const [name, spec] of Object.entries(deps)) {
    if (typeof spec === 'string' && spec.startsWith('workspace:')) fail(`${label}.${name}`);
  }
}

checkDeps(pkg.dependencies, 'dependencies');
checkDeps(pkg.devDependencies, 'devDependencies');
checkDeps(pkg.peerDependencies, 'peerDependencies');
checkDeps(pkg.optionalDependencies, 'optionalDependencies');

function checkPath(field, rel) {
  if (typeof rel !== 'string' || !rel.startsWith('./')) return;
  if (!existsSync(join(root, rel))) fail(field);
}

for (const field of ['main', 'module', 'types']) {
  if (typeof pkg[field] !== 'string') fail(field);
  checkPath(field, pkg[field]);
}

function walkExports(node, field) {
  if (typeof node === 'string') {
    checkPath(field, node);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) walkExports(value, `${field}.${key}`);
  }
}

if (!pkg.exports || typeof pkg.exports !== 'object') fail('exports');
walkExports(pkg.exports, 'exports');

const dot = pkg.exports['.'];
if (!dot || typeof dot !== 'object' || typeof dot.require !== 'string') fail('exports..require');
