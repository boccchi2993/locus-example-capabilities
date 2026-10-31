// capability-authoring 能力测试（CA1–CA6，C4-CAP + D14）：
//   CA1  构建 dist/capability-authoring-1.1.0.locus：两次构建字节相同、
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
//        唯一白名单扩展：调用 sdk.test_site 的 Word 示例 smoke 块额外允许
//        import docx——docx 由打包进能力的 wheel plugin 提供，只有在
//        test_site 之后才可导入；扩展按"是否调用 sdk.test_site"判定，
//        不会泄漏到其他块。
//   CA5  Word 示例（第三方 wheel 插件）全流程，全部离线：从 SKILL.md §6.2
//        提取文件块建 word-report-builder 项目；三个 wheel 取自
//        vendor/wheels/（代替下载），发布方元数据用 tests/fixtures/
//        wheel-meta/ 的夹具（代替 curl 下载的元数据）；pip --target 安装
//        SDK wheel 后只用装好的 SDK，依次 verify_wheel（×3）→ wheel_info
//        （python-docx 的 requires）→ plugin_from_wheel（×3，依赖在前的
//        顺序）→ validate（[]）→ build → inspect（ok，3 plugin + 1 skill）；
//        product inspect 复核导入检查 ok；生成的三个 plugin.json 与
//        vendorPluginManifest 从 vendor wheel 字节推导的结果逐字节相同
//        （D14 第 5 条共享性）。import docx 冒烟只在 CPython 自带 lxml 时
//        执行（原生 lxml wheel 是 wasm32，CPython 装不了），否则跳过并
//        打印说明。
//   CA6  SKILL.md 的 curl 与说法检查：每条 curl 命令里的 URL 都在
//        pypi.org / files.pythonhosted.org / cdn.jsdelivr.net/pyodide/
//        v0.26.4/ 之下（或示例 capability.json 声明凭据的 origin+pathPrefix
//        内）；不再出现"无网络"类错误说法（短语清单见检查输出）；交付写法
//        为 sandbox:/mnt/download/ 文件卡片链接（≥3 处：§5 交付规则 + 两个
//        示例），"Import from path" 不再作为导入方式出现。
//   CA7  SKILL.md 总长度不超过 32000 字符（单次工具结果上限约 40000 字符，
//        给技能全文留余量——技能文本本身也经工具结果送达）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createCapabilityPackages } from 'locus-browser-agent-runtime/src/capability-packages.js';

import { buildCapability, capabilitiesDir, distDir } from '../scripts/build.mjs';
import { checkSkillSpecs, extractCurlCommands } from '../scripts/skill-spec.mjs';
import { loadVendorEntries, vendorPluginManifest } from '../scripts/vendor.mjs';

const CAPABILITY_ID = 'capability-authoring';
const capabilityDir = path.join(capabilitiesDir, CAPABILITY_ID);
const skillMdPath = path.join(capabilityDir, 'skills', CAPABILITY_ID, 'SKILL.md');
const distPath = path.join(distDir, CAPABILITY_ID + '-1.1.0.locus');
const repoRoot = path.dirname(capabilitiesDir);
const fixturesDir = path.join(repoRoot, 'tests', 'fixtures');
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
// 围栏块。返回 Map<相对路径, 文本>。两个示例共用 capability.json / locus.json
// 这样的路径名——先见者留（第一个示例持有该路径），后者不再覆盖；第二个
// 示例的文件块用 exampleSection + extractExampleFiles 定点提取。
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
    if (!files.has(m[1])) files.set(m[1], content.join('\n') + '\n');
    i = k;
  }
  return files;
}

// 截取 startMarker 所在小节（到 endMarker 为止；无 endMarker 则到文末）。
function exampleSection(text, startMarker, endMarker) {
  const i = text.indexOf(startMarker);
  if (i < 0) throw new Error('SKILL.md 缺少小节标记: ' + startMarker);
  const j = endMarker ? text.indexOf(endMarker, i + startMarker.length) : -1;
  return j < 0 ? text.slice(i) : text.slice(i, j);
}

// ---------- CA1：构建 + inspect + skill 规范 ----------
const first = await buildCapability(capabilityDir);
const second = await buildCapability(capabilityDir);
check('CA1: build id/version are capability-authoring@1.1.0',
  first.id === CAPABILITY_ID && first.version === '1.1.0',
  first.id + '@' + first.version);
check('CA1: two in-process builds are byte-identical', bytesEqual(first.bytes, second.bytes));
const b1 = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'build.mjs'), CAPABILITY_ID],
  { cwd: repoRoot, encoding: 'utf8' });
check('CA1: build script exits 0', b1.status === 0, (b1.stderr || '').slice(0, 400));
check('CA1: dist/capability-authoring-1.1.0.locus exists', fs.existsSync(distPath));
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
  // 白名单扩展（对本文件既有检查的唯一修改）：Word 示例的 wheel smoke 块
  // 在 sdk.test_site 之后 import docx——docx 由打包进能力的 wheel plugin
  // 提供。扩展只作用于调用 sdk.test_site 的块，其余块仍只准标准库 + SDK。
  const docxBlocks = pyBlocks.filter((b) => b.content.includes('sdk.test_site('));
  check('CA4: docx 扩展只覆盖 Word 示例 smoke 块（恰 1 个且 import docx）',
    docxBlocks.length === 1 && docxBlocks[0].content.includes('import docx'),
    String(docxBlocks.length));
  const dir = tmpDir('c4cap-ca4-');
  try {
    const allowedExtra = {};
    pyBlocks.forEach((b, i) => {
      const name = 'block-' + i + '.py';
      fs.writeFileSync(path.join(dir, name), b.content, 'utf8');
      if (b.content.includes('sdk.test_site(')) allowedExtra[name] = ['docx'];
    });
    const allowedPath = path.join(dir, 'allowed-extra.json');
    fs.writeFileSync(allowedPath, JSON.stringify(allowedExtra), 'utf8');
    const r = runPython(['-c', `
import ast, json, sys
from pathlib import Path
stdlib = set(sys.stdlib_module_names)
extra_by_block = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
out = []
for p in sorted(Path(sys.argv[1]).glob("block-*.py")):
    tree = ast.parse(p.read_text(encoding="utf-8"))
    roots = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            roots.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            roots.add(node.module.split(".")[0])
    allowed = stdlib | {"locus_capability_sdk"} | set(extra_by_block.get(p.name, []))
    out.append({"block": p.name, "imports": sorted(roots),
                "disallowed": sorted(roots - allowed)})
print(json.dumps(out))
`, dir, allowedPath], { ...process.env }, null);
    let docs = null;
    try { docs = JSON.parse((r.stdout || '').trim()); } catch (e) { void e; }
    check('CA4: 全部 python 块 ast.parse 成功且只导入标准库与 locus_capability_sdk（smoke 块另允许 docx）',
      r.status === 0 && Array.isArray(docs)
        && docs.every((d) => d.disallowed.length === 0)
        && docs.length === pyBlocks.length,
      r.status === 0 ? JSON.stringify(docs) : (r.stderr || '').slice(0, 400));
  } finally {
    rmRf(dir);
  }
}

// ---------- CA5：Word 示例（第三方 wheel 插件）全流程，全部离线 ----------
{
  const WORD_PATHS = [
    'capability.json',
    'locus.json',
    'skills/docx-report/skill.json',
    'skills/docx-report/SKILL.md',
  ];
  // 依赖在前的顺序：lxml 与 typing_extensions 是 python-docx 的依赖。
  const WORD_WHEELS = [
    { id: 'py-lxml', filename: 'lxml-5.2.1-cp312-cp312-pyodide_2024_0_wasm32.whl', meta: 'pyodide-lock-0.26.4-min.json' },
    { id: 'py-typing-extensions', filename: 'typing_extensions-4.16.0-py3-none-any.whl', meta: 'pypi-typing.json' },
    { id: 'py-python-docx', filename: 'python_docx-1.2.0-py3-none-any.whl', meta: 'pypi-word.json' },
  ];
  const wordWheelPath = (w) => path.join(repoRoot, 'vendor', 'wheels', w.filename);

  // 与 CA2 相同的沙箱约定：SDK 只经 pip --target 安装后使用。
  const tmp = tmpDir('c4cap-ca5-');
  const target = path.join(tmp, 'sdkenv');
  const project = path.join(tmp, 'word-report-builder');
  const out = path.join(tmp, 'out');
  const site = path.join(tmp, 'site');
  try {
    fs.mkdirSync(target);
    const pip = spawnSync(pythonBin, ['-m', 'pip', 'install', '--quiet', '--no-deps',
      '--target', target, sdkWheelPath], { encoding: 'utf8' });
    if (pip.status !== 0) throw new Error('pip install SDK wheel 失败: ' + (pip.stderr || ''));

    // §6.2 小节的文件块定点提取（capability.json / locus.json 与 6.1 同名）。
    const wordFiles = extractExampleFiles(
      exampleSection(skillMd, '### 6.2 ', '## 7. Anti-patterns'));
    check('CA5: SKILL.md §6.2 提供全部 4 个示例文件块',
      WORD_PATHS.every((p) => wordFiles.has(p)),
      JSON.stringify([...wordFiles.keys()]));
    for (const rel of WORD_PATHS) {
      const abs = path.join(project, rel.replace(/\//g, path.sep));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, wordFiles.get(rel), 'utf8');
    }

    const sdkIn = (args) => {
      const r = spawnSync(pythonBin, ['-m', 'locus_capability_sdk', ...args],
        { encoding: 'utf8', env: pyEnv(target), cwd: project });
      let doc = null;
      try { doc = JSON.parse((r.stdout || '').trim()); } catch (e) { void e; }
      return { ...r, doc };
    };

    // verify_wheel ×3（夹具代替 curl 下载的发布方元数据）。
    for (const w of WORD_WHEELS) {
      const r = sdkIn(['verify-wheel', wordWheelPath(w),
        path.join(fixturesDir, 'wheel-meta', w.meta)]);
      check('CA5: verify_wheel 通过 ' + w.id,
        r.status === 0 && r.doc && r.doc.ok === true
        && Array.isArray(r.doc.diagnostics) && r.doc.diagnostics.length === 0,
        (r.stderr || r.stdout || '').slice(0, 300));
    }

    // wheel_info：python-docx 的 Requires-Dist 决定了要 vendor 哪些依赖。
    {
      const r = sdkIn(['wheel-info', wordWheelPath(WORD_WHEELS[2])]);
      check('CA5: wheel_info 列出 python-docx 的两个依赖',
        r.status === 0 && r.doc
        && JSON.stringify(r.doc.requires) === JSON.stringify(['lxml>=3.1.0', 'typing_extensions>=4.9.0']),
        (r.stdout || r.stderr || '').slice(0, 300));
    }

    // plugin_from_wheel ×3，依赖在前的顺序。
    for (const w of WORD_WHEELS) {
      const r = sdkIn(['plugin-from-wheel', '.', wordWheelPath(w)]);
      check('CA5: plugin_from_wheel 生成 ' + w.id,
        r.status === 0 && r.doc && r.doc.id === w.id,
        (r.stderr || r.stdout || '').slice(0, 300));
    }

    // validate（空）→ build → inspect（ok，3 plugin + 1 skill）。
    const v = sdkIn(['validate', '.']);
    const vDoc = JSON.parse(v.stdout || '{}');
    check('CA5: validate 诊断为空',
      v.status === 0 && Array.isArray(vDoc.diagnostics) && vDoc.diagnostics.length === 0,
      v.stdout.slice(0, 400) + (v.stderr || ''));
    const b = sdkIn(['build', '.', out]);
    const bDoc = JSON.parse(b.stdout || '{}');
    check('CA5: build ok 且产物为 word-report-builder-1.0.0.locus',
      b.status === 0 && bDoc.ok === true
      && bDoc.path === path.join(out, 'word-report-builder-1.0.0.locus'),
      (b.stdout || b.stderr || '').slice(0, 300));
    const i5 = sdkIn(['inspect', bDoc.path]);
    const i5Doc = JSON.parse(i5.stdout || '{}');
    const expectedPlugins = ['py-lxml', 'py-python-docx', 'py-typing-extensions'];
    check('CA5: sdk.inspect ok，组件为 3 plugin + 1 skill',
      i5.status === 0 && i5Doc.ok === true
      && JSON.stringify(i5Doc.components.plugins.map((p) => p.id)) === JSON.stringify(expectedPlugins)
      && JSON.stringify(i5Doc.components.skills.map((s) => s.id)) === JSON.stringify(['docx-report']),
      JSON.stringify(i5Doc.components || i5Doc).slice(0, 400));

    // product inspect 复核导入检查。
    const artifact = fs.readFileSync(bDoc.path);
    const pSummary = await service.inspect(artifact);
    const idsOf = (xs) => xs.map((c) => (typeof c === 'string' ? c : c.id)).sort();
    check('CA5: product inspect ok',
      pSummary.ok === true, JSON.stringify(pSummary.diagnostics || null));
    check('CA5: product 组件与 sdk.inspect 一致（3 plugin + 1 skill）',
      pSummary.ok
      && JSON.stringify(idsOf(pSummary.components.plugins)) === JSON.stringify(expectedPlugins)
      && JSON.stringify(idsOf(pSummary.components.skills)) === JSON.stringify(['docx-report']),
      JSON.stringify(pSummary.components || null));

    // 共享性（D14 第 5 条）：生成的 plugin.json 与 vendor 条目经
    // vendorPluginManifest（从 wheel 字节推导）的结果逐字节相同。
    const vendorEntries = loadVendorEntries(repoRoot);
    for (const w of WORD_WHEELS) {
      const entry = vendorEntries.find((e) => e.id === w.id);
      const expected = JSON.stringify(vendorPluginManifest(entry, fs.readFileSync(wordWheelPath(w))), null, 2) + '\n';
      const actual = fs.readFileSync(path.join(project, 'plugins', w.id, 'plugin.json'), 'utf8');
      check('CA5: ' + w.id + ' plugin.json 与 vendorPluginManifest 逐字节相同',
        actual === expected, 'bytes differ for ' + w.id);
    }

    // import docx 冒烟：原生 lxml wheel 是 wasm32，CPython 装不了——只有
    // CPython 自带 lxml 时才执行（test_site 只装两个纯 Python wheel，
    // lxml 走 CPython 自己的 site-packages）；否则跳过并打印说明。
    {
      const r = spawnSync(pythonBin, ['-c', `
import json, sys
from locus_capability_sdk import test_site
try:
    import lxml.etree  # noqa: F401
    have_lxml = True
except Exception:
    have_lxml = False
if not have_lxml:
    print(json.dumps({"tested": False,
        "note": "CPython has no lxml; the native lxml wheel is wasm32 (Pyodide-only) so import docx cannot run here - skipped"}))
    sys.exit(0)
test_site(sys.argv[1:3], site=sys.argv[3], allow_unsafe_site_for_tests=True)
from docx import Document
d = Document()
d.add_heading("CA5", 0)
d.add_paragraph("para")
d.add_paragraph("bullet", style="List Bullet")
d.add_table(rows=1, cols=1)
print(json.dumps({"tested": True, "ok": True}))
`, wordWheelPath(WORD_WHEELS[2]), wordWheelPath(WORD_WHEELS[1]), site],
        { encoding: 'utf8', env: pyEnv(target) });
      let doc = null;
      try { doc = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch (e) { void e; }
      check('CA5: import docx 冒烟（有 lxml 才测，否则跳过）',
        r.status === 0 && doc && (doc.tested === false || doc.ok === true),
        r.status + ' ' + (r.stdout || '').slice(0, 200) + ' ' + (r.stderr || '').slice(0, 300));
      if (doc && doc.tested === false) console.log('NOTE CA5: ' + doc.note);
    }
  } finally {
    rmRf(tmp);
  }
}

// ---------- CA6：SKILL.md 的 curl 来源与"无网络"说法 ----------
{
  // 每条 curl 命令里的 URL 都在允许的来源之下；示例 capability.json 若
  // 声明了凭据，其 origin+pathPrefix 一并放行（本文档的两个示例均未声明）。
  const allowedPrefixes = [
    'https://pypi.org/',
    'https://files.pythonhosted.org/',
    'https://cdn.jsdelivr.net/pyodide/v0.26.4/',
  ];
  for (const rel of ['capability.json']) {
    const content = exampleFiles.get(rel);
    if (!content) continue;
    try {
      const cap = JSON.parse(content).capability;
      for (const c of (cap && cap.credentials) || []) {
        if (c && c.origin && c.pathPrefix) allowedPrefixes.push(c.origin + c.pathPrefix);
      }
    } catch (e) { void e; }
  }
  const curls = extractCurlCommands(skillMd);
  check('CA6: SKILL.md 含 ≥6 条 curl 下载命令', curls.length >= 6, String(curls.length));
  const badUrls = [];
  for (const cmd of curls) {
    for (const m of cmd.matchAll(/https?:\/\/[^\s'"`<>]+/g)) {
      const url = m[0].replace(/[),.;:'"]+$/, '');
      if (!allowedPrefixes.some((p) => url.startsWith(p))) badUrls.push(url);
    }
  }
  check('CA6: 所有 curl URL 在允许来源之下', badUrls.length === 0, JSON.stringify(badUrls));

  // "无网络"类错误说法不得回归（1.0.0 曾写 "There is no network access
  // ... at authoring time"，与 runtime 事实矛盾：GET/HEAD 无需审批）。
  // 注：Python 层不可达网络的事实用 "Python code cannot reach the network"
  // 表述，不落入下列任何短语。
  const lower = skillMd.toLowerCase();
  const banned = [
    'no network',
    'no internet',
    'network access is disabled',
    'network is unavailable',
    'no installing packages at authoring time',
  ];
  const hits = banned.filter((p) => lower.includes(p));
  check('CA6: 无"无网络"类说法（检查短语: ' + banned.join(' | ') + '）',
    hits.length === 0, JSON.stringify(hits));

  // 交付写法（product #55 文件卡片 + sandbox: 链接）：
  //   - 交付用 [名字](sandbox:/mnt/download/…) 文件卡片链接；§5 交付规则、
  //     6.1 / 6.2 两个示例共 ≥3 处；
  //   - "Import from path" 不再作为导入方式出现（主要路径改为点文件卡片
  //     上的 Import；备选写法是 + → Capabilities → Add capability）。
  const linkCount = (skillMd.match(/\]\(sandbox:\/mnt\/download\//g) || []).length;
  check('CA6: 交付为 sandbox:/mnt/download/ 文件卡片链接（≥3 处）',
    linkCount >= 3, String(linkCount));
  check('CA6: "Import from path" 不再出现', !lower.includes('import from path'));
}

// ---------- CA7：SKILL.md 总长度 ----------
{
  // 单次工具结果上限约 40000 字符；SKILL.md 全文也要作为一个工具结果送达，
  // 留出余量，总长不得超过 32000 字符（按 JS 字符计，UTF-16 码元）。
  check('CA7: SKILL.md 总长度 ≤ 32000 字符', skillMd.length <= 32000,
    String(skillMd.length));
}

console.log('capability-authoring.test: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
