// deepseek-web 能力测试（DW1–DW4）：
//   DW1  node scripts/build.mjs deepseek-web 生成 dist/deepseek-web-1.0.0.locus，
//        两次构建字节相同（脚本产物与内存构建也一致）。
//   DW2  inspect 通过：ok / kind 'new' / mismatched 空、1 个 skill、0 个 plugin，
//        inspect 结果中的 credentials 与 capability.json 声明一致。
//   DW3  SKILL.md 的 sha256 等于附录 B 原文的固定值（一字不改）。
//   DW4  skill 规范检查通过：所有带凭据变量的 curl 都用 $DEEPSEEK_API_KEY、
//        目标都在 https://api.deepseek.com/v1/tools/ 下、无字面 key。

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createCapabilityPackages } from 'locus-browser-agent-runtime/src/capability-packages.js';

import { buildCapability, capabilitiesDir, distDir } from '../scripts/build.mjs';
import { checkSkillSpecs, extractCurlCommands } from '../scripts/skill-spec.mjs';

const CAPABILITY_ID = 'deepseek-web';
const SKILL_SHA256 = '69bb89b2eb1582b111c6507a2230f4e4ee7ca2106a544d0d9703d370867280ea';
const TOOLS_PREFIX = 'https://api.deepseek.com/v1/tools/';

const capabilityDir = path.join(capabilitiesDir, CAPABILITY_ID);
const skillMdPath = path.join(capabilityDir, 'skills', 'deepseek-web-search', 'SKILL.md');
const distPath = path.join(distDir, CAPABILITY_ID + '-1.0.0.locus');
const repoRoot = path.dirname(capabilitiesDir);

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}
const bytesEqual = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const usesVar = (s) => /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(s);
// 递归排序对象键，canonical JSON 比较（键序不敏感的深比较）
const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys)
  : (v && typeof v === 'object')
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
    : v;

const declared = JSON.parse(
  fs.readFileSync(path.join(capabilityDir, 'capability.json'), 'utf8')).capability;

// --- DW1：build 生成 dist/deepseek-web-1.0.0.locus，两次构建字节相同 ---
const first = await buildCapability(capabilityDir);
const second = await buildCapability(capabilityDir);
check('DW1: build id/version are deepseek-web@1.0.0',
  first.id === CAPABILITY_ID && first.version === '1.0.0',
  first.id + '@' + first.version);
check('DW1: two in-process builds are byte-identical', bytesEqual(first.bytes, second.bytes));
const b1 = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'build.mjs'), CAPABILITY_ID],
  { cwd: repoRoot, encoding: 'utf8' });
check('DW1: build script exits 0', b1.status === 0, (b1.stderr || '').slice(0, 400));
check('DW1: dist/deepseek-web-1.0.0.locus exists', fs.existsSync(distPath));
const dist1 = fs.readFileSync(distPath);
check('DW1: script artifact matches in-process build', bytesEqual(dist1, first.bytes));
const b2 = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'build.mjs'), CAPABILITY_ID],
  { cwd: repoRoot, encoding: 'utf8' });
check('DW1: two script builds are byte-identical',
  b2.status === 0 && bytesEqual(dist1, fs.readFileSync(distPath)));

// --- DW2：inspect 通过，组件计数与 credentials 一致 ---
const service = createCapabilityPackages({
  persistence: { loadCapabilityPackages: async () => [] },
  manager: {}, // inspect() 只要求 manager 为真值，不读其状态
  now: () => '1970-01-01T00:00:00.000Z',
});
const summary = await service.inspect(first.bytes);
check('DW2: inspect ok', summary.ok === true, JSON.stringify(summary.diagnostics || null));
check('DW2: inspect kind is new', summary.ok && summary.kind === 'new', String(summary.kind));
check('DW2: inspect mismatched is empty',
  summary.ok && summary.mismatched.length === 0, JSON.stringify(summary.mismatched));
check('DW2: exactly 1 skill and 0 plugins',
  summary.ok && summary.components.skills.length === 1
    && summary.components.skills[0].id === 'deepseek-web-search'
    && summary.components.plugins.length === 0,
  JSON.stringify(summary.components));
const analysis = await service.analyze(first.bytes, null);
const inspectedCredentials = analysis.ok ? analysis.pkgInput.capability.credentials : null;
// 校验器把 header 规范化为小写规范形（C3 §3.2 绑定记录即 header:
// 'authorization'；HTTP 头名大小写不敏感）。比较时两侧 header 统一小写，
// 其余字段严格一致。
const normalizeCredentials = (creds) => sortKeys(
  (creds || []).map((c) => ({ ...c, header: String(c.header).toLowerCase() })));
check('DW2: inspect credentials match capability.json',
  JSON.stringify(normalizeCredentials(inspectedCredentials))
    === JSON.stringify(normalizeCredentials(declared.credentials)),
  JSON.stringify(inspectedCredentials));

// --- DW3：SKILL.md 是附录 B 原文（sha256 固定值） ---
const skillMd = fs.readFileSync(skillMdPath);
const actualSha256 = createHash('sha256').update(skillMd).digest('hex');
check('DW3: SKILL.md sha256 matches the Appendix B original', actualSha256 === SKILL_SHA256,
  actualSha256);

// --- DW4：skill 规范检查通过 ---
const violations = checkSkillSpecs(capabilityDir);
check('DW4: no skill spec violations', violations.length === 0, JSON.stringify(violations));
const text = fs.readFileSync(skillMdPath, 'utf8');
const curls = extractCurlCommands(text);
const credCurls = curls.filter(usesVar);
check('DW4: both API calls are credentialled curls', credCurls.length === 2,
  JSON.stringify(curls));
check('DW4: credentialled curls use only $DEEPSEEK_API_KEY',
  credCurls.every((c) => c.includes('$DEEPSEEK_API_KEY') && !usesVar(c.replace(/\$DEEPSEEK_API_KEY/g, ''))),
  JSON.stringify(credCurls));
check('DW4: credentialled curls target ' + TOOLS_PREFIX,
  credCurls.every((c) => c.includes(TOOLS_PREFIX)), JSON.stringify(credCurls));
check('DW4: no literal API key', !/sk-[A-Za-z0-9]{16,}/.test(text));

console.log('deepseek-web.test: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
