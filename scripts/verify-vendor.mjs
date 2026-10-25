// ============================================================
//  VERIFY-VENDOR — 单独运行 vendor 的前两项检查（检查 1 一致性、
//  检查 2 来源核验），任何一项失败以非 0 退出：
//
//    1. wheels.json 每项的 wheel 文件存在且 sha256 一致；
//       vendor/wheels/ 没有多余或缺失的文件；pyodide-lock 的 sha256
//       与 vendor/README.md 记录一致。
//    2. 来源核验：source 为 pyodide-lock 的对 vendor/pyodide-lock-
//       0.26.4.json 记录；source 为 pypi 的在线对 PyPI JSON API
//       （网络不可用时按 D13 要求报错退出，不跳过——CI 能联网）。
//
//  用法：npm run verify-vendor
// ============================================================

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkVendorConsistency, checkVendorSources } from './vendor.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const errors = [];
for (const v of checkVendorConsistency(repoRoot)) {
  errors.push('[一致性] ' + v);
}
for (const v of await checkVendorSources(repoRoot)) {
  errors.push('[来源] ' + v);
}

if (errors.length) {
  for (const e of errors) console.error('FAIL ' + e);
  console.error('verify-vendor: ' + errors.length + ' failure(s)');
  process.exit(1);
}
console.log('verify-vendor: wheels.json 与 vendor/wheels/、pyodide-lock 全部一致，来源核验通过');
