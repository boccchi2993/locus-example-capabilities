// XC1–XC8：locus_capability_sdk（packages/，纯 Python 标准库）与 JS 打包
// 管线的交叉校验（docs/C4-CAPABILITY-AUTHORING.md §2.1 A2：逐字节一致）。
//
//   XC1  SDK build 产出的 .locus 与 scripts/build.mjs 的逐字节相同
//        （capabilities/ 全部 + tests/fixtures/ 下每个能构建的夹具）。
//   XC2  对每个夹具与能力：sdk.validate 与 JS（buildProject + skill 规范
//        + wheel 规则）结论相同；package_* 诊断码集合相同；skill 规范
//        规则名一一对应（含 version-format）；wheel 规则有无错误一致。
//   XC3  sdk.inspect 与 product 的 inspect/analyze 对同一 .locus 的
//        id/version/author/purpose/body/组件/凭据声明/files 数/总大小/
//        digest 一致。
//   XC4  build_wheel：两文件小包两次构建字节相同；pip install 后可
//        import 并调用；RECORD 每行哈希与大小和实际文件一致。
//   XC5  SDK 只导入标准库（AST 扫描 import，对照 sys.stdlib_module_names）。
//   XC6  SDK 自己的 wheel 从源码重建与 vendor/wheels/ 提交的逐字节相同。
//   XC7  对 vendor/wheels/ 每个 wheel：SDK plugin_from_wheel 的
//        plugin.json 与 JS vendorPluginManifest（从 wheel 字节推导
//        displayName/description/pythonImports）序列化结果逐字节相同。
//   XC8  16 MiB 上限规则（wheel-too-large）：Python validate 与 JS
//        checkCapabilityWheelRules 对 16 MiB+1 / 恰 16 MiB 的合成 wheel
//        触发/不触发一致。
//
// 运行：node tests/sdk-crosscheck.test.mjs（npm test 会依次跑全部）。
// 需要 CPython >= 3.12 在 PATH 上（或用 PYTHON 环境变量指定）——CI 的
// setup-python 提供；缺失或版本不足时报错退出，不跳过。

import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildCapability, capabilitiesDir, listCapabilityIds } from '../scripts/build.mjs';
import { checkSkillSpecs } from '../scripts/skill-spec.mjs';
import { checkCapabilityWheelRules } from '../scripts/wheel-checks.mjs';
import { loadVendorEntries, vendorPluginManifest } from '../scripts/vendor.mjs';
import { createCapabilityPackages } from 'locus-browser-agent-runtime/src/capability-packages.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = path.join(repoRoot, 'tests', 'fixtures');
const packagesDir = path.join(repoRoot, 'packages');
const pythonBin = process.env.PYTHON || 'python';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + String(detail) : '')); }
}

// ---------- CPython 前置检查 ----------
{
  const probe = spawnSync(pythonBin, ['-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])'], {
    encoding: 'utf8',
  });
  const version = probe.status === 0 ? probe.stdout.trim() : null;
  const ok = version !== null
    && (() => {
      const [a, b] = version.split('.').map(Number);
      return a > 3 || (a === 3 && b >= 12);
    })();
  check('CPython >= 3.12 可用（' + pythonBin + '）', ok,
    probe.stderr || ('got ' + JSON.stringify(version)));
  if (!ok) {
    console.log('sdk-crosscheck.test: ' + passed + ' passed, ' + failed + ' failed');
    process.exit(1);
  }
}

// ---------- SDK 调用器（CLI，JSON 输出） ----------
function sdk(args) {
  const r = spawnSync(pythonBin, ['-m', 'locus_capability_sdk', ...args], {
    encoding: 'utf8',
    cwd: repoRoot,
    env: { ...process.env, PYTHONPATH: packagesDir },
  });
  if (r.error) throw new Error('SDK 调用失败: ' + r.error.message);
  const stdout = (r.stdout || '').trim();
  let doc = null;
  try {
    doc = JSON.parse(stdout);
  } catch (e) {
    throw new Error('SDK 输出不是 JSON（exit ' + r.status + '）: '
      + stdout.slice(0, 200) + ' | stderr: ' + (r.stderr || '').slice(0, 400));
  }
  return { status: r.status, doc, stdout,
    stderr: (r.stderr || '').trim() };
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sha256Of(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// ---------- 构建对象清单 ----------
// capabilities/ 全部 + fixtures 里同时有 capability.json 与 locus.json 的
// 目录（能经 buildCapability 构建的用户级夹具）。sdk-wheel-demo 是 XC4
// 的 wheel 源码夹具，不是能力项目，天然不在其列。
const fixtureIds = fs.readdirSync(fixturesDir, { withFileTypes: true })
  .filter((e) => e.isDirectory()
    && fs.existsSync(path.join(fixturesDir, e.name, 'capability.json')))
  .map((e) => e.name)
  .sort();
const buildableFixtures = fixtureIds.filter(
  (id) => fs.existsSync(path.join(fixturesDir, id, 'locus.json')));
const capabilityIds = listCapabilityIds();
const xc1Targets = [...capabilityIds.map((id) => path.join(capabilitiesDir, id)),
  ...buildableFixtures.map((id) => path.join(fixturesDir, id))];
const xc2Targets = [...capabilityIds.map((id) => path.join(capabilitiesDir, id)),
  ...fixtureIds.map((id) => path.join(fixturesDir, id))];

// 没有 locus.json 的夹具：加一份临时元文件（不进包、不参与校验）走真实
// buildCapability 管线，得到 JS 结论。
const TEMP_LOCUS_JSON = {
  title: 'Crosscheck fixture',
  author: 'locus-owner',
  purpose: 'Crosscheck-only locus.json for fixtures that ship none.',
  changelog: ['交叉校验临时元文件。'],
};

// JS 侧 build 结论：成功 -> []；失败 -> buildProject 诊断码集合。
async function jsPackageCodes(sourceDir) {
  if (!fs.existsSync(path.join(sourceDir, 'capability.json'))) {
    return { thrown: 'not-a-capability', codes: [] };
  }
  const hasLocusJson = fs.existsSync(path.join(sourceDir, 'locus.json'));
  let dir = sourceDir;
  let cleanup = null;
  if (!hasLocusJson) {
    dir = tmpDir('locus-xc2-');
    fs.cpSync(sourceDir, dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'locus.json'), JSON.stringify(TEMP_LOCUS_JSON, null, 2) + '\n');
    cleanup = dir;
  }
  try {
    await buildCapability(dir);
    return { thrown: null, codes: [] };
  } catch (e) {
    const m = /buildProject 校验失败: (.*)$/.exec(String(e && e.message));
    if (!m) return { thrown: String(e && e.message), codes: [] };
    const codes = m[1].split(';').map((part) => {
      const t = part.trim();
      const at = t.indexOf(' at ');
      return (at >= 0 ? t.slice(0, at) : t).trim();
    });
    return { thrown: null, codes };
  } finally {
    if (cleanup) fs.rmSync(cleanup, { recursive: true, force: true });
  }
}

const SKILL_RULE_CODES = ['literal-key', 'undeclared-variable', 'url-outside-prefix', 'version-format'];
const isWheelCode = (code) => code.startsWith('wheel-');
const isPackageCode = (code) => code.startsWith('package_');

const setOf = (xs) => [...new Set(xs)].sort();
const sameSet = (a, b) => JSON.stringify(setOf(a)) === JSON.stringify(setOf(b));
// CLI 输出按 sort_keys 排序，与 JS 对象的插入序不同——按内容比较。
const canonical = (value) => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
};

// ---------- XC1：.locus 逐字节一致 ----------
{
  for (const sourceDir of xc1Targets) {
    const label = path.relative(repoRoot, sourceDir);
    const jsBuilt = await buildCapability(sourceDir); // 能构建的夹具才进 XC1
    const outDir = tmpDir('locus-xc1-');
    try {
      const r = sdk(['build', sourceDir, outDir]);
      check('XC1 ' + label + ' build ok', r.status === 0 && r.doc.ok === true,
        JSON.stringify(r.doc).slice(0, 300));
      const sdkPath = r.doc && r.doc.path;
      const expected = path.join(outDir,
        jsBuilt.id + '-' + jsBuilt.version + '.locus');
      check('XC1 ' + label + ' SDK 产出文件名一致',
        !!sdkPath && path.basename(sdkPath) === path.basename(expected), String(sdkPath));
      if (sdkPath && fs.existsSync(sdkPath)) {
        const a = fs.readFileSync(sdkPath);
        const b = Buffer.from(jsBuilt.bytes);
        check('XC1 ' + label + ' .locus 逐字节相同',
          Buffer.compare(a, b) === 0,
          'sdk ' + a.length + 'B sha ' + sha256Of(sdkPath).slice(0, 16)
          + ' vs js ' + b.length + 'B');
        check('XC1 ' + label + ' sha256 字段一致',
          r.doc.sha256 === sha256Of(sdkPath) && r.doc.bytes === a.length);
      }
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }
}

// ---------- XC2：validate 结论与诊断码 ----------
{
  for (const sourceDir of xc2Targets) {
    const label = path.relative(repoRoot, sourceDir);
    const jsBuild = await jsPackageCodes(sourceDir);
    const jsSkillRules = checkSkillSpecs(sourceDir).map((v) => v.rule);
    const jsWheelHasError = checkCapabilityWheelRules(repoRoot, sourceDir).length > 0;

    const r = sdk(['validate', sourceDir]);
    check('XC2 ' + label + ' validate 输出 JSON', r.status >= 0 && Array.isArray(r.doc.diagnostics),
      r.stderr || r.stdout.slice(0, 200));
    if (!Array.isArray(r.doc.diagnostics)) continue;
    const codes = r.doc.diagnostics.map((d) => d.code);
    const sdkPackage = codes.filter(isPackageCode);
    const sdkSkill = codes.filter((c) => SKILL_RULE_CODES.includes(c));
    const sdkWheel = codes.filter(isWheelCode);

    check('XC2 ' + label + ' package_* 码集合与 JS buildProject 一致',
      jsBuild.thrown === null && sameSet(sdkPackage, jsBuild.codes),
      'js=' + JSON.stringify(jsBuild) + ' sdk=' + JSON.stringify(sdkPackage));
    check('XC2 ' + label + ' skill 规范规则名一一对应',
      sameSet(sdkSkill, jsSkillRules),
      'js=' + JSON.stringify(jsSkillRules) + ' sdk=' + JSON.stringify(sdkSkill));
    check('XC2 ' + label + ' wheel 规则有无错误一致',
      sdkWheel.length > 0 === jsWheelHasError,
      'js=' + jsWheelHasError + ' sdk=' + JSON.stringify(sdkWheel));
    check('XC2 ' + label + ' validate 无未知诊断码',
      codes.every((c) => isPackageCode(c) || isWheelCode(c) || SKILL_RULE_CODES.includes(c)),
      JSON.stringify(codes));
  }
}

// ---------- XC3：inspect 与 product inspect/analyze 一致 ----------
{
  const service = createCapabilityPackages({
    persistence: { loadCapabilityPackages: async () => [] },
    manager: {},
    now: () => '1970-01-01T00:00:00.000Z',
  });
  for (const sourceDir of xc1Targets) {
    const label = path.relative(repoRoot, sourceDir);
    const jsBuilt = await buildCapability(sourceDir);
    const artifact = path.join(tmpDir('locus-xc3-'), 'pkg.locus');
    fs.writeFileSync(artifact, Buffer.from(jsBuilt.bytes));
    try {
      const summary = await service.inspect(Buffer.from(jsBuilt.bytes));
      const analyze = await service.analyze(Buffer.from(jsBuilt.bytes));
      const r = sdk(['inspect', artifact]);
      check('XC3 ' + label + ' inspect ok', r.status === 0 && r.doc.ok === true,
        JSON.stringify(r.doc.diagnostics || r.stderr).slice(0, 300));
      if (!r.doc.ok) continue;
      const s = r.doc;
      check('XC3 ' + label + ' id/version/author/purpose 一致',
        s.id === summary.id && s.version === summary.version
        && s.author === summary.author && s.purpose === summary.purpose,
        JSON.stringify({ sdk: [s.id, s.version, s.author, s.purpose],
          js: [summary.id, summary.version, summary.author, summary.purpose] }));
      check('XC3 ' + label + ' digest 一致', s.digest === summary.digest,
        s.digest + ' vs ' + summary.digest);
      check('XC3 ' + label + ' fileCount/totalBytes 一致',
        s.fileCount === summary.fileCount && s.totalBytes === summary.totalBytes,
        JSON.stringify({ sdk: [s.fileCount, s.totalBytes], js: [summary.fileCount, summary.totalBytes] }));
      check('XC3 ' + label + ' LOCUS.md 正文一致', s.body === summary.body);
      // service.inspect / sdk.inspect 给对象 {id, displayName}；service.analyze
      // 给 id 字符串数组——分别取 id 后按集合比较（旧写法把两边都映射成
      // [null]，比较恒真，检不出任何差异）。
      const idsOfInspect = (list) => setOf(list.map((c) => c.id));
      const idsOfAnalyze = (list) => setOf(list);
      check('XC3 ' + label + ' 组件一致',
        sameSet(s.components.plugins.map((c) => c.id), summary.components.plugins.map((c) => c.id))
        && sameSet(s.components.skills.map((c) => c.id), summary.components.skills.map((c) => c.id))
        && sameSet(s.components.mcps.map((c) => c.id), summary.components.mcps.map((c) => c.id))
        && sameSet(idsOfAnalyze(analyze.components.plugins), idsOfInspect(s.components.plugins))
        && sameSet(idsOfAnalyze(analyze.components.skills), idsOfInspect(s.components.skills))
        && sameSet(idsOfAnalyze(analyze.components.mcps), idsOfInspect(s.components.mcps)),
        JSON.stringify({ sdk: s.components, js: summary.components }));
      check('XC3 ' + label + ' 凭据声明一致',
        canonical(s.credentials) === canonical(analyze.pkgInput.capability.credentials || []),
        JSON.stringify({ sdk: s.credentials, js: analyze.pkgInput.capability.credentials }));
      check('XC3 ' + label + ' mismatched 为空',
        Array.isArray(s.mismatched) && s.mismatched.length === 0
        && summary.mismatched.length === 0);
    } finally {
      fs.rmSync(path.dirname(artifact), { recursive: true, force: true });
    }
  }
}

// ---------- XC4：build_wheel 确定性 / 可安装 / RECORD ----------
{
  const srcDir = path.join(fixturesDir, 'sdk-wheel-demo');
  const out1 = tmpDir('locus-xc4a-');
  const out2 = tmpDir('locus-xc4b-');
  const target = tmpDir('locus-xc4t-');
  try {
    const SUMMARY = 'XC4 two-file fixture wheel.';
    const r1 = sdk(['build-wheel', srcDir, 'sdkdemo', '0.1.0', out1, '--summary', SUMMARY]);
    const r2 = sdk(['build-wheel', srcDir, 'sdkdemo', '0.1.0', out2, '--summary', SUMMARY]);
    check('XC4 build-wheel 两次成功',
      r1.status === 0 && r2.status === 0
      && path.basename(r1.doc.path) === 'sdkdemo-0.1.0-py3-none-any.whl',
      JSON.stringify([r1.doc, r2.doc]).slice(0, 300));
    const w1 = fs.readFileSync(r1.doc.path);
    const w2 = fs.readFileSync(r2.doc.path);
    check('XC4 两次构建字节相同', Buffer.compare(w1, w2) === 0,
      sha256Of(r1.doc.path) + ' vs ' + sha256Of(r2.doc.path));

    const pip = spawnSync(pythonBin, ['-m', 'pip', 'install', '--quiet', '--no-deps',
      '--target', target, r1.doc.path], { encoding: 'utf8' });
    check('XC4 pip install 成功', pip.status === 0,
      (pip.stderr || '').slice(0, 300));
    const callout = spawnSync(pythonBin, ['-c',
      'import sdkdemo; assert sdkdemo.greeting("locus") == "HELLO, LOCUS!"; print("ok")'],
      { encoding: 'utf8', env: { ...process.env, PYTHONPATH: target } });
    check('XC4 安装后可 import 并调用', callout.status === 0 && callout.stdout.trim() === 'ok',
      (callout.stderr || '').slice(0, 300));

    const record = spawnSync(pythonBin, ['-c', `
import base64, hashlib, json, sys, zipfile
wheel = sys.argv[1]
with zipfile.ZipFile(wheel) as z:
    names = set(z.namelist())
    record = z.read("sdkdemo-0.1.0.dist-info/RECORD").decode("utf-8").rstrip("\\n").split("\\n")
    ok = True
    for line in record:
        p, h, size = line.split(",")
        if h == "" and size == "":
            ok = ok and p == "sdkdemo-0.1.0.dist-info/RECORD"
            continue
        data = z.read(p)
        want = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip("=")
        ok = ok and h == "sha256=" + want and int(size) == len(data)
    listed = {l.split(",")[0] for l in record}
    print(json.dumps({"ok": ok and listed == names}))
`, r1.doc.path], { encoding: 'utf8' });
    check('XC4 RECORD 哈希与大小和实际文件一致',
      record.status === 0 && JSON.parse(record.stdout.trim()).ok === true,
      (record.stderr || record.stdout || '').slice(0, 300));
  } finally {
    for (const d of [out1, out2, target]) fs.rmSync(d, { recursive: true, force: true });
  }
}

// ---------- XC5：只导入标准库 ----------
{
  const r = spawnSync(pythonBin, ['-c', `
import ast, json, sys
from pathlib import Path
roots = set()
sdk_dir = Path(sys.argv[1]) / "locus_capability_sdk"
for f in sorted(sdk_dir.glob("*.py")):
    tree = ast.parse(f.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            roots.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            roots.add(node.module.split(".")[0])
stdlib = set(sys.stdlib_module_names)
print(json.dumps({"files": len(list(sdk_dir.glob("*.py"))), "roots": sorted(roots), "non_stdlib": sorted(roots - stdlib)}))
`, packagesDir], { encoding: 'utf8' });
  const doc = record_json(r);
  check('XC5 SDK 只导入标准库', doc !== null && doc.non_stdlib.length === 0,
    doc === null ? (r.stderr || '').slice(0, 300) : JSON.stringify(doc));
  check('XC5 SDK 标准库导入清单非空', doc !== null && doc.roots.length > 0,
    JSON.stringify(doc && doc.roots));
}

function record_json(r) {
  try {
    return JSON.parse((r.stdout || '').trim());
  } catch (e) {
    return null;
  }
}

// ---------- XC6：SDK 自己的 wheel 可复现 ----------
{
  const vendorWheel = path.join(repoRoot, 'vendor', 'wheels',
    'locus_capability_sdk-1.2.0-py3-none-any.whl');
  const out = tmpDir('locus-xc6-');
  try {
    const r = sdk(['build-wheel', packagesDir, 'locus-capability-sdk', '1.2.0', out,
      '--summary', 'Locus capability authoring SDK: validate projects, build deterministic '
        + 'wheels and store-only .locus packages.']);
    check('XC6 重建成功且文件名一致', r.status === 0
      && path.basename(r.doc.path) === path.basename(vendorWheel),
      JSON.stringify(r.doc).slice(0, 200) + r.stderr);
    if (r.status === 0) {
      check('XC6 重建与 vendor 提交的 wheel 逐字节相同',
        Buffer.compare(fs.readFileSync(r.doc.path), fs.readFileSync(vendorWheel)) === 0,
        'rebuilt ' + sha256Of(r.doc.path) + ' vs vendor ' + sha256Of(vendorWheel));
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

// ---------- XC7：规范描述符 plugin_from_wheel == vendorPluginManifest ----------
// D14 第 5 条：同一个 wheel 必须生成逐字节相同的 plugin.json——SDK 的
// plugin_from_wheel 与 JS 的 vendorPluginManifest（从 wheel 字节推导
// displayName / description / pythonImports）对 vendor/wheels/ 里每个
// wheel 的序列化结果必须完全一致。
{
  const entries = loadVendorEntries(repoRoot);
  check('XC7 vendor 清单非空', entries.length > 0, String(entries.length));
  for (const entry of entries) {
    const wheelPath = path.join(repoRoot, 'vendor', 'wheels', entry.filename);
    const proj = tmpDir('locus-xc7-');
    try {
      const r = sdk(['plugin-from-wheel', proj, wheelPath]);
      check('XC7 ' + entry.id + ' plugin-from-wheel 成功且 id 一致',
        r.status === 0 && r.doc && r.doc.id === entry.id,
        (r.stderr || JSON.stringify(r.doc)).slice(0, 200));
      if (r.status !== 0) continue;
      const sdkJson = fs.readFileSync(path.join(proj, 'plugins', entry.id, 'plugin.json'));
      const jsJson = Buffer.from(
        JSON.stringify(vendorPluginManifest(entry, fs.readFileSync(wheelPath)), null, 2) + '\n');
      check('XC7 ' + entry.id + ' plugin.json 逐字节相同',
        Buffer.compare(sdkJson, jsJson) === 0,
        'sdk ' + sdkJson.length + 'B vs js ' + jsJson.length + 'B');
      const artifact = fs.readFileSync(path.join(proj, 'plugins', entry.id, 'artifacts', entry.filename));
      check('XC7 ' + entry.id + ' artifacts wheel 字节与 vendor 一致',
        Buffer.compare(artifact, fs.readFileSync(wheelPath)) === 0);
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  }
}

// ---------- XC8：16 MiB wheel 上限规则（wheel-too-large）两边一致 ----------
// D14：插件 wheel 超过 16 MiB（runtime Python 镜像单文件上限）在 Locus
// 内不可见，无法打包。Python validate 与 JS checkCapabilityWheelRules
// 对 16 MiB+1 的合成 wheel 都报、恰 16 MiB 都不报。
{
  const SIZED_WHEEL_PY = `
import os, sys, zipfile
target, out = int(sys.argv[1]), sys.argv[2]
META = ("Metadata-Version: 2.1\\nName: padlarge\\nVersion: 0.0.1\\n"
        "Summary: Synthetic wheel for the 16 MiB size-limit test.\\n")
WHEEL = "Wheel-Version: 1.0\\nGenerator: test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n"
def build(pad_size):
    with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as zf:
        zf.writestr("padlarge-0.0.1.dist-info/METADATA", META)
        zf.writestr("padlarge-0.0.1.dist-info/WHEEL", WHEEL)
        zf.writestr("padlarge-0.0.1.dist-info/RECORD",
                    "padmod.py,sha256=gAIfB4OHaOJKtfRLUlnHh8SBetqzMstTCPMJEOW9uMM,7\\n"
                    "padlarge-0.0.1.dist-info/RECORD,,\\n")
        zf.writestr("padmod.py", "x = 123\\n")
        zf.writestr("pad.bin", b"\\x00" * pad_size)
pad = target
build(pad)
for _ in range(4):
    delta = os.path.getsize(out) - target
    if delta == 0:
        break
    pad -= delta
    build(pad)
assert os.path.getsize(out) == target, os.path.getsize(out)
print("ok")
`;
  const buildSizedWheel = (targetBytes, outPath) => {
    const r = spawnSync(pythonBin, ['-c', SIZED_WHEEL_PY, String(targetBytes), outPath], {
      encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error('合成 wheel 构建失败: ' + (r.stderr || r.stdout));
  };
  const writeProject = (projectDir, wheelPath) => {
    fs.mkdirSync(path.join(projectDir, 'skills', 'pad-demo'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'capability.json'), JSON.stringify({
      schemaVersion: 1,
      capability: {
        id: 'pad-demo', version: '0.1.0', displayName: 'Pad Demo',
        description: 'TEST ONLY crosscheck fixture for the 16 MiB wheel limit.',
        plugins: ['py-padlarge'], skills: ['pad-demo'], mcps: [],
      },
    }, null, 2) + '\n');
    fs.writeFileSync(path.join(projectDir, 'skills', 'pad-demo', 'skill.json'), JSON.stringify({
      schemaVersion: 1,
      skill: { id: 'pad-demo', version: '1', displayName: 'Pad demo',
        description: 'TEST ONLY crosscheck fixture skill.' },
      source: 'SKILL.md',
    }, null, 2) + '\n');
    fs.writeFileSync(path.join(projectDir, 'skills', 'pad-demo', 'SKILL.md'),
      '# Pad demo\n\nTEST ONLY. 无网络请求。\n');
    const r = sdk(['plugin-from-wheel', projectDir, wheelPath]);
    if (r.status !== 0) throw new Error('plugin-from-wheel 失败: ' + r.stderr);
  };

  const work = tmpDir('locus-xc8-');
  try {
    for (const [label, size] of [['16 MiB+1', 16 * 1024 * 1024 + 1], ['恰 16 MiB', 16 * 1024 * 1024]]) {
      const wheelPath = path.join(work, 'padlarge-' + size + '-py3-none-any.whl');
      buildSizedWheel(size, wheelPath);
      const proj = path.join(work, 'proj-' + size);
      writeProject(proj, wheelPath);
      const r = sdk(['validate', proj]);
      const pyCodes = (r.doc && Array.isArray(r.doc.diagnostics))
        ? r.doc.diagnostics.map((d) => d.code) : [];
      const pyTooLarge = pyCodes.includes('wheel-too-large');
      const jsErrors = checkCapabilityWheelRules(repoRoot, proj);
      const jsTooLarge = jsErrors.some((e) => e.includes('超过 16 MiB'));
      check('XC8 ' + label + ' Python/JS 触发一致', pyTooLarge === jsTooLarge,
        'py=' + JSON.stringify(pyCodes) + ' js=' + JSON.stringify(jsErrors));
      check('XC8 ' + label + ' Python 侧结论正确',
        label === '16 MiB+1' ? (r.status === 1 && pyTooLarge
          && r.doc.diagnostics.some((d) => d.message.includes('无法在 Locus 内打包')))
          : (r.status === 0 && pyCodes.length === 0),
        JSON.stringify(r.doc).slice(0, 300));
      fs.rmSync(proj, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

console.log('sdk-crosscheck.test: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
