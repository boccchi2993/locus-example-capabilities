// charts 能力测试（CH1–CH2）：
//   CH1  构建 dist/charts-1.0.0.locus、两次构建字节相同、inspect 通过
//        （ok / kind 'new' / mismatched 空、恰好 1 个 skill "charts"、0 个 plugin）、
//        skill 规范检查通过。
//   CH2  提取 SKILL.md 中全部 ```python 代码块，按顺序拼接后用 CPython 3
//        （python3 -I，独立临时目录；把代码中的 OUT_DIR="/mnt/download" 一行
//        重映射为临时 download 目录）运行。要求：
//          - 生成 ≥4 个 SVG，demo-line/bar/pie/scatter.svg 四种图各一个；
//          - 每个 SVG 都能被 xml.etree.ElementTree 解析，根元素是 svg 且有 viewBox；
//          - 用含 <、&、中文的标题再生成一次，解析仍成功且原文出现在 SVG 文本中
//            （转义正确，原始字节里是 &lt;/&amp; 实体）；
//          - 除 pandas 例外（当前 Python 没有 pandas 时该代码块单独跳过并在
//            测试输出里写明原因），不导入标准库以外的模块。
//        生成的 SVG 与拼接脚本复制到 artifacts/charts/ 供 CI 上传为测试产物。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createCapabilityPackages } from 'locus-browser-agent-runtime/src/capability-packages.js';

import { buildCapability, capabilitiesDir, distDir } from '../scripts/build.mjs';
import { checkSkillSpecs } from '../scripts/skill-spec.mjs';

const CAPABILITY_ID = 'charts';
const capabilityDir = path.join(capabilitiesDir, CAPABILITY_ID);
const skillMdPath = path.join(capabilityDir, 'skills', CAPABILITY_ID, 'SKILL.md');
const distPath = path.join(distDir, CAPABILITY_ID + '-1.0.0.locus');
const repoRoot = path.dirname(capabilitiesDir);
const artifactsDir = path.join(repoRoot, 'artifacts', 'charts');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}
const bytesEqual = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

// --- CH1：构建 + inspect + skill 规范 ---
const first = await buildCapability(capabilityDir);
const second = await buildCapability(capabilityDir);
check('CH1: build id/version are charts@1.0.0',
  first.id === CAPABILITY_ID && first.version === '1.0.0',
  first.id + '@' + first.version);
check('CH1: two in-process builds are byte-identical', bytesEqual(first.bytes, second.bytes));
const b1 = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'build.mjs'), CAPABILITY_ID],
  { cwd: repoRoot, encoding: 'utf8' });
check('CH1: build script exits 0', b1.status === 0, (b1.stderr || '').slice(0, 400));
check('CH1: dist/charts-1.0.0.locus exists', fs.existsSync(distPath));
const dist1 = fs.readFileSync(distPath);
check('CH1: script artifact matches in-process build', bytesEqual(dist1, first.bytes));
const b2 = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'build.mjs'), CAPABILITY_ID],
  { cwd: repoRoot, encoding: 'utf8' });
check('CH1: two script builds are byte-identical',
  b2.status === 0 && bytesEqual(dist1, fs.readFileSync(distPath)));

const service = createCapabilityPackages({
  persistence: { loadCapabilityPackages: async () => [] },
  manager: {}, // inspect() 只要求 manager 为真值，不读其状态
  now: () => '1970-01-01T00:00:00.000Z',
});
const summary = await service.inspect(first.bytes);
check('CH1: inspect ok', summary.ok === true, JSON.stringify(summary.diagnostics || null));
check('CH1: inspect kind is new', summary.ok && summary.kind === 'new', String(summary.kind));
check('CH1: inspect mismatched is empty',
  summary.ok && summary.mismatched.length === 0, JSON.stringify(summary.mismatched));
check('CH1: exactly 1 skill "charts" and 0 plugins',
  summary.ok && summary.components.skills.length === 1
    && summary.components.skills[0].id === 'charts'
    && summary.components.plugins.length === 0,
  JSON.stringify(summary.components));
check('CH1: no skill spec violations',
  checkSkillSpecs(capabilityDir).length === 0, JSON.stringify(checkSkillSpecs(capabilityDir)));

// --- CH2：提取并运行 SKILL.md 的 python 代码块 ---
const md = fs.readFileSync(skillMdPath, 'utf8').replace(/\r\n/g, '\n');
const blocks = [];
{
  const re = /^```python\n([\s\S]*?)^```/gm;
  let m;
  while ((m = re.exec(md)) !== null) blocks.push(m[1]);
}
check('CH2: SKILL.md has >= 3 python blocks', blocks.length >= 3, String(blocks.length));

function findPython() {
  const candidates = process.env.PYTHON ? [process.env.PYTHON, 'python3', 'python']
    : ['python3', 'python'];
  for (const cmd of candidates) {
    const r = spawnSync(cmd, ['-I', '--version'], { encoding: 'utf8' });
    const out = ((r.stdout || '') + (r.stderr || '')).trim();
    if (r.status === 0 && /Python\s3\.\d+/.test(out)) return { cmd, version: out };
  }
  return null;
}
const py = findPython();
check('CH2: python 3 available for block execution', py !== null,
  '需要 CPython 3（CI 用 actions/setup-python 3.12）');
if (py) console.log('CH2: python = ' + py.version + ' (' + py.cmd + ')');

// 顶层 import / from X import 扫描：只允许标准库；pandas 仅限 pandas 代码块
function importsOf(code) {
  const names = new Set();
  for (const raw of code.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const from = line.match(/^from\s+([A-Za-z_][\w.]*)/);
    if (from) { names.add(from[1].split('.')[0]); continue; }
    const imp = line.match(/^import\s+(.+?)(\s+#|$)/);
    if (imp) {
      for (const part of imp[1].split(',')) {
        const pm = part.trim().match(/^([A-Za-z_][\w.]*)/);
        if (pm) names.add(pm[1].split('.')[0]);
      }
    }
  }
  return names;
}

let stdlib = new Set();
let pandasOk = false;
if (py) {
  const r = spawnSync(py.cmd, ['-I', '-c',
    'import sys; print(chr(10).join(sys.stdlib_module_names))'], { encoding: 'utf8' });
  stdlib = new Set((r.stdout || '').trim().split(/\r?\n/));
  pandasOk = spawnSync(py.cmd, ['-I', '-c', 'import pandas'], { encoding: 'utf8' }).status === 0;
}

const runnable = [];
let pandasSkipped = 0;
for (let i = 0; i < blocks.length; i++) {
  const mods = [...importsOf(blocks[i])];
  const hasPandas = /^\s*(?:import\s+pandas|from\s+pandas)\b/m.test(blocks[i]);
  const bad = mods.filter((m) => !stdlib.has(m) && !(m === 'pandas' && hasPandas));
  check('CH2: python block ' + (i + 1) + ' imports only allowed modules',
    bad.length === 0, JSON.stringify({ imports: mods, unexpected: bad }));
  if (hasPandas && !pandasOk) {
    pandasSkipped++;
    console.log('SKIP CH2: python block ' + (i + 1)
      + ' 跳过 —— 该代码块演示 pandas 读取 DataFrame，当前 Python 环境没有 pandas'
      + '（CI 的 setup-python 3.12 不装 pandas）；其余代码块照常运行');
    continue;
  }
  runnable.push(blocks[i]);
}
check('CH2: pandas demo handled (run or explicit skip)', pandasSkipped <= 1,
  String(pandasSkipped));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'charts-test-'));
const outDir = path.join(tmp, 'download');
fs.mkdirSync(outDir, { recursive: true });

let script = null;
if (py) {
  script = runnable.join('\n\n# ---- next SKILL.md python block ----\n\n');
  const original = 'OUT_DIR = "/mnt/download"';
  const hits = script.split(original).length - 1;
  check('CH2: OUT_DIR constant appears exactly once for remapping', hits === 1, String(hits));
  script = script.replace(original, 'OUT_DIR = ' + JSON.stringify(outDir.replaceAll('\\', '/')));
  const scriptPath = path.join(tmp, 'skill-blocks.py');
  fs.writeFileSync(scriptPath, script, 'utf8');
  const run = spawnSync(py.cmd, ['-I', scriptPath], {
    cwd: tmp, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });
  check('CH2: concatenated python blocks exit 0', run.status === 0,
    (run.stderr || '').slice(-800) || 'status ' + run.status);
  check('CH2: helpers reported saved files', /saved .+demo-line\.svg/.test(run.stdout || ''), '');

  // ElementTree 验证（在 Python 里做，Node 侧不解析 XML）
  const verifier = `
import glob
import os
import sys
import xml.etree.ElementTree as ET

out_dir = sys.argv[1]
paths = sorted(glob.glob(os.path.join(out_dir, "*.svg")))
names = {os.path.basename(p) for p in paths}
print("COUNT", len(paths))
required = ["demo-bar.svg", "demo-line.svg", "demo-pie.svg", "demo-scatter.svg"]
print("MISSING", " ".join(n for n in required if n not in names))
bad = []
for p in paths:
    try:
        root = ET.parse(p).getroot()
    except Exception as e:
        bad.append(os.path.basename(p) + " parse:" + str(e))
        continue
    if root.tag.rsplit("}", 1)[-1] != "svg":
        bad.append(os.path.basename(p) + " root:" + root.tag)
    if not root.get("viewBox"):
        bad.append(os.path.basename(p) + " noviewbox")
print("BAD", ";".join(bad))

esc_path = os.path.join(out_dir, "demo-escaping.svg")
title = "营收 <草稿> & 修正 · 2026"
texts = [el.text for el in ET.parse(esc_path).iter() if el.text]
print("TITLE_FOUND", title in " ".join(texts))
raw = open(esc_path, encoding="utf-8").read()
print("RAW_ESCAPED", ("&lt;" in raw) and ("&amp;" in raw) and ("<草稿>" not in raw))
pie = open(os.path.join(out_dir, "demo-pie.svg"), encoding="utf-8").read()
print("PIE_PCT", "%" in pie)
`;
  const verifyPath = path.join(tmp, 'verify.py');
  fs.writeFileSync(verifyPath, verifier, 'utf8');
  const vr = spawnSync(py.cmd, ['-I', verifyPath, outDir], {
    cwd: tmp, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });
  check('CH2: svg verifier exits 0', vr.status === 0, (vr.stderr || '').slice(-400));
  const out = {};
  for (const line of (vr.stdout || '').split('\n')) {
    const i = line.indexOf(' ');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  check('CH2: generated >= 4 SVGs', Number(out.COUNT) >= 4, out.COUNT);
  check('CH2: line/bar/pie/scatter each generated', out.MISSING === '', out.MISSING);
  check('CH2: every SVG parses, root svg with viewBox', out.BAD === '', out.BAD);
  check('CH2: special-char title text present unescaped in SVG text', out.TITLE_FOUND === 'True',
    out.TITLE_FOUND);
  check('CH2: special chars stored as XML entities in raw SVG', out.RAW_ESCAPED === 'True',
    out.RAW_ESCAPED);
  check('CH2: pie chart carries percent labels', out.PIE_PCT === 'True', out.PIE_PCT);

  // 测试产物：生成的 SVG + 拼接脚本，供 CI 上传（gitignore 掉 artifacts/）。
  // Windows 上目录可能被杀掉的服务/查看器短暂占用（delete-pending），rm 重试后
  // 仍失败则直接覆盖写入——文件名集合固定，覆盖等价于清理。
  for (let i = 0; ; i++) {
    try {
      fs.rmSync(artifactsDir, { recursive: true, force: true });
      break;
    } catch (e) {
      if (i === 4) {
        console.log('NOTE CH2: artifacts/charts 清理被占用（' + e.code + '），改为覆盖写入');
        break;
      }
      spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 200)']);
    }
  }
  fs.mkdirSync(artifactsDir, { recursive: true });
  for (const f of fs.readdirSync(outDir)) {
    fs.copyFileSync(path.join(outDir, f), path.join(artifactsDir, f));
  }
  fs.copyFileSync(scriptPath, path.join(artifactsDir, 'skill-blocks.py'));
}

console.log('charts.test: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
