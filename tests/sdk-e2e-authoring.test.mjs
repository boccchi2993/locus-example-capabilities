// E2E-SDK12：模拟模型在 Locus 里创作带第三方 wheel 的能力的完整流程
// （D14 + SPIKE-SYNC 2026-10-30 实验的脚本化）。全部离线，只用 CPython：
//
//   pip --target 安装 vendor 里的 locus_capability_sdk 1.2.0 wheel，之后
//   所有 SDK 调用只来自安装后的 wheel（PYTHONPATH 仅含 --target 目录，
//   不含仓库 packages/）——证明装好的 wheel 本身够用。
//
//   E2E1  新项目 → plugin-from-wheel 加入 typing_extensions、lxml、
//         python-docx（plugins 顺序：typing_extensions 在 docx 前，
//         lxml 在 docx 前——docx 的 Requires-Dist 两者都要）→ 一个调用
//         docx 的小 skill → validate 空 → build → inspect ok。
//   E2E2  product inspect/analyze（锁定的 locus-browser-agent-runtime）
//         复核同一 .locus：ok、kind new、三个 plugin 与声明顺序一致
//         （lxml 是 Pyodide 原生 wheel，D13 导入检查通过；CPython 无法
//         import 它，这里只验证描述符与包结构）。
//   E2E3  plugins 顺序反过来 → validate 报现有的依赖顺序诊断
//        （wheel-dependency-order）。
//   E2E4  去掉 typing_extensions（声明 + 本地 plugin 目录）→ validate
//         报现有的缺依赖诊断（wheel-dependency-missing）。
//
// 运行：node tests/sdk-e2e-authoring.test.mjs（npm test 会依次跑全部）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pythonBin = process.env.PYTHON || 'python';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + String(detail) : '')); }
}

const SDK_WHEEL = path.join(repoRoot, 'vendor', 'wheels', 'locus_capability_sdk-1.2.0-py3-none-any.whl');
const WHEELS = {
  typing: path.join(repoRoot, 'vendor', 'wheels', 'typing_extensions-4.16.0-py3-none-any.whl'),
  lxml: path.join(repoRoot, 'vendor', 'wheels', 'lxml-5.2.1-cp312-cp312-pyodide_2024_0_wasm32.whl'),
  docx: path.join(repoRoot, 'vendor', 'wheels', 'python_docx-1.2.0-py3-none-any.whl'),
};

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function rmRf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch (e2) { console.log('WARN cleanup failed for ' + dir + ': ' + e2.message); }
  }
}

// 安装后的 SDK wheel 是唯一 SDK 来源：PYTHONPATH 仅含 pip --target 目录。
const pipTarget = tmpDir('locus-e2e-pip-');
const sdkEnv = { ...process.env, PYTHONPATH: pipTarget };

// SDK CLI 调用（JSON 输出；CLI 输出按 sort_keys 排序，断言逐字段做）。
function sdk(args) {
  const r = spawnSync(pythonBin, ['-m', 'locus_capability_sdk', ...args], {
    encoding: 'utf8',
    env: sdkEnv,
  });
  if (r.error) throw new Error('SDK 调用失败: ' + r.error.message);
  const stdout = (r.stdout || '').trim();
  let doc = null;
  try { doc = JSON.parse(stdout); } catch (e) { doc = null; }
  return { status: r.status, doc, stdout, stderr: (r.stderr || '').trim() };
}

// ---------- 安装 SDK wheel（--no-deps --target，与 CA2/XC4 同款） ----------
{
  const pip = spawnSync(pythonBin, ['-m', 'pip', 'install', '--quiet', '--no-deps',
    '--target', pipTarget, SDK_WHEEL], { encoding: 'utf8' });
  check('E2E0 pip install SDK wheel 成功', pip.status === 0, (pip.stderr || '').slice(0, 300));
  const probe = spawnSync(pythonBin, ['-c',
    'from locus_capability_sdk import _version; print(_version.__version__)'], {
    encoding: 'utf8', env: sdkEnv,
  });
  check('E2E0 安装后的 SDK 是 1.2.0', probe.status === 0 && probe.stdout.trim() === '1.2.0',
    probe.stdout + probe.stderr);
}

// ---------- E2E1 正向流程 ----------
const project = tmpDir('locus-e2e-proj-');
const outDir = tmpDir('locus-e2e-out-');
try {
  const pf1 = sdk(['plugin-from-wheel', project, WHEELS.typing]);
  const pf2 = sdk(['plugin-from-wheel', project, WHEELS.lxml]);
  const pf3 = sdk(['plugin-from-wheel', project, WHEELS.docx]);
  check('E2E1 三次 plugin-from-wheel 成功且 id 正确',
    pf1.status === 0 && pf1.doc.id === 'py-typing-extensions'
    && pf2.status === 0 && pf2.doc.id === 'py-lxml'
    && pf3.status === 0 && pf3.doc.id === 'py-python-docx',
    JSON.stringify([pf1.stderr, pf2.stderr, pf3.stderr]));

  fs.writeFileSync(path.join(project, 'capability.json'), JSON.stringify({
    schemaVersion: 1,
    capability: {
      id: 'docx-demo-e2e', version: '1.0.0', displayName: 'Docx Demo E2E',
      description: 'TEST ONLY e2e project carrying typing_extensions + lxml + python-docx.',
      plugins: ['py-typing-extensions', 'py-lxml', 'py-python-docx'],
      skills: ['docx-demo-e2e'], mcps: [],
    },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(project, 'locus.json'), JSON.stringify({
    title: 'Docx Demo E2E', author: 'locus-owner',
    purpose: 'TEST ONLY e2e project carrying typing_extensions + lxml + python-docx.',
    changelog: ['1.0.0（2026-10-31）：test fixture'],
  }, null, 2) + '\n');
  fs.mkdirSync(path.join(project, 'skills', 'docx-demo-e2e'), { recursive: true });
  fs.writeFileSync(path.join(project, 'skills', 'docx-demo-e2e', 'skill.json'), JSON.stringify({
    schemaVersion: 1,
    skill: { id: 'docx-demo-e2e', version: '1', displayName: 'Docx demo',
      description: 'TEST ONLY e2e skill.' },
    source: 'SKILL.md',
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(project, 'skills', 'docx-demo-e2e', 'SKILL.md'),
    '# Docx demo\n\n'
    + 'TEST ONLY e2e skill——用 python-docx 生成一个最小 Word 文档：\n\n'
    + '```python\n'
    + 'import docx\n\n'
    + 'document = docx.Document()\n'
    + 'document.add_heading("Locus", level=1)\n'
    + 'document.add_paragraph("Generated by the docx-demo-e2e capability.")\n'
    + 'document.save("demo.docx")\n'
    + '```\n\n'
    + '本技能不含任何网络请求。\n');

  const v = sdk(['validate', project]);
  check('E2E1 validate 为空（依赖顺序正确、闭包完整）', v.status === 0
    && v.doc.ok === true && v.doc.diagnostics.length === 0,
    JSON.stringify(v.doc).slice(0, 400));

  const b = sdk(['build', project, outDir]);
  const artifactPath = path.join(outDir, 'docx-demo-e2e-1.0.0.locus');
  check('E2E1 build 出包', b.status === 0 && b.doc.ok === true
    && b.doc.path === artifactPath && fs.existsSync(artifactPath),
    JSON.stringify(b.doc).slice(0, 300));
  const i = sdk(['inspect', artifactPath]);
  const pluginIds = i.doc && i.doc.components ? i.doc.components.plugins.map((p) => p.id) : [];
  // components.plugins 恒为字母序（vendor 清单 VW 记录的既有契约）；
  // 声明顺序由 validate 的 wheel 依赖顺序规则强制（上一步 validate 为空）。
  check('E2E1 inspect ok 且组件齐全', i.status === 0 && i.doc.ok === true
    && i.doc.id === 'docx-demo-e2e'
    && JSON.stringify(pluginIds)
      === JSON.stringify(['py-lxml', 'py-python-docx', 'py-typing-extensions']),
    JSON.stringify(i.doc).slice(0, 300));

  // ---------- E2E2 product inspect/analyze 复核 ----------
  const svcMod = await import('locus-browser-agent-runtime/src/capability-packages.js');
  const service = svcMod.createCapabilityPackages({
    persistence: { loadCapabilityPackages: async () => [] },
    manager: {},
    now: () => '1970-01-01T00:00:00.000Z',
  });
  const artifact = fs.readFileSync(artifactPath);
  const summary = await service.inspect(artifact);
  check('E2E2 product inspect ok / kind new / mismatched 空',
    summary.ok === true && summary.kind === 'new' && summary.mismatched.length === 0,
    JSON.stringify(summary.diagnostics || null));
  check('E2E2 product 组件齐全（含 lxml 原生 wheel 的 D13 导入检查）',
    summary.ok
    && JSON.stringify(summary.components.plugins.map((p) => p.id))
      === JSON.stringify(['py-lxml', 'py-python-docx', 'py-typing-extensions']),
    JSON.stringify(summary.components && summary.components.plugins));
  const analyze = await service.analyze(artifact);
  // analyze 成功时没有 diagnostics 字段；D13 wheel 导入检查失败会让
  // inspect/analyze 都 ok:false——inspect ok + analyze ok 即导入检查通过。
  check('E2E2 product analyze ok（D13 导入检查通过）', analyze.ok === true
    && Array.isArray(analyze.components.plugins) && analyze.components.plugins.length === 3,
    JSON.stringify(analyze.diagnostics || analyze.components || null));

  // ---------- E2E3 顺序反过来 ----------
  const capPath = path.join(project, 'capability.json');
  const capDoc = JSON.parse(fs.readFileSync(capPath, 'utf8'));
  capDoc.capability.plugins = ['py-python-docx', 'py-lxml', 'py-typing-extensions'];
  fs.writeFileSync(capPath, JSON.stringify(capDoc, null, 2) + '\n');
  const vRev = sdk(['validate', project]);
  const revCodes = vRev.doc ? vRev.doc.diagnostics.map((d) => d.code) : [];
  check('E2E3 顺序反了报 wheel-dependency-order', vRev.status === 1
    && revCodes.filter((c) => c === 'wheel-dependency-order').length === 2
    && vRev.doc.diagnostics.some((d) => d.code === 'wheel-dependency-order'
      && d.message.includes('py-typing-extensions')),
    JSON.stringify(vRev.doc).slice(0, 500));

  // ---------- E2E4 去掉 typing_extensions ----------
  capDoc.capability.plugins = ['py-python-docx', 'py-lxml'];
  fs.writeFileSync(capPath, JSON.stringify(capDoc, null, 2) + '\n');
  rmRf(path.join(project, 'plugins', 'py-typing-extensions'));
  const vMiss = sdk(['validate', project]);
  check('E2E4 缺 typing_extensions 报 wheel-dependency-missing', vMiss.status === 1
    && vMiss.doc.diagnostics.some((d) => d.code === 'wheel-dependency-missing'
      && d.message.includes('typing_extensions') && d.message.includes('py-typing-extensions')),
    JSON.stringify(vMiss.doc).slice(0, 500));
} finally {
  rmRf(project);
  rmRf(outDir);
  rmRf(pipTarget);
}

console.log('sdk-e2e-authoring.test: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
