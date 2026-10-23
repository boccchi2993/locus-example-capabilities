// skill 规范检查测试：干净夹具零违规；三类违规各有一个反例夹具，
// 且恰好各抓到一条对应规则的违规（不多抓）。

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkSkillSpecs } from '../scripts/skill-spec.mjs';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}
const rulesOf = (dir) => checkSkillSpecs(path.join(fixturesDir, dir)).map((v) => v.rule).sort();

check('clean fixture: no violations', rulesOf('example-notes').length === 0,
  JSON.stringify(rulesOf('example-notes')));
check('literal sk- key is caught',
  JSON.stringify(rulesOf('spec-literal-key')) === JSON.stringify(['literal-key']),
  JSON.stringify(rulesOf('spec-literal-key')));
check('undeclared $VAR is caught',
  JSON.stringify(rulesOf('spec-undeclared-variable')) === JSON.stringify(['undeclared-variable']),
  JSON.stringify(rulesOf('spec-undeclared-variable')));
check('curl target outside the declared pathPrefix is caught',
  JSON.stringify(rulesOf('spec-url-outside-prefix')) === JSON.stringify(['url-outside-prefix']),
  JSON.stringify(rulesOf('spec-url-outside-prefix')));

console.log('skill-spec.test: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
