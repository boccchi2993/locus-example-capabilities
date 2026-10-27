// VC1–VC4：vendor batch 2（excel / pdf / word / pptx / image 能力组）的
// 依赖闭包夹具测试。夹具在 tests/fixtures/closure-*/（只声明 plugins，
// 不加真实能力）；wheel 全部来自 vendor batch 2（vendor/wheels.json）。
//
//   VC1  每个夹具：D13 wheel 规则（依赖顺序 / 平台标签 / 预装遮盖）通过；
//        构建成功且两次构建字节相同；product 的 inspect() 通过（ok /
//        kind new / mismatched 空）；components.plugins 恰为声明的 plugin
//        集合，且包内 capability.json 保留声明（依赖）顺序——runtime 的
//        buildProject 会把 lock.plugins 按 id 排序（capability-package.js
//        的 normalizedPlugins），components.plugins 是排序后的产物，声明
//        顺序在包里的载体是 capability.json（依赖顺序本身由检查 5 把关）。
//   VC2  闭包完整性：对每个夹具，从各 wheel 的 METADATA Requires-Dist
//        （无 extra、环境标记按 Pyodide worker 求值、排除 runtime 预装包）
//        计算出的依赖闭包（含自身）恰好等于它的 plugins 集合，不多不少。
//   VC3  共享：closure-word 与 closure-pptx 都能 registerPackage（真实
//        harness CapabilityManager，同 VW7 的 serviceRig），两个能力共享
//        同一个 py-lxml、py-typing-extensions 组件（各只注册一次）；卸载
//        closure-word 后 py-lxml / py-typing-extensions 仍注册。
//   VC4  体积：打印每个夹具的 .locus 大小，并断言小于 product 的
//        LOCUS_LIMITS.maxTotalBytes。
//
// 运行：node tests/vendor-closures.test.mjs（npm test 会依次跑全部
// *.test.mjs）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// persistence 的存储模式探测需要 window.location（同 vendor-plugins.test.mjs
// 的模块级替身）。
if (typeof globalThis.window === 'undefined') {
  globalThis.window = { location: { protocol: 'https:' } };
}

const LA = await import('locus-browser-agent-runtime/src/locus-archive.js');
const svcMod = await import('locus-browser-agent-runtime/src/capability-packages.js');
const harnessApi = await import('locus-browser-agent-runtime/src/product/harness-api.js');
const runtimeApi = await import('locus-browser-agent-runtime/src/product/runtime-api.js');
const ext = await import('locus-browser-agent-runtime/src/extensions.js');
const persistenceMod = await import('locus-browser-agent-runtime/src/persistence.js');
const credSvcMod = await import('locus-browser-agent-runtime/src/credentials.js');

import { buildCapability } from '../scripts/build.mjs';
import { loadVendorEntries, readVendorWheel } from '../scripts/vendor.mjs';
import { checkCapabilityWheelRules } from '../scripts/wheel-checks.mjs';
import {
  normalizeDistName,
  pluginIdForDist,
  RUNTIME_PREINSTALLED_PACKAGES,
  readWheelMetadata,
  wheelRequiresDist,
  evaluateMarker,
  markerReferencesExtra,
} from '../scripts/wheel-util.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = path.join(repoRoot, 'tests', 'fixtures');

// 任务第二节的声明顺序（= 将来真实能力要用的依赖顺序）。
const CLOSURES = {
  'closure-excel': ['py-et-xmlfile', 'py-openpyxl', 'py-xlsxwriter'],
  'closure-pdf': ['py-pypdf'],
  'closure-word': ['py-lxml', 'py-typing-extensions', 'py-python-docx'],
  'closure-pptx': ['py-lxml', 'py-pillow', 'py-typing-extensions', 'py-xlsxwriter', 'py-python-pptx'],
  'closure-image': ['py-pillow'],
};

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}
const bytesEqual = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

// inspect() 不读任何 manager 状态（只要求真值），与 scripts/check.mjs 的
// makeInspectService 相同。
function makeInspectService() {
  return svcMod.createCapabilityPackages({
    persistence: { loadCapabilityPackages: async () => [] },
    manager: {},
    now: () => '1970-01-01T00:00:00.000Z',
  });
}

// VC2：从 METADATA 计算一个夹具的依赖闭包。对 plugins 里每个 wheel 读
// Requires-Dist：跳过带 extra 的标记；环境标记按 Pyodide worker（Python
// 3.12 / emscripten）求值为假的跳过；runtime 预装包不算；其余依赖以
// py-<规范化包名> 计入。闭包含 plugin 自身。解析失败视为测试错误。
function metadataClosure(plugins) {
  const entries = loadVendorEntries(repoRoot);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const closure = new Set(plugins);
  for (const id of plugins) {
    const entry = byId.get(id);
    if (!entry) throw new Error(id + ': vendor/wheels.json 里没有这个 id');
    const metadata = readWheelMetadata(readVendorWheel(repoRoot, entry));
    for (const raw of wheelRequiresDist(metadata)) {
      const semi = raw.indexOf(';');
      const req = (semi >= 0 ? raw.slice(0, semi) : raw).trim();
      const m = /^[A-Za-z0-9][A-Za-z0-9._-]*/.exec(req);
      if (!m) throw new Error(id + ': 无法解析的 Requires-Dist "' + raw + '"');
      const marker = semi >= 0 ? raw.slice(semi + 1).trim() : null;
      if (marker && markerReferencesExtra(marker)) continue;
      if (marker && !evaluateMarker(marker)) continue;
      const depDist = normalizeDistName(m[0]);
      if (RUNTIME_PREINSTALLED_PACKAGES.has(depDist)) continue;
      closure.add(pluginIdForDist(depDist));
    }
  }
  return closure;
}

// ---------- VC1 构建与 inspect ----------
const builtByName = new Map();
{
  const service = makeInspectService();
  for (const [fixture, plugins] of Object.entries(CLOSURES)) {
    const dir = path.join(fixturesDir, fixture);
    const declared = JSON.parse(fs.readFileSync(path.join(dir, 'capability.json'), 'utf8')).capability.plugins;
    check('VC1 ' + fixture + ' 夹具声明与任务一致', JSON.stringify(declared) === JSON.stringify(plugins),
      JSON.stringify(declared));

    const ruleErrors = checkCapabilityWheelRules(repoRoot, dir);
    check('VC1 ' + fixture + ' wheel 规则通过（依赖顺序 / 平台标签 / 遮盖）',
      ruleErrors.length === 0, ruleErrors.join(' ; '));

    let built = null, rebuilt = null;
    try {
      built = await buildCapability(dir);
      rebuilt = await buildCapability(dir);
    } catch (e) {
      check('VC1 ' + fixture + ' 构建成功', false, e.message);
    }
    if (built) {
      builtByName.set(fixture, built);
      check('VC1 ' + fixture + ' 构建成功且两次字节相同', bytesEqual(built.bytes, rebuilt.bytes));

      const summary = await service.inspect(built.bytes);
      check('VC1 ' + fixture + ' inspect ok / kind new / mismatched 空',
        summary.ok === true && summary.kind === 'new' && summary.mismatched.length === 0,
        JSON.stringify(summary.diagnostics || null));
      const componentIds = summary.components.plugins.map((p) => p.id);
      check('VC1 ' + fixture + ' components.plugins 恰为声明的集合',
        sameSet(new Set(componentIds), new Set(plugins)) && componentIds.length === plugins.length,
        JSON.stringify(componentIds));
      check('VC1 ' + fixture + ' components.plugins 无重复', new Set(componentIds).size === componentIds.length,
        JSON.stringify(componentIds));

      // 声明（依赖）顺序的载体：包内 capability.json（见文件头说明）。
      const read = await LA.readLocusArchive(built.bytes);
      const inPackage = JSON.parse(new TextDecoder('utf-8').decode(read.files.get('capability.json')));
      check('VC1 ' + fixture + ' 包内 capability.json 保留声明顺序',
        JSON.stringify(inPackage.capability.plugins) === JSON.stringify(plugins),
        JSON.stringify(inPackage.capability.plugins));
    }
  }
}

// ---------- VC2 闭包完整性 ----------
{
  const entries = loadVendorEntries(repoRoot);
  const known = new Set(entries.map((e) => e.id));
  for (const [fixture, plugins] of Object.entries(CLOSURES)) {
    check('VC2 ' + fixture + ' plugins 全部来自 vendor 清单',
      plugins.every((id) => known.has(id)), JSON.stringify(plugins));
    const closure = metadataClosure(plugins);
    check('VC2 ' + fixture + ' METADATA 依赖闭包恰好等于 plugins 集合',
      sameSet(closure, new Set(plugins)) && closure.size === plugins.length,
      'closure=' + JSON.stringify([...closure].sort()));
  }
}

// ---------- VC3 共享（真实 harness CapabilityManager，同 VW7 serviceRig） ----------
{
  function serviceRig() {
    const persistence = new persistenceMod.PersistenceService();
    const home = runtimeApi.createMemoryWorkspace({ name: 'home', dirs: ['.skills'] });
    const storage = new ext.SkillInstanceStorage({ resolveHome: () => home });
    const manager = new harnessApi.CapabilityManager({
      catalogs: {
        capabilities: harnessApi.CAPABILITY_CATALOG,
        plugins: harnessApi.PLUGIN_CATALOG,
        skills: harnessApi.SKILL_CATALOG,
        mcps: harnessApi.MCP_CATALOG,
      },
      sources: new harnessApi.SkillSourceStore(),
      instances: storage,
    });
    const credentials = credSvcMod.createCredentialService({ persistence, manager });
    const service = svcMod.createCapabilityPackages({
      persistence,
      manager,
      now: () => '2026-10-25T00:00:00.000Z',
      credentials,
    });
    return { persistence, manager, service };
  }

  async function install(rig, fixtureName) {
    const built = await buildCapability(path.join(fixturesDir, fixtureName));
    const summary = await rig.service.inspect(built.bytes);
    if (!summary.ok) {
      throw new Error(fixtureName + ' inspect 失败: ' + JSON.stringify(summary.diagnostics));
    }
    return rig.service.commit(summary.token, {});
  }

  const pluginSeen = (rig, capId, pluginId) => {
    const cap = rig.manager.listCapabilities().find((c) => c.id === capId);
    const entry = cap && cap.plugins.find((p) => p.id === pluginId);
    return !!entry && entry.missing !== true; // missing=true = 未注册的占位
  };

  const rig = serviceRig();
  const SHARED = ['py-lxml', 'py-typing-extensions'];

  const word = await install(rig, 'closure-word');
  check('VC3 closure-word 注册成功', rig.manager.isPackage('closure-word') === true,
    word && JSON.stringify(word.state || null));

  const pptx = await install(rig, 'closure-pptx');
  check('VC3 closure-pptx 注册成功', rig.manager.isPackage('closure-pptx') === true,
    pptx && JSON.stringify(pptx.state || null));

  check('VC3 两个能力都看到已注册的 py-lxml 与 py-typing-extensions（共享组件只注册一次）',
    SHARED.every((id) => pluginSeen(rig, 'closure-word', id) && pluginSeen(rig, 'closure-pptx', id)),
    JSON.stringify(rig.manager.listCapabilities().map((c) => ({ id: c.id, plugins: c.plugins }))));

  // 卸载 closure-word：仍被 closure-pptx 引用的共享组件必须保留。
  await rig.manager.unregisterPackage('closure-word');
  check('VC3 卸载 closure-word 后 py-lxml / py-typing-extensions 仍注册',
    rig.manager.isPackage('closure-word') === false
    && rig.manager.isPackage('closure-pptx') === true
    && SHARED.every((id) => pluginSeen(rig, 'closure-pptx', id)),
    JSON.stringify(rig.manager.listCapabilities().map((c) => ({ id: c.id, plugins: c.plugins }))));
}

// ---------- VC4 体积 ----------
{
  const limit = LA.LOCUS_LIMITS.maxTotalBytes;
  for (const [fixture] of Object.entries(CLOSURES)) {
    const built = builtByName.get(fixture);
    const bytes = built ? built.bytes.byteLength : NaN;
    console.log('VC4 ' + fixture + ' .locus = ' + bytes + ' bytes（' + (bytes / 1024 / 1024).toFixed(2) + ' MiB）, 上限 ' + limit);
    check('VC4 ' + fixture + ' 单包小于 LOCUS_LIMITS.maxTotalBytes', Number.isFinite(bytes) && bytes < limit,
      String(bytes));
  }
}

console.log('vendor-closures.test: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
