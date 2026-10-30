// SW1–SW6：D14 第三方 wheel 工具（locus_capability_sdk 1.2.0，
// packages/locus_capability_sdk/_wheeltools.py + __main__.py 的新子命令）。
// 全部离线：wheel 取自 vendor/wheels/（sha256 以 vendor/wheels.json 已
// 核对的值为准），发布方元数据用 tests/fixtures/wheel-meta/ 的手工最小
// 夹具（PyPI 版本 JSON 与 pyodide-lock.json 各一份）。
//
//   SW1  wheel-info：python-docx 的要点字段与 vendor 已核对值一致
//   SW2  verify-wheel：PyPI 正确 / 篡改 1 字节 / 文件名不在元数据 /
//        pyodide-lock 正确 / lock 版本不是 0.26.4 / 元数据格式不认识
//   SW3  plugin-from-wheel：四个 wheel 的 id / imports / 描述符内容；
//        同一 wheel 两次生成字节相同；同 id 不同 wheel 被拒（D14 §5）
//   SW4  test_site：解压后可 import typing_extensions 与 et_xmlfile；
//        第二次调用跳过；拒绝 /tmp/x、/home/locus/x、/mnt/download/x
//   SW5  wheel-too-large：16 MiB+1 的合成 wheel 触发（validate 诊断 +
//        build 拒绝且不出文件），恰 16 MiB 不触发
//   SW6  CLI 子命令的用法错误退出码（2 = usage / fatal，与现有约定一致）
//   SW7  test_site 挂载点检查先规范化：/opt/../tmp/x、
//        /opt/./../home/locus/x、//tmp/x 三种绕过写法被拒
//   SW8  test_site 的 site 规范化等价：/opt/locus-site/ 与
//        /opt/locus-site 同一 site（第二次调用跳过、sys.path 只出现一次）
//
// 运行：node tests/sdk-thirdparty.test.mjs（npm test 会依次跑全部）。
// 需要 CPython >= 3.12 在 PATH 上（或 PYTHON 环境变量指定）。

import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = path.join(repoRoot, 'packages');
const fixturesDir = path.join(repoRoot, 'tests', 'fixtures');
const wheelMetaDir = path.join(fixturesDir, 'wheel-meta');
const pythonBin = process.env.PYTHON || 'python';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + String(detail) : '')); }
}

const WHEELS = {
  typing: path.join(repoRoot, 'vendor', 'wheels', 'typing_extensions-4.16.0-py3-none-any.whl'),
  etXmlfile: path.join(repoRoot, 'vendor', 'wheels', 'et_xmlfile-2.0.0-py3-none-any.whl'),
  docx: path.join(repoRoot, 'vendor', 'wheels', 'python_docx-1.2.0-py3-none-any.whl'),
  lxml: path.join(repoRoot, 'vendor', 'wheels', 'lxml-5.2.1-cp312-cp312-pyodide_2024_0_wasm32.whl'),
};
const SHA = {
  typing: '481caa481374e813c1b176ada14e97f1f67a4539ce9cfeb3f350d78d6370c2e8',
  etXmlfile: '7a91720bc756843502c3b7504c77b8fe44217c85c537d85037f0f536151b2caa',
  docx: '3fd478f3250fbbbfd3b94fe1e985955737c145627498896a8a6bf81f4baf66c7',
  lxml: '162c1a8c58fa7da34c2c492b7a572f8d604318d9708f6cd8c3968bfa5fe8a08b',
};

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function rmRf(dir) {
  // win32 下句柄未释放时 rmSync 可能 EPERM——稍候重试一次，再失败降级为警告
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch (e2) { console.log('WARN cleanup failed for ' + dir + ': ' + e2.message); }
  }
}
const sha256Of = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// SDK 调用器（CLI，JSON 输出）——与 sdk-crosscheck.test.mjs 相同的约定。
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
    doc = null;
  }
  return { status: r.status, doc, stdout, stderr: (r.stderr || '').trim() };
}

// ---------- SW1 wheel-info ----------
{
  const r = sdk(['wheel-info', WHEELS.docx]);
  check('SW1 wheel-info 成功', r.status === 0 && r.doc !== null, r.stderr || r.stdout.slice(0, 200));
  if (r.doc) {
    const d = r.doc;
    check('SW1 filename/name/version 一致',
      d.filename === 'python_docx-1.2.0-py3-none-any.whl'
      && d.name === 'python-docx' && d.normalized === 'python-docx'
      && d.version === '1.2.0', JSON.stringify(d).slice(0, 200));
    check('SW1 summary 来自 METADATA',
      d.summary === 'Create, read, and update Microsoft Word .docx files.', JSON.stringify(d.summary));
    check('SW1 tags/pure/platform_ok 一致',
      d.tags.python === 'py3' && d.tags.abi === 'none' && d.tags.platform === 'any'
      && d.pure === true && d.platform_ok === true, JSON.stringify(d));
    check('SW1 requires 是原始 Requires-Dist',
      JSON.stringify(d.requires) === JSON.stringify(['lxml>=3.1.0', 'typing_extensions>=4.9.0']),
      JSON.stringify(d.requires));
    check('SW1 imports 由 RECORD 推导', JSON.stringify(d.imports) === JSON.stringify(['docx']),
      JSON.stringify(d.imports));
    check('SW1 bytes/sha256 与 vendor 已核对值一致',
      d.bytes === fs.statSync(WHEELS.docx).size && d.sha256 === SHA.docx,
      d.sha256 + ' vs ' + SHA.docx);
  }
}

// ---------- SW2 verify-wheel ----------
{
  const wordMeta = path.join(wheelMetaDir, 'pypi-word.json');
  const typingMeta = path.join(wheelMetaDir, 'pypi-typing.json');
  const lockMeta = path.join(wheelMetaDir, 'pyodide-lock-0.26.4-min.json');

  // PyPI 正确。
  const okPypi = sdk(['verify-wheel', WHEELS.docx, wordMeta]);
  check('SW2 PyPI 正确核对通过', okPypi.status === 0 && okPypi.doc.ok === true
    && okPypi.doc.source === 'pypi' && okPypi.doc.expected === SHA.docx
    && okPypi.doc.actual === SHA.docx && okPypi.doc.diagnostics.length === 0,
    JSON.stringify(okPypi.doc));

  // 篡改 1 字节 → sha256-mismatch。
  const tampered = path.join(tmpDir('locus-sw2-'), 'python_docx-1.2.0-py3-none-any.whl');
  const bytes = Buffer.from(fs.readFileSync(WHEELS.docx));
  bytes[bytes.length - 1] ^= 0xff;
  fs.writeFileSync(tampered, bytes);
  const badPypi = sdk(['verify-wheel', tampered, wordMeta]);
  check('SW2 篡改 1 字节报 sha256-mismatch', badPypi.status === 1 && badPypi.doc.ok === false
    && badPypi.doc.source === 'pypi' && badPypi.doc.diagnostics.some((d) => d.code === 'sha256-mismatch'),
    JSON.stringify(badPypi.doc));

  // 文件名不在元数据 → entry-not-found。
  const notFound = sdk(['verify-wheel', WHEELS.etXmlfile, wordMeta]);
  check('SW2 文件名不在元数据报 entry-not-found', notFound.status === 1 && notFound.doc.ok === false
    && notFound.doc.source === 'pypi'
    && notFound.doc.diagnostics.some((d) => d.code === 'entry-not-found'),
    JSON.stringify(notFound.doc));

  // pyodide-lock 正确。
  const okLock = sdk(['verify-wheel', WHEELS.lxml, lockMeta]);
  check('SW2 pyodide-lock 正确核对通过', okLock.status === 0 && okLock.doc.ok === true
    && okLock.doc.source === 'pyodide-lock' && okLock.doc.expected === SHA.lxml
    && okLock.doc.actual === SHA.lxml && okLock.doc.diagnostics.length === 0,
    JSON.stringify(okLock.doc));

  // lock 版本不是 0.26.4 → lock-version-unsupported。
  const wrongLockDir = tmpDir('locus-sw2b-');
  const wrongLock = path.join(wrongLockDir, 'pyodide-lock-0.27.0-min.json');
  const lockDoc = JSON.parse(fs.readFileSync(lockMeta, 'utf8'));
  lockDoc.info.version = '0.27.0';
  fs.writeFileSync(wrongLock, JSON.stringify(lockDoc, null, 2) + '\n');
  const badLock = sdk(['verify-wheel', WHEELS.lxml, wrongLock]);
  check('SW2 lock 版本 0.27.0 报 lock-version-unsupported', badLock.status === 1
    && badLock.doc.ok === false && badLock.doc.source === 'pyodide-lock'
    && badLock.doc.diagnostics.some((d) => d.code === 'lock-version-unsupported'),
    JSON.stringify(badLock.doc));
  rmRf(wrongLockDir);

  // 元数据格式不认识 → unknown-format。
  const unknown = path.join(tmpDir('locus-sw2c-'), 'not-metadata.json');
  fs.writeFileSync(unknown, '{"hello": "world"}\n');
  const badFormat = sdk(['verify-wheel', WHEELS.typing, unknown]);
  check('SW2 格式不认识报 unknown-format', badFormat.status === 1 && badFormat.doc.ok === false
    && badFormat.doc.source === null
    && badFormat.doc.diagnostics.some((d) => d.code === 'unknown-format'),
    JSON.stringify(badFormat.doc));
  rmRf(path.dirname(unknown));
  rmRf(path.dirname(tampered));
}

// ---------- SW3 plugin-from-wheel ----------
{
  const cases = [
    [WHEELS.typing, 'py-typing-extensions', 'typing_extensions', '4.16.0', ['typing_extensions'],
      'Backported and Experimental Type Hints for Python 3.9+'],
    [WHEELS.etXmlfile, 'py-et-xmlfile', 'et_xmlfile', '2.0.0', ['et_xmlfile'],
      'An implementation of lxml.xmlfile for the standard library'],
    [WHEELS.docx, 'py-python-docx', 'python-docx', '1.2.0', ['docx'],
      'Create, read, and update Microsoft Word .docx files.'],
    [WHEELS.lxml, 'py-lxml', 'lxml', '5.2.1', ['lxml'],
      'Powerful and Pythonic XML processing library combining libxml2/libxslt with the ElementTree API.'],
  ];
  for (const [wheel, pid, display, version, imports, description] of cases) {
    const proj = tmpDir('locus-sw3-');
    try {
      const r = sdk(['plugin-from-wheel', proj, wheel]);
      check('SW3 ' + pid + ' plugin-from-wheel 成功', r.status === 0 && r.doc && r.doc.id === pid,
        r.stderr || r.stdout.slice(0, 200));
      if (!r.doc) continue;
      const p = r.doc.descriptor.plugin;
      const a = r.doc.descriptor.artifacts;
      check('SW3 ' + pid + ' 描述符内容符合规范',
        p.version === version && p.displayName === display && p.description === description
        && p.runtime === 'python' && p.authority === 'none'
        && JSON.stringify(p.provides.pythonImports) === JSON.stringify(imports)
        && a.length === 1 && a[0].path === 'artifacts/' + path.basename(wheel)
        && a[0].format === 'python-wheel'
        && r.doc.descriptor.schemaVersion === 1,
        JSON.stringify(r.doc.descriptor));
      const manifestFile = path.join(proj, 'plugins', pid, 'plugin.json');
      const artifactFile = path.join(proj, 'plugins', pid, 'artifacts', path.basename(wheel));
      check('SW3 ' + pid + ' 文件落位且 wheel 字节一致',
        fs.existsSync(manifestFile) && r.doc.path === manifestFile
        && fs.existsSync(artifactFile)
        && Buffer.compare(fs.readFileSync(artifactFile), fs.readFileSync(wheel)) === 0);

      // 同一 wheel 第二次生成：字节不变。
      const first = fs.readFileSync(manifestFile);
      const r2 = sdk(['plugin-from-wheel', proj, wheel]);
      const second = fs.readFileSync(manifestFile);
      check('SW3 ' + pid + ' 两次生成字节相同', r2.status === 0 && Buffer.compare(first, second) === 0,
        r2.stderr);
      check('SW3 ' + pid + ' plugin.json 序列化 = 2 空格缩进 + 结尾换行',
        second.toString('utf8').endsWith('}\n') && second.toString('utf8').includes('\n  "plugin"'));

      // 同 id 但字节不同的 wheel → 拒绝（D14 §5）。用 SDK 自己 build 一个
      // et-xmlfile 2.0.1（同 id py-et-xmlfile），只有 et_xmlfile 案例验证。
      if (pid === 'py-et-xmlfile') {
        const src = tmpDir('locus-sw3src-');
        fs.mkdirSync(path.join(src, 'et_xmlfile'));
        fs.writeFileSync(path.join(src, 'et_xmlfile', '__init__.py'), 'x = 1\n');
        const out = tmpDir('locus-sw3out-');
        const b = sdk(['build-wheel', src, 'et-xmlfile', '2.0.1', out, '--summary', 'SW3 clash wheel.']);
        const clash = path.join(out, 'et_xmlfile-2.0.1-py3-none-any.whl');
        const rejected = sdk(['plugin-from-wheel', proj, clash]);
        check('SW3 同 id 不同 wheel 被拒绝', rejected.status === 2
          && rejected.stderr.includes('py-et-xmlfile') && rejected.stderr.includes('不同的 wheel'),
          rejected.status + ' ' + rejected.stderr.slice(0, 200));
        rmRf(src); rmRf(out);
      }
    } finally {
      rmRf(proj);
    }
  }
}

// ---------- SW4 test_site ----------
{
  // 挂载点拒绝（词法检查，Windows 上同样成立）。
  for (const site of ['/tmp/x', '/home/locus/x', '/mnt/download/x']) {
    const r = spawnSync(pythonBin, ['-c', `
import sys
from locus_capability_sdk import SdkError, test_site
try:
    test_site(sys.argv[1:], site=sys.argv[-1])
except SdkError as e:
    print("SdkError")
    sys.exit(0)
sys.exit(3)
`, WHEELS.typing, site], { encoding: 'utf8', env: { ...process.env, PYTHONPATH: packagesDir } });
    check('SW4 拒绝挂载点 ' + site, r.status === 0 && r.stdout.trim() === 'SdkError',
      r.status + ' ' + r.stdout + r.stderr);
  }

  // 解压 + import + 第二次跳过（测试用 allow_unsafe_site_for_tests 绕过
  // 挂载点检查——普通 CPython 上没有 /opt/locus-site 可用）。
  const site = tmpDir('locus-sw4-site-');
  const py = `
import json, sys
from locus_capability_sdk import test_site
r1 = test_site(sys.argv[1:3], site=sys.argv[3], allow_unsafe_site_for_tests=True)
import typing_extensions
import et_xmlfile
ok_import = typing_extensions.__name__ == "typing_extensions" and et_xmlfile.__name__ == "et_xmlfile"
r2 = test_site(sys.argv[1:3], site=sys.argv[3], allow_unsafe_site_for_tests=True)
import os
markers = os.listdir(os.path.join(sys.argv[3], ".locus-installed"))
print(json.dumps({
    "installed1": r1["installed"], "skipped1": r1["skipped"],
    "installed2": r2["installed"], "skipped2": r2["skipped"],
    "ok_import": ok_import, "markers": sorted(markers),
    # test_site 插入的是规范化后的 site，与返回值一致（SW8）。
    "site_at_front": sys.path[0] == r1["site"],
}))
`;
  const r = spawnSync(pythonBin, ['-c', py, WHEELS.typing, WHEELS.etXmlfile, site], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: packagesDir },
  });
  let doc = null;
  try { doc = JSON.parse(r.stdout.trim()); } catch (e) { doc = null; }
  check('SW4 解压后可 import 且 site 在 sys.path 最前', r.status === 0 && doc !== null
    && doc.ok_import === true && doc.site_at_front === true,
    r.status + ' ' + r.stdout.slice(0, 200) + ' ' + r.stderr.slice(0, 300));
  check('SW4 第一次 installed / skipped 正确',
    doc !== null && JSON.stringify(doc.installed1) === JSON.stringify(['typing_extensions-4.16.0-py3-none-any.whl', 'et_xmlfile-2.0.0-py3-none-any.whl'])
    && doc.skipped1.length === 0
    && doc.markers.length === 2 && doc.markers.every((m) => /^[0-9a-f]{64}$/.test(m)),
    JSON.stringify(doc));
  check('SW4 第二次全部跳过', doc !== null
    && doc.installed2.length === 0
    && JSON.stringify(doc.skipped2) === JSON.stringify(['typing_extensions-4.16.0-py3-none-any.whl', 'et_xmlfile-2.0.0-py3-none-any.whl']),
    JSON.stringify(doc));
  rmRf(site);

  // ---------- SW7 挂载点检查先规范化，绕过写法无效 ----------
  for (const site of ['/opt/../tmp/x', '/opt/./../home/locus/x', '//tmp/x']) {
    const r = spawnSync(pythonBin, ['-c', `
import sys
from locus_capability_sdk import SdkError, test_site
try:
    test_site(sys.argv[1:], site=sys.argv[-1])
except SdkError as e:
    print("SdkError")
    sys.exit(0)
sys.exit(3)
`, WHEELS.typing, site], { encoding: 'utf8', env: { ...process.env, PYTHONPATH: packagesDir } });
    check('SW7 绕过写法被拒 ' + site, r.status === 0 && r.stdout.trim() === 'SdkError',
      r.status + ' ' + r.stdout + r.stderr);
  }

  // ---------- SW8 尾斜杠与裸 site 等价（规范化后的值统一） ----------
  {
    const siteBase = tmpDir('locus-sw8-site-');
    const py = `
import json, sys
from locus_capability_sdk import test_site
base = sys.argv[1]
r1 = test_site(sys.argv[2:4], site=base + "/", allow_unsafe_site_for_tests=True)
import typing_extensions
import et_xmlfile
r2 = test_site(sys.argv[2:4], site=base, allow_unsafe_site_for_tests=True)
print(json.dumps({
    "site1": r1["site"], "site2": r2["site"], "same": r1["site"] == r2["site"],
    "no_trailing_slash": not r1["site"].endswith("/"),
    "installed1": r1["installed"], "skipped2": r2["skipped"],
    "path_hits": sum(1 for p in sys.path if p == r1["site"]),
}))
`;
    const r = spawnSync(pythonBin, ['-c', py, siteBase, WHEELS.typing, WHEELS.etXmlfile], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONPATH: packagesDir },
    });
    let doc = null;
    try { doc = JSON.parse(r.stdout.trim()); } catch (e) { doc = null; }
    check('SW8 尾斜杠与裸 site 规范化为同一值', r.status === 0 && doc !== null
      && doc.same === true && doc.no_trailing_slash === true,
      r.status + ' ' + r.stdout.slice(0, 200) + ' ' + r.stderr.slice(0, 300));
    check('SW8 第二次调用全部跳过（同一 site）', doc !== null
      && JSON.stringify(doc.installed1) === JSON.stringify(['typing_extensions-4.16.0-py3-none-any.whl', 'et_xmlfile-2.0.0-py3-none-any.whl'])
      && JSON.stringify(doc.skipped2) === JSON.stringify(['typing_extensions-4.16.0-py3-none-any.whl', 'et_xmlfile-2.0.0-py3-none-any.whl']),
      JSON.stringify(doc));
    check('SW8 sys.path 中只出现一次', doc !== null && doc.path_hits === 1, JSON.stringify(doc));
    rmRf(siteBase);
  }
}

// ---------- SW5 wheel-too-large ----------
// 合成 wheel：合法 zip（STORED），METADATA/WHEEL/RECORD 齐全，总大小精确
// 等于目标字节数（pad 二调到准确值）。
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
function buildSizedWheel(targetBytes, outPath) {
  const r = spawnSync(pythonBin, ['-c', SIZED_WHEEL_PY, String(targetBytes), outPath], {
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error('合成 wheel 构建失败: ' + (r.stderr || r.stdout));
  return outPath;
}

function writePluginProject(projectDir, wheelPath) {
  fs.mkdirSync(path.join(projectDir, 'skills', 'pad-demo'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'capability.json'), JSON.stringify({
    schemaVersion: 1,
    capability: {
      id: 'pad-demo', version: '0.1.0', displayName: 'Pad Demo',
      description: 'TEST ONLY fixture for the 16 MiB wheel limit.',
      plugins: ['py-padlarge'], skills: ['pad-demo'], mcps: [],
    },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(projectDir, 'locus.json'), JSON.stringify({
    title: 'Pad Demo', author: 'locus-owner',
    purpose: 'TEST ONLY fixture for the 16 MiB wheel limit.',
    changelog: ['0.1.0（2026-10-31）：test fixture'],
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(projectDir, 'skills', 'pad-demo', 'skill.json'), JSON.stringify({
    schemaVersion: 1,
    skill: { id: 'pad-demo', version: '1', displayName: 'Pad demo',
      description: 'TEST ONLY fixture skill.' },
    source: 'SKILL.md',
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(projectDir, 'skills', 'pad-demo', 'SKILL.md'),
    '# Pad demo\n\nTEST ONLY. 无网络请求。\n');
  const r = sdk(['plugin-from-wheel', projectDir, wheelPath]);
  if (r.status !== 0) throw new Error('plugin-from-wheel 失败: ' + r.stderr);
}

{
  const oversizeDir = tmpDir('locus-sw5-');
  const exactDir = tmpDir('locus-sw5b-');
  const outDir = tmpDir('locus-sw5out-');
  try {
    const oversizeWheel = buildSizedWheel(16 * 1024 * 1024 + 1, path.join(oversizeDir, 'padlarge-0.0.1-py3-none-any.whl'));
    const exactWheel = buildSizedWheel(16 * 1024 * 1024, path.join(exactDir, 'padlarge-0.0.1-py3-none-any.whl'));

    const projA = tmpDir('locus-sw5pa-');
    writePluginProject(projA, oversizeWheel);
    const vA = sdk(['validate', projA]);
    check('SW5 16 MiB+1 触发 wheel-too-large', vA.status === 1
      && vA.doc.diagnostics.some((d) => d.code === 'wheel-too-large'
        && d.message.includes('16 MiB') && d.message.includes('无法在 Locus 内打包')),
      JSON.stringify(vA.doc).slice(0, 400));
    const bA = sdk(['build', projA, outDir]);
    check('SW5 16 MiB+1 build 拒绝且不出文件', bA.status === 1 && bA.doc.ok === false
      && bA.doc.diagnostics.some((d) => d.code === 'wheel-too-large')
      && fs.readdirSync(outDir).length === 0,
      JSON.stringify(bA.doc).slice(0, 300));

    const projB = tmpDir('locus-sw5pb-');
    writePluginProject(projB, exactWheel);
    const vB = sdk(['validate', projB]);
    check('SW5 恰 16 MiB 不触发（validate 通过）', vB.status === 0
      && vB.doc.diagnostics.length === 0
      && !vB.doc.diagnostics.some((d) => d.code.startsWith('wheel-')),
      JSON.stringify(vB.doc).slice(0, 400));

    // JS 侧与 Python 侧的规则对照在 sdk-crosscheck.test.mjs XC8。
  } finally {
    rmRf(oversizeDir); rmRf(exactDir); rmRf(outDir);
    for (const d of fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('locus-sw5p'))) {
      rmRf(path.join(os.tmpdir(), d));
    }
  }
}

// ---------- SW6 CLI 用法错误 ----------
{
  const wi = sdk(['wheel-info']);
  check('SW6 wheel-info 缺参数退出 2', wi.status === 2 && wi.stderr.includes('usage'), wi.stderr);
  const vw = sdk(['verify-wheel', WHEELS.typing]);
  check('SW6 verify-wheel 缺参数退出 2', vw.status === 2 && vw.stderr.includes('usage'), vw.stderr);
  const pf = sdk(['plugin-from-wheel', tmpDir('locus-sw6-')]);
  check('SW6 plugin-from-wheel 缺参数退出 2', pf.status === 2 && pf.stderr.includes('usage'), pf.stderr);
  const missing = sdk(['wheel-info', path.join(os.tmpdir(), 'locus-no-such-wheel.whl')]);
  check('SW6 wheel-info 文件不存在退出 2', missing.status === 2 && missing.stderr.includes('error'),
    missing.stderr);
}

console.log('sdk-thirdparty.test: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
