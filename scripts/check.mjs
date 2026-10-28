// ============================================================
//  CHECK — 对每个构建产物做检查，任何一项失败以非 0 退出：
//
//    a. inspect：用 locus-product 的 createCapabilityPackages（安装
//       记录为空、最小 manager 替身、固定 now）检查 .locus：ok 为
//       true、kind 为 'new'、mismatched 为空。
//    b. 确定性：再构建一次，与 dist/ 里的产物字节相同。
//    c. skill 规范检查（scripts/skill-spec.mjs 的四条规则：字面密钥、
//       curl 凭据变量与目标范围、capability.version 三段数字）。
//    d. vendor 一致性：wheels.json 每项的文件存在、sha256 一致，
//       vendor/wheels/ 没有多余或缺失文件，pyodide-lock 的 sha256
//       与 vendor/README.md 记录一致（scripts/vendor.mjs）。
//    e. 来源核验：pyodide-lock 来源对 lock 记录、pypi 来源在线对
//       PyPI JSON API（scripts/vendor.mjs；网络不可用时报错退出）。
//    f. 平台标签：vendor 与各能力的 wheel 必须 none-any 或
//       cp312 + pyodide_2024_0_wasm32（scripts/wheel-checks.mjs）。
//    g. 预装遮盖：wheel 的发行包不得是 runtime 预装包。
//    h. 依赖顺序：每个 wheel 的 Requires-Dist（无 extra、标记对
//       Python 3.12 / emscripten 成立）要么是 runtime 预装包，要么
//       由 plugins 列表里更靠前的 py- plugin 提供。
//
//  d–h 是 D13 第三方 wheel 机制（vendor/）引入的检查；d、e、f、g
//  的 vendor 侧在没有能力引用 vendor 时也照常运行。
//  capabilities/ 为空时打印 "no capabilities" 并以 0 退出（vendor
//  检查仍然执行）。
//  用法：node scripts/check.mjs（在 npm run build 之后运行）
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCapabilityPackages } from 'locus-browser-agent-runtime/src/capability-packages.js';

import { buildCapability, capabilitiesDir, distDir, listCapabilityIds } from './build.mjs';
import { checkSkillSpecs } from './skill-spec.mjs';
import { checkVendorConsistency, checkVendorSources } from './vendor.mjs';
import { checkCapabilityWheelRules, checkVendorWheelRules } from './wheel-checks.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const failures = [];

function fail(message) {
  failures.push(message);
  console.error('FAIL ' + message);
}

function bytesEqual(a, b) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

// inspect() 不读任何 manager 状态（只要求真值），与 product
// tests/capability-install.test.mjs 的替身思路一致；persistence 同理
// 只提供 inspect 用到的 loadCapabilityPackages（这里恒为空安装记录）。
function makeInspectService() {
  return createCapabilityPackages({
    persistence: { loadCapabilityPackages: async () => [] },
    manager: {},
    now: () => '1970-01-01T00:00:00.000Z',
  });
}

async function checkCapability(id, service) {
  const sourceDir = path.join(capabilitiesDir, id);
  const built = await buildCapability(sourceDir);
  const artifactPath = path.join(distDir, built.id + '-' + built.version + '.locus');

  // --- a. inspect ---
  if (!fs.existsSync(artifactPath)) {
    fail(built.id + ': 缺少构建产物 ' + path.relative(repoRoot, artifactPath) + '（先运行 npm run build）');
    return;
  }
  const artifact = fs.readFileSync(artifactPath);
  const summary = await service.inspect(artifact);
  if (!summary.ok) {
    fail(built.id + ': inspect 失败: ' + summary.diagnostics.map((d) => d.code).join(', '));
  } else {
    if (summary.kind !== 'new') {
      fail(built.id + ': inspect kind 应为 "new"，得到 ' + JSON.stringify(summary.kind));
    }
    if (summary.mismatched.length) {
      fail(built.id + ': inspect mismatched 应为空，得到 ' + summary.mismatched.join(', '));
    }
  }

  // --- b. 确定性：再构建一次，与产物字节相同 ---
  const rebuilt = await buildCapability(sourceDir);
  if (!bytesEqual(artifact, rebuilt.bytes)) {
    fail(built.id + ': 构建不确定——两次构建字节不同');
  }

  // --- c. skill 规范 ---
  for (const v of checkSkillSpecs(sourceDir)) {
    fail(built.id + ': skill 规范 [' + v.rule + '] ' + v.message);
  }

  // --- f/g/h. D13 第三方 wheel 规则（平台标签 / 预装遮盖 / 依赖顺序，
  //     对 capability.json 声明的 py- plugin 逐个执行）---
  for (const v of checkCapabilityWheelRules(repoRoot, sourceDir)) {
    fail(built.id + ': wheel 规则 ' + v);
  }

  if (!failures.some((f) => f.startsWith(built.id))) {
    console.log('ok ' + built.id + '@' + built.version);
  }
}

async function main() {
  // --- d/e/f/g（vendor 侧）：无论有没有能力都执行——vendor 是提交进
  //     git 的内容，一致性与来源必须始终成立 ---
  for (const v of checkVendorConsistency(repoRoot)) {
    fail('vendor 一致性 ' + v);
  }
  for (const v of await checkVendorSources(repoRoot)) {
    fail('vendor 来源 ' + v);
  }
  for (const v of checkVendorWheelRules(repoRoot)) {
    fail('vendor wheel 规则 ' + v);
  }

  const ids = listCapabilityIds();
  if (!ids.length) {
    console.log('no capabilities');
    if (failures.length) {
      console.error(failures.length + ' check failure(s)');
      return 1;
    }
    return 0;
  }
  const service = makeInspectService();
  for (const id of ids) {
    await checkCapability(id, service);
  }
  if (failures.length) {
    console.error(failures.length + ' check failure(s)');
    return 1;
  }
  console.log(ids.length + ' capability package(s) passed build/check/inspect; vendor 通过一致性、来源与平台检查');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error('check failed: ' + (e && e.message ? e.message : String(e)));
    process.exit(1);
  },
);
