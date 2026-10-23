// inspect 测试：夹具能力构建出的 .locus 通过 locus-product 的
// createCapabilityPackages().inspect() —— ok 为 true、kind 为 'new'、
// mismatched 为空。替身与 scripts/check.mjs 相同。

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCapabilityPackages } from 'locus-browser-agent-runtime/src/capability-packages.js';

import { buildCapability } from '../scripts/build.mjs';

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'example-notes');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

const built = await buildCapability(fixtureDir);
const service = createCapabilityPackages({
  persistence: { loadCapabilityPackages: async () => [] },
  manager: {}, // inspect() 只要求 manager 为真值，不读其状态
  now: () => '1970-01-01T00:00:00.000Z',
});
const summary = await service.inspect(built.bytes);

check('inspect ok', summary.ok === true, JSON.stringify(summary.diagnostics || null));
check('inspect kind is new', summary.ok && summary.kind === 'new', String(summary.kind));
check('inspect mismatched is empty', summary.ok && summary.mismatched.length === 0,
  JSON.stringify(summary.mismatched));
check('inspect identity matches the fixture',
  summary.ok && summary.id === 'example-notes' && summary.version === '1.0.0',
  summary.ok ? summary.id + '@' + summary.version : '-');
check('inspect sees the declared credential',
  summary.ok && Array.isArray(summary.components.skills)
    && summary.components.skills.some((s) => s.id === 'example-notes'));

console.log('inspect.test: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
