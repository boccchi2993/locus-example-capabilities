// ============================================================
//  CHECK — 对每个构建产物做三项检查，任何一项失败以非 0 退出：
//
//    a. inspect：用 locus-product 的 createCapabilityPackages（安装
//       记录为空、最小 manager 替身、固定 now）检查 .locus：ok 为
//       true、kind 为 'new'、mismatched 为空。
//    b. 确定性：再构建一次，与 dist/ 里的产物字节相同。
//    c. skill 规范检查（scripts/skill-spec.mjs 的三条规则）。
//
//  capabilities/ 为空时打印 "no capabilities" 并以 0 退出。
//  用法：node scripts/check.mjs（在 npm run build 之后运行）
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCapabilityPackages } from 'locus-browser-agent-runtime/src/capability-packages.js';

import { buildCapability, capabilitiesDir, distDir, listCapabilityIds } from './build.mjs';
import { checkSkillSpecs } from './skill-spec.mjs';

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

  if (!failures.some((f) => f.startsWith(built.id))) {
    console.log('ok ' + built.id + '@' + built.version);
  }
}

async function main() {
  const ids = listCapabilityIds();
  if (!ids.length) {
    console.log('no capabilities');
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
  console.log(ids.length + ' capability package(s) passed build/check/inspect');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error('check failed: ' + (e && e.message ? e.message : String(e)));
    process.exit(1);
  },
);
