// capability-authoring 能力测试（CA1–CA4，C4-CAP）：
//   CA1  构建 dist/capability-authoring-1.0.0.locus：两次构建字节相同、
//        product inspect 通过（ok / kind 'new' / mismatched 空、恰好 1 个
//        plugin "py-locus-capability-sdk" + 1 个 skill "capability-authoring"）、
//        skill 规范检查通过。
//   CA2  模拟 C5（C4 §5 验收的第 2–4 步，脚本化）：临时目录里用 pip 安装
//        vendor 里的 SDK wheel（--no-deps --target），之后所有 Python 子进程
//        的 sys.path 只含该目标目录（不含仓库 packages/），证明装好的 wheel
//        本身够用。按 SKILL.md 示例的文件内容（直接从 SKILL.md 提取）创建
//        reference-text-analysis 项目 → sys.path 挂 src/ 跑插件断言 →
//        build_wheel → validate（[]）→ build → inspect（ok）。再用 product
//        的 inspect 复核同一个 .locus：id/version/author/purpose/digest/
//        组件/文件数/总大小与 sdk.inspect 一致。最后把产出的 plugin wheel
//        pip 安装到另一临时目录，word_count / top_terms 输出正确。
//   CA3  反例：在 CA2 的项目上各改一处，重新 validate 必须得到对应诊断，
//        且 build 不产出任何文件：
//          - credentials 声明 origin 为 http://api.example.com
//              → package_descriptor_invalid
//          - SKILL.md 追加一条带 $UNDECLARED 的 curl
//              → undeclared-variable
//          - capability.version 改成 "1.0" → version-format
//          - 删掉 plugins/<id>/artifacts 下的 wheel → package_artifact_missing
//   CA4  SKILL.md 顶层 ```python 代码块都能被 CPython ast.parse，且只导入
//        标准库与 locus_capability_sdk（围栏按长度配对：示例里 4 反引号
//        markdown 块内嵌的 ```python 属于示例文本，不算顶层块）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createCapabilityPackages } from 'locus-browser-agent-runtime/src/capability-packages.js';

import { buildCapability, capabilitiesDir, distDir } from '../scripts/build.mjs';
import { checkSkillSpecs } from '../scripts/skill-spec.mjs';

const CAPABILITY_ID = 'capability-authoring';
const capabilityDir = path.join(capabilitiesDir, CAPABILITY_ID);
const skillMdPath = path.join(capabilityDir, 'skills', CAPABILITY_ID, 'SKILL.md');
const distPath = path.join(distDir, CAPABILITY_ID + '-1.0.0.locus');
const repoRoot = path.dirname(capabilitiesDir);
const pythonBin = process.env.PYTHON || 'python';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}
const bytesEqual = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const sha256Of = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// ---------- 围栏长度感知的代码块提取 ----------
// 返回顶层围栏块 [{ lang, content }]；开栏 `N 个反引号 + 信息串`，闭栏至少
// N 个反引号——嵌在更长围栏里的短围栏（示例文本）不会提前闭合。
function extractFencedBlocks(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let open = null; // { fenceLen, lang, content[] }
  for (const line of lines) {
    if (open) {
      const closeMatch = line.match(/^(`{0,})\s*$/);
      if (closeMatch && closeMatch[1].length >= open.fenceLen) {
        blocks.push({ lang: open.lang, content: open.content.join('\n') + '\n' });
        open = null;
      } else {
        open.content.push(line);
      }
      continue;
    }
    const openMatch = line.match(/^(`{3,})(\S*)\s*$/);
    if (openMatch) open = { fenceLen: openMatch[1].length, lang: openMatch[2], content: [] };
  }
  return blocks;
}

// SKILL.md 示例里的文件块：加粗独占一行的相对路径，后跟（可隔空行）一个
// 围栏块。返回 Map<相对路径, 文本>。
function extractExampleFiles(text) {
  const files = new Map();
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\*\*([A-Za-z0-9._/-]+)\*\*$/);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    const open = lines[j] ? lines[j].match(/^(`{3,})(\S*)\s*$/) : null;
    if (!open) continue;
    const fenceLen = open[1].length;
    const content = [];
    let closed = false;
    let k = j + 1;
    for (; k < lines.length; k++) {
      const closeMatch = lines[k].match(/^(`{3,})\s*$/);
      if (closeMatch && closeMatch[1].length >= fenceLen) { closed = true; break; }
      content.push(lines[k]);
    }
    if (!closed) continue;
    files.set(m[1], content.join('\n') + '\n');
    i = k;
  }
  return files;
}

// ---------- CA1：构建 + inspect + skill 规范 ----------
const first = await buildCapability(capabilityDir);
const second = await buildCapability(capabilityDir);
check('CA1: build id/version are capability-authoring@1.0.0',
  first.id === CAPABILITY_ID && first.version === '1.0.0',
  first.id + '@' + first.version);
check('CA1: two in-process builds are byte-identical', bytesEqual(first.bytes, second.bytes));
const b1 = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'build.mjs'), CAPABILITY_ID],
  { cwd: repoRoot, encoding: 'utf8' });
check('CA1: build script exits 0', b1.status === 0, (b1.stderr || '').slice(0, 400));
check('CA1: dist/capability-authoring-1.0.0.locus exists', fs.existsSync(distPath));
const dist1 = fs.readFileSync(distPath);
check('CA1: script artifact matches in-process build', bytesEqual(dist1, first.bytes));
const b2 = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'build.mjs'), CAPABILITY_ID],
  { cwd: repoRoot, encoding: 'utf8' });
check('CA1: two script builds are byte-identical',
  b2.status === 0 && bytesEqual(dist1, fs.readFileSync(distPath)));

const service = createCapabilityPackages({
  persistence: { loadCapabilityPackages: async () => [] },
  manager: {}, // inspect() 只要求 manager 为真值，不读其状态
  now: () => '1970-01-01T00:00:00.000Z',
});
const summary = await service.inspect(first.bytes);
check('CA1: inspect ok', summary.ok === true, JSON.stringify(summary.diagnostics || null));
check('CA1: inspect kind is new', summary.ok && summary.kind === 'new', String(summary.kind));
check('CA1: inspect mismatched is empty',
  summary.ok && summary.mismatched.length === 0, JSON.stringify(summary.mismatched));
check('CA1: exactly 1 plugin "py-locus-capability-sdk" and 1 skill "capability-authoring"',
  summary.ok && summary.components.plugins.length === 1
    && summary.components.plugins[0].id === 'py-locus-capability-sdk'
    && summary.components.skills.length === 1
    && summary.components.skills[0].id === 'capability-authoring',
  JSON.stringify(summary.components));
check('CA1: no skill spec violations',
  checkSkillSpecs(capabilityDir).length === 0, JSON.stringify(checkSkillSpecs(capabilityDir)));

// ---------- CA2/CA3 的公共构件 ----------
const sdkEntry = JSON.parse(fs.readFileSync(path.join(repoRoot, 'vendor', 'wheels.json'), 'utf8'))
  .find((e) => e.id === 'py-locus-capability-sdk');
const sdkWheelPath = path.join(repoRoot, 'vendor', 'wheels', sdkEntry.filename);

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function rmRf(dir) {
  // win32 下句柄未释放时 rmSync 可能 EPERM——稍候重试一次，再失败则降级为警告
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e2) {
      console.log('WARN cleanup failed for ' + dir + ': ' + e2.message);
    }
  }
}
// 只把目标目录放进 sys.path：PYTHONPATH 仅含 pip --target 目录。
function pyEnv(target) {
  return { ...process.env, PYTHONPATH: target };
}
function runPython(args, env, cwd) {
  return spawnSync(pythonBin, args, { encoding: 'utf8', env, cwd });
}

// 从 SKILL.md 提取示例文件内容并创建 CA2 项目。
const skillMd = fs.readFileSync(skillMdPath, 'utf8');
const exampleFiles = extractExampleFiles(skillMd);
const EXAMPLE_PATHS = [
  'capability.json',
  'locus.json',
  'skills/text-analysis-workflow/skill.json',
  'skills/text-analysis-workflow/SKILL.md',
  'plugins/reference-text-tools/plugin.json',
  'src/reference_text_tools/__init__.py',
];

function writeExampleProject(projectDir) {
  for (const rel of EXAMPLE_PATHS) {
    const content = exampleFiles.get(rel);
    if (content === undefined) throw new Error('SKILL.md 缺少示例文件块: ' + rel);
    const abs = path.join(projectDir, rel.replace(/\//g, path.sep));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
}

const BUILD_WHEEL_SUMMARY = 'Deterministic word count and top-terms extraction for plain text.';
const PLUGIN_WHEEL = 'reference_text_tools-1.0.0-py3-none-any.whl';

// 建好完整 CA2 项目（含 build_wheel 产物），返回 { project, out, target, sdkDoc }。
function buildCa2Project() {
  const tmp = tmpDir('c4cap-ca2-');
  const target = path.join(tmp, 'sdkenv');
  const project = path.join(tmp, 'reference-text-analysis');
  const out = path.join(tmp, 'out');
  fs.mkdirSync(target);
  const pip = spawnSync(pythonBin, ['-m', 'pip', 'install', '--quiet', '--no-deps',
    '--target', target, sdkWheelPath], { encoding: 'utf8' });
  if (pip.status !== 0) throw new Error('pip install SDK wheel 失败: ' + (pip.stderr || ''));
  writeExampleProject(project);

  const env = pyEnv(target);
  // 3. import src 跑测试
  const t = runPython(['-c',
    'import sys; sys.path.insert(0, "src"); import reference_text_tools as t; '
    + 'assert t.word_count("Hello world, hello Locus!") == 4; '
    + 'assert t.top_terms("one two one three one two", 2) == [("one", 3), ("two", 2)]; '
    + 'assert t.word_count("") == 0 and t.top_terms("", 5) == []; '
    + 'print("plugin tests passed")'], env, project);
  if (t.status !== 0 || t.stdout.trim() !== 'plugin tests passed') {
    throw new Error('src 测试失败: ' + (t.stderr || t.stdout));
  }
  // 4. build_wheel
  const w = runPython(['-m', 'locus_capability_sdk', 'build-wheel', 'src',
    'reference_text_tools', '1.0.0', 'plugins/reference-text-tools/artifacts',
    '--summary', BUILD_WHEEL_SUMMARY], env, project);
  if (w.status !== 0) throw new Error('build-wheel 失败: ' + (w.stderr || w.stdout));
  // 5. validate —— 应为空
  const v = runPython(['-m', 'locus_capability_sdk', 'validate', '.'], env, project);
  const vDoc = JSON.parse(v.stdout || '{}');
  if (v.status !== 0 || !Array.isArray(vDoc.diagnostics) || vDoc.diagnostics.length !== 0) {
    throw new Error('validate 应为空: ' + v.stdout + (v.stderr || ''));
  }
  // 6. build
  const b = runPython(['-m', 'locus_capability_sdk', 'build', '.', out], env, project);
  const bDoc = JSON.parse(b.stdout || '{}');
  if (b.status !== 0 || bDoc.ok !== true) throw new Error('build 失败: ' + b.stdout + (b.stderr || ''));
  // 7. inspect
  const i = runPython(['-m', 'locus_capability_sdk', 'inspect', bDoc.path], env, project);
  const iDoc = JSON.parse(i.stdout || '{}');
  if (i.status !== 0 || iDoc.ok !== true) throw new Error('inspect 失败: ' + i.stdout + (i.stderr || ''));
  return { tmp, target, project, out, env, buildDoc: bDoc, inspectDoc: iDoc };
}

// ---------- CA2：模拟 C5 全流程 ----------
{
  let ctx = null;
  try {
    ctx = buildCa2Project();
    const { project, out, env, buildDoc, inspectDoc } = ctx;
    check('CA2: SKILL.md 提供全部 6 个示例文件块',
      EXAMPLE_PATHS.every((p) => exampleFiles.has(p)),
      JSON.stringify([...exampleFiles.keys()]));
    check('CA2: build 产物路径与文件名',
      buildDoc.path === path.join(out, 'reference-text-analysis-1.0.0.locus'),
      String(buildDoc.path));
    check('CA2: sdk.inspect 摘要 ok 且身份正确',
      inspectDoc.ok === true && inspectDoc.id === 'reference-text-analysis'
        && inspectDoc.version === '1.0.0' && inspectDoc.author === 'locus-owner',
      JSON.stringify([inspectDoc.id, inspectDoc.version, inspectDoc.author]));
    check('CA2: 组件为 1 plugin + 1 skill',
      inspectDoc.components.plugins.length === 1
        && inspectDoc.components.plugins[0].id === 'reference-text-tools'
        && inspectDoc.components.skills.length === 1
        && inspectDoc.components.skills[0].id === 'text-analysis-workflow',
      JSON.stringify(inspectDoc.components));

    // product inspect 复核同一个 .locus
    const artifact = fs.readFileSync(buildDoc.path);
    const pSummary = await service.inspect(artifact);
    const pAnalyze = await service.analyze(artifact);
    check('CA2: product inspect ok',
      pSummary.ok === true, JSON.stringify(pSummary.diagnostics || null));
    check('CA2: product 与 sdk.inspect 的 id/version/author/purpose 一致',
      pSummary.id === inspectDoc.id && pSummary.version === inspectDoc.version
        && pSummary.author === inspectDoc.author && pSummary.purpose === inspectDoc.purpose,
      JSON.stringify([pSummary.id, pSummary.version, pSummary.author, pSummary.purpose]));
    check('CA2: product 与 sdk.inspect 的 digest 一致',
      pSummary.digest === inspectDoc.digest,
      inspectDoc.digest + ' vs ' + pSummary.digest);
    check('CA2: product 与 sdk.inspect 的 fileCount/totalBytes 一致',
      pSummary.fileCount === inspectDoc.fileCount
        && pSummary.totalBytes === inspectDoc.totalBytes,
      JSON.stringify([inspectDoc.fileCount, inspectDoc.totalBytes]));
    // analyze.components 元素是 id 字符串，inspect.components 是对象
    const idsOf = (xs) => xs.map((c) => (typeof c === 'string' ? c : c.id)).sort();
    check('CA2: product 与 sdk.inspect 的组件一致',
      JSON.stringify(idsOf(pSummary.components.plugins)) === JSON.stringify(idsOf(inspectDoc.components.plugins))
        && JSON.stringify(idsOf(pSummary.components.skills)) === JSON.stringify(idsOf(inspectDoc.components.skills))
        && JSON.stringify(idsOf(pAnalyze.components.plugins)) === JSON.stringify(idsOf(inspectDoc.components.plugins))
        && JSON.stringify(idsOf(pAnalyze.components.skills)) === JSON.stringify(idsOf(inspectDoc.components.skills)),
      JSON.stringify([inspectDoc.components, pSummary.components]));
    check('CA2: product 与 sdk.inspect 的凭据声明一致（均为空）',
      Array.isArray(inspectDoc.credentials) && inspectDoc.credentials.length === 0
        && Array.isArray(pAnalyze.pkgInput.capability.credentials || [])
        && (pAnalyze.pkgInput.capability.credentials || []).length === 0,
      JSON.stringify([inspectDoc.credentials, pAnalyze.pkgInput.capability.credentials]));
    check('CA2: build 返回的 sha256 与磁盘一致',
      buildDoc.sha256 === sha256Of(buildDoc.path) && buildDoc.bytes === artifact.length);

    // 产出的 plugin wheel 安装到临时目录后 word_count/top_terms 正确
    const wenv = path.join(path.dirname(project), 'wenv');
    const pipW = spawnSync(pythonBin, ['-m', 'pip', 'install', '--quiet', '--no-deps',
      '--target', wenv, path.join(project, 'plugins', 'reference-text-tools', 'artifacts', PLUGIN_WHEEL)],
      { encoding: 'utf8' });
    check('CA2: plugin wheel pip 安装成功', pipW.status === 0, (pipW.stderr || '').slice(0, 300));
    const call = runPython(['-c',
      'import reference_text_tools as t; '
      + 'assert t.word_count("A b a") == 3; '
      + 'assert t.top_terms("A b a", 1) == [("a", 2)]; '
      + 'assert t.top_terms("z y z", 2) == [("z", 2), ("y", 1)]; '
      + 'print("installed wheel ok")'], pyEnv(wenv), null);
    check('CA2: 安装后的 wheel word_count/top_terms 输出正确',
      call.status === 0 && call.stdout.trim() === 'installed wheel ok',
      (call.stderr || call.stdout || '').slice(0, 300));
  } finally {
    if (ctx) rmRf(ctx.tmp);
  }
}

// ---------- CA3：反例 ----------
{
  const cases = [
    {
      name: 'http-origin credential',
      expectedCode: 'package_descriptor_invalid',
      mutate(project) {
        const p = path.join(project, 'capability.json');
        const cap = JSON.parse(fs.readFileSync(p, 'utf8'));
        cap.capability.credentials = [{
          name: 'EXAMPLE_API_KEY',
          label: 'Example key',
          description: 'Counterexample: an http:// origin must be refused.',
          origin: 'http://api.example.com',
          pathPrefix: '/v1/',
          header: 'Authorization',
          scheme: 'Bearer',
        }];
        fs.writeFileSync(p, JSON.stringify(cap, null, 2) + '\n', 'utf8');
      },
    },
    {
      name: 'undeclared curl variable',
      expectedCode: 'undeclared-variable',
      mutate(project) {
        const p = path.join(project, 'skills', 'text-analysis-workflow', 'SKILL.md');
        fs.appendFileSync(p,
          '\nCounterexample: curl -s -H "Authorization: Bearer $UNDECLARED" https://api.example.com/v1/terms\n',
          'utf8');
      },
    },
    {
      name: 'two-part version',
      expectedCode: 'version-format',
      mutate(project) {
        const p = path.join(project, 'capability.json');
        const cap = JSON.parse(fs.readFileSync(p, 'utf8'));
        cap.capability.version = '1.0';
        fs.writeFileSync(p, JSON.stringify(cap, null, 2) + '\n', 'utf8');
      },
    },
    {
      name: 'missing plugin wheel',
      expectedCode: 'package_artifact_missing',
      mutate(project) {
        fs.rmSync(path.join(project, 'plugins', 'reference-text-tools', 'artifacts', PLUGIN_WHEEL));
      },
    },
  ];

  for (const c of cases) {
    let ctx = null;
    try {
      ctx = buildCa2Project();
      const work = path.join(path.dirname(ctx.project), 'mut-' + c.expectedCode);
      fs.cpSync(ctx.project, work, { recursive: true });
      c.mutate(work);
      const outMut = path.join(path.dirname(work), 'out-' + c.expectedCode);

      const v = runPython(['-m', 'locus_capability_sdk', 'validate', '.'], ctx.env, work);
      const vDoc = JSON.parse(v.stdout || '{}');
      const codes = (vDoc.diagnostics || []).map((d) => d.code);
      check('CA3 [' + c.name + ']: validate 报 ' + c.expectedCode,
        v.status === 1 && codes.includes(c.expectedCode),
        v.stdout.slice(0, 300) + (v.stderr || ''));

      const b = runPython(['-m', 'locus_capability_sdk', 'build', '.', outMut], ctx.env, work);
      const bDoc = JSON.parse(b.stdout || '{}');
      const produced = fs.existsSync(outMut) && fs.readdirSync(outMut).length > 0;
      check('CA3 [' + c.name + ']: build ok=false 且不产出文件',
        b.status === 1 && bDoc.ok === false && !produced
          && Array.isArray(bDoc.diagnostics) && bDoc.diagnostics.length > 0
          && (bDoc.diagnostics || []).some((d) => d.code === c.expectedCode),
        'exit ' + b.status + ' ok=' + bDoc.ok + ' produced=' + produced
        + ' out=' + JSON.stringify(fs.existsSync(outMut) ? fs.readdirSync(outMut) : null));
    } finally {
      if (ctx) rmRf(ctx.tmp);
    }
  }
}

// ---------- CA4：SKILL.md 的 python 代码块可解析且导入白名单 ----------
{
  const pyBlocks = extractFencedBlocks(skillMd).filter((b) => b.lang === 'python');
  check('CA4: SKILL.md 至少含 1 个顶层 python 代码块', pyBlocks.length >= 1,
    String(pyBlocks.length));
  const dir = tmpDir('c4cap-ca4-');
  try {
    pyBlocks.forEach((b, i) => fs.writeFileSync(path.join(dir, 'block-' + i + '.py'), b.content, 'utf8'));
    const r = runPython(['-c', `
import ast, json, sys
from pathlib import Path
stdlib = set(sys.stdlib_module_names)
allowed = stdlib | {"locus_capability_sdk"}
out = []
for p in sorted(Path(sys.argv[1]).glob("block-*.py")):
    tree = ast.parse(p.read_text(encoding="utf-8"))
    roots = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            roots.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            roots.add(node.module.split(".")[0])
    out.append({"block": p.name, "imports": sorted(roots),
                "disallowed": sorted(roots - allowed)})
print(json.dumps(out))
`, dir], { ...process.env }, null);
    let docs = null;
    try { docs = JSON.parse((r.stdout || '').trim()); } catch (e) { void e; }
    check('CA4: 全部 python 块 ast.parse 成功且只导入标准库与 locus_capability_sdk',
      r.status === 0 && Array.isArray(docs)
        && docs.every((d) => d.disallowed.length === 0)
        && docs.length === pyBlocks.length,
      r.status === 0 ? JSON.stringify(docs) : (r.stderr || '').slice(0, 400));
  } finally {
    rmRf(dir);
  }
}

console.log('capability-authoring.test: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
