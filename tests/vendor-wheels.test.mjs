// VW1–VW5：D13 第三方 wheel 的 vendor 机制检查（scripts/vendor.mjs /
// scripts/wheel-checks.mjs / scripts/wheel-util.mjs）。
//
//   VW1  vendor 一致性：真实 vendor 通过；临时副本上篡改一个字节报错
//   VW2  来源核验：全部 9 项在线核验通过（pypi 对 PyPI、pyodide-lock 对
//        lock 记录）；sha 改错的夹具报错（联网测试；网络不可用时按 D13
//        要求报错退出，不跳过）
//   VW3  平台标签：wheel 文件名列表（none-any / cp312+pyodide_2024_0_wasm32
//        与各种不兼容形状；与 runtime 计划中的 RT-ABI AB3 同类例子组）
//   VW4  遮盖：声明 py-six 的夹具能力报错
//   VW5  依赖顺序：顺序反了 / 缺依赖 / 正确 顺序三种夹具
//
// 运行：node tests/vendor-wheels.test.mjs（npm test 会依次跑全部 *.test.mjs）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkVendorConsistency,
  checkVendorSources,
  loadVendorEntries,
} from '../scripts/vendor.mjs';
import { checkCapabilityWheelRules } from '../scripts/wheel-checks.mjs';
import { wheelPlatformCompatible } from '../scripts/wheel-util.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = path.join(repoRoot, 'tests', 'fixtures');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

function makeTempVendor() {
  // 真实 vendor 的临时副本：篡改实验只碰副本，不碰源码目录里的文件。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'locus-vendor-'));
  fs.cpSync(path.join(repoRoot, 'vendor'), path.join(root, 'vendor'), { recursive: true });
  return root;
}

// ---------- VW1 vendor 一致性 ----------
{
  const errors = checkVendorConsistency(repoRoot);
  check('VW1 真实 vendor 一致性通过', errors.length === 0, errors.join(' ; '));

  const tamperedRoot = makeTempVendor();
  const wheelPath = path.join(tamperedRoot, 'vendor', 'wheels', 'et_xmlfile-2.0.0-py3-none-any.whl');
  const bytes = fs.readFileSync(wheelPath);
  bytes[bytes.length - 1] ^= 0xff; // 篡改最后一个字节
  fs.writeFileSync(wheelPath, bytes);
  const tamperErrors = checkVendorConsistency(tamperedRoot);
  check('VW1 篡改一个字节后报错', tamperErrors.length > 0
    && tamperErrors.some((e) => e.includes('py-et-xmlfile') && e.includes('sha256 不一致')),
    tamperErrors.join(' ; '));
  fs.rmSync(tamperedRoot, { recursive: true, force: true });

  const extraRoot = makeTempVendor();
  fs.writeFileSync(path.join(extraRoot, 'vendor', 'wheels', 'stray-1.0-py3-none-any.whl'), 'x');
  const extraErrors = checkVendorConsistency(extraRoot);
  check('VW1 清单之外的文件报错', extraErrors.some((e) => e.includes('清单之外的文件')),
    extraErrors.join(' ; '));
  fs.rmSync(extraRoot, { recursive: true, force: true });
}

// ---------- VW2 来源核验（联网） ----------
{
  const errors = await checkVendorSources(repoRoot);
  check('VW2 openpyxl 与 et_xmlfile 的 PyPI 在线核验通过', errors.length === 0, errors.join(' ; '));

  const tamperedRoot = makeTempVendor();
  const manifestPath = path.join(tamperedRoot, 'vendor', 'wheels.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const openpyxl = manifest.find((e) => e.id === 'py-openpyxl');
  openpyxl.sha256 = openpyxl.sha256.replace(/^5/, 'a'); // 改错一位
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const tamperErrors = await checkVendorSources(tamperedRoot);
  check('VW2 sha256 改错的清单报错', tamperErrors.length > 0
    && tamperErrors.some((e) => e.includes('py-openpyxl') && e.includes('PyPI')),
    tamperErrors.join(' ; '));
  fs.rmSync(tamperedRoot, { recursive: true, force: true });

  const entries = loadVendorEntries(repoRoot);
  check('VW2 清单共 9 项且含 batch-1 / batch-2 的代表项',
    entries.length === 9
    && entries.some((e) => e.id === 'py-openpyxl' && e.version === '3.1.5' && e.source === 'pypi')
    && entries.some((e) => e.id === 'py-et-xmlfile' && e.version === '2.0.0' && e.source === 'pypi')
    && entries.some((e) => e.id === 'py-lxml' && e.version === '5.2.1' && e.source === 'pyodide-lock')
    && entries.some((e) => e.id === 'py-pillow' && e.version === '10.2.0' && e.source === 'pyodide-lock')
    && entries.some((e) => e.id === 'py-pypdf' && e.version === '6.21.2' && e.source === 'pypi'),
    JSON.stringify(entries.map((e) => e.id)));
}

// ---------- VW3 平台标签 ----------
{
  // 与 runtime RT-ABI 同类的例子组：D13 第 3 条规则（纯 Python
  // abi none + platform any，或 python 与 abi 标签都含 cp312 且 platform
  // 恰为 pyodide_2024_0_wasm32——与 runtime feat/python-abi-export 的
  // wheelPlatformCompatible 语义一致）。
  const cases = [
    ['openpyxl-3.1.5-py2.py3-none-any.whl', true, '纯 Python（多 python tag）'],
    ['et_xmlfile-2.0.0-py3-none-any.whl', true, '纯 Python'],
    ['foo-1.0-py3-none-any.whl', true, '纯 Python'],
    ['lxml-5.2.1-cp312-cp312-pyodide_2024_0_wasm32.whl', true, 'Pyodide 原生 wheel（当前 ABI）'],
    ['pandas-2.2.0-cp312-cp312-pyodide_2024_0_wasm32.whl', true, 'Pyodide 原生 wheel（平台兼容；遮盖另查）'],
    ['foo-1.0-1-cp312-cp312-pyodide_2024_0_wasm32.whl', true, '带数字开头的 build tag'],
    ['foo-1.0-cp311-cp311-pyodide_2024_0_wasm32.whl', false, 'python ABI 不是 cp312'],
    ['foo-1.0-cp312-abi3-pyodide_2024_0_wasm32.whl', false, 'abi 标签不含 cp312'],
    ['foo-1.0-cp312-cp312-pyodide_2025_0_wasm32.whl', false, 'pyodide ABI 不是 2024_0'],
    ['foo-1.0-cp312-cp312-emscripten_3_1_58_wasm32.whl', false, '旧 emscripten 平台标签'],
    ['foo-1.0-cp312-cp312-linux_x86_64.whl', false, 'linux 原生'],
    ['foo-1.0-cp312-cp312-win_amd64.whl', false, 'windows 原生'],
    ['foo-1.0-py3-none-win_amd64.whl', false, 'abi none 但平台不是 any'],
    ['foo-1.0-cp312-cp312-pyodide_2024_0_wasm32-x86_64.whl', false, '6 段但 build tag 不以数字开头'],
    ['foo-1.0-py3-none-any.tar.gz', false, '不是 wheel 文件名'],
    ['not-a-wheel.txt', false, '不是 wheel 文件名'],
  ];
  for (const [filename, expected, why] of cases) {
    check('VW3 平台标签 ' + filename, wheelPlatformCompatible(filename) === expected, why);
  }
}

// ---------- VW4 遮盖 ----------
{
  const errors = checkCapabilityWheelRules(repoRoot, path.join(fixturesDir, 'py-shadow-six'));
  check('VW4 声明 py-six 的夹具报错', errors.length > 0
    && errors.some((e) => e.includes('py-six') && e.includes('遮盖 runtime 预装包')),
    errors.join(' ; '));
}

// ---------- VW5 依赖顺序 ----------
{
  const reversed = checkCapabilityWheelRules(repoRoot, path.join(fixturesDir, 'py-order-reversed'));
  check('VW5 顺序反了（openpyxl 在前）报依赖顺序错误', reversed.some((e) =>
    e.includes('依赖顺序错误') && e.includes('et-xmlfile') && e.includes('py-openpyxl') && e.includes('之前')),
    reversed.join(' ; '));

  const missing = checkCapabilityWheelRules(repoRoot, path.join(fixturesDir, 'py-order-missing'));
  check('VW5 缺依赖（只有 openpyxl）报缺少依赖', missing.some((e) =>
    e.includes('缺少依赖') && e.includes('et-xmlfile') && e.includes('py-et-xmlfile')),
    missing.join(' ; '));

  const ok = checkCapabilityWheelRules(repoRoot, path.join(fixturesDir, 'py-order-ok'));
  check('VW5 正确顺序（et_xmlfile 在前）通过', ok.length === 0, ok.join(' ; '));
}

console.log('vendor-wheels.test: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
