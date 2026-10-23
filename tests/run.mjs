// 测试入口：依次运行 tests/*.test.mjs（每个测试文件独立进程，
// PASS/FAIL 行原样透传），最后打一行汇总。任一文件失败即非 0 退出。
//
// 用法：npm test（node tests/run.mjs）

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort();

if (!files.length) {
  console.error('no test files found in ' + testsDir);
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  console.log('=== ' + file);
  const r = spawnSync(process.execPath, [path.join(testsDir, file)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}

console.log('test files: ' + files.length + ', failed: ' + failed);
process.exit(failed ? 1 : 0);
