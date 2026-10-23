// 构建测试：夹具能力构建成功、两次构建字节相同（确定性）、产物名
// 为 <id>-<version>.locus、夹具本身通过 skill 规范检查。

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCapability } from '../scripts/build.mjs';
import { checkSkillSpecs } from '../scripts/skill-spec.mjs';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixtureDir = path.join(fixturesDir, 'example-notes');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}
const bytesEqual = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

const first = await buildCapability(fixtureDir);
check('build succeeds', first instanceof Object && first.bytes instanceof Uint8Array && first.bytes.byteLength > 0);
check('build id/version come from capability.json',
  first.id === 'example-notes' && first.version === '1.0.0',
  first.id + '@' + first.version);
check('artifact name is <id>-<version>.locus',
  first.id + '-' + first.version + '.locus' === 'example-notes-1.0.0.locus');
check('manifest closed list contains the manifests and the skill source',
  JSON.stringify(first.manifest.files.map((f) => f.path)) === JSON.stringify([
    'capability.json',
    'skills/example-notes/SKILL.md',
    'skills/example-notes/skill.json',
  ]),
  JSON.stringify(first.manifest.files));

const second = await buildCapability(fixtureDir);
check('determinism: two builds are byte-identical', bytesEqual(first.bytes, second.bytes));
check('determinism: manifests are identical',
  JSON.stringify(first.manifest) === JSON.stringify(second.manifest));

check('fixture itself passes the skill spec check',
  checkSkillSpecs(fixtureDir).length === 0,
  JSON.stringify(checkSkillSpecs(fixtureDir)));

console.log('build.test: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
