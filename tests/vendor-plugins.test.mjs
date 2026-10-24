// VW6–VW7：D13 第三方 wheel 的端到端行为（构建 → inspect → 安装注册）。
//
//   VW6  多 plugin 能力端到端：夹具能力（skill + vendor 生成的
//        py-et-xmlfile + py-openpyxl 两个 plugin）构建成功、两次构建
//        字节相同、product 的 inspect() 通过、components.plugins 为 2 个
//        且顺序与声明一致；生成的 wheel 字节与 vendor 一致，且能力
//        自带 plugins/<id>/ 时照原样使用（不被 vendor 覆盖）。
//   VW7  共享与冲突：用 product 同款的真实 harness CapabilityManager
//        （locus-browser-agent-runtime/src/product/harness-api.js，
//        参照 locus-product tests/capability-install.test.mjs 的
//        serviceRig 构造）——两个夹具能力带同一个 py-et-xmlfile
//        （同版本同 wheel）都能 registerPackage 且组件只注册一次
//        （卸载其一后组件仍保留）；第三个夹具带不同版本的
//        py-et-xmlfile 时 registerPackage 被拒绝，错误指出冲突组件。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// persistence 的存储模式探测需要 window.location（同
// locus-product tests/capability-install.test.mjs 的模块级替身）。
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
import { readVendorWheel, loadVendorEntries, vendorPluginManifest } from '../scripts/vendor.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = path.join(repoRoot, 'tests', 'fixtures');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}
const rejectionOf = (p) => p.then(() => null, (e) => e);
const bytesEqual = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

// ---------- VW6 多 plugin 能力端到端 ----------
{
  const fixtureDir = path.join(fixturesDir, 'py-xlsx-demo');
  let built;
  try {
    built = await buildCapability(fixtureDir);
  } catch (e) {
    check('VW6 夹具构建成功', false, e.message);
    built = null;
  }
  if (built) {
    check('VW6 夹具构建成功', built.id === 'py-xlsx-demo' && built.version === '1.0.0',
      built.id + '@' + built.version);

    const rebuilt = await buildCapability(fixtureDir);
    check('VW6 两次构建字节相同', bytesEqual(built.bytes, rebuilt.bytes));

    const read = await LA.readLocusArchive(built.bytes);
    const files = new Map(read.files);
    const entries = loadVendorEntries(repoRoot);
    for (const entry of entries) {
      const rel = 'plugins/' + entry.id + '/artifacts/' + entry.filename;
      const inPackage = files.get(rel);
      check('VW6 生成的 ' + rel + ' 与 vendor 字节一致',
        !!inPackage && bytesEqual(inPackage, readVendorWheel(repoRoot, entry)));
      const decoder = new TextDecoder('utf-8');
      const manifestText = files.has('plugins/' + entry.id + '/plugin.json')
        ? decoder.decode(files.get('plugins/' + entry.id + '/plugin.json'))
        : undefined;
      const expected = JSON.stringify(vendorPluginManifest(entry), null, 2) + '\n';
      check('VW6 生成的 ' + entry.id + ' plugin.json 符合 D13 包 v1 形状',
        manifestText === expected,
        manifestText === undefined ? 'missing' : 'content differs');
    }

    const service = svcMod.createCapabilityPackages({
      persistence: { loadCapabilityPackages: async () => [] },
      manager: {},
      now: () => '1970-01-01T00:00:00.000Z',
    });
    const summary = await service.inspect(built.bytes);
    check('VW6 inspect ok / kind new / mismatched 空',
      summary.ok === true && summary.kind === 'new' && summary.mismatched.length === 0,
      JSON.stringify(summary.diagnostics || null));
    check('VW6 components.plugins 为 2 个且顺序与声明一致',
      summary.ok
      && JSON.stringify(summary.components.plugins.map((p) => p.id))
        === JSON.stringify(['py-et-xmlfile', 'py-openpyxl']),
      JSON.stringify(summary.components && summary.components.plugins));
  }
}

// ---------- VW7 共享与冲突（真实 harness CapabilityManager） ----------
{
  // 与 locus-product tests/capability-install.test.mjs 的 serviceRig 相同
  // 的构造：真实 CapabilityManager + 内存 PersistenceService + 凭据服务。
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
      now: () => '2026-10-24T00:00:00.000Z',
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
    const commit = await rig.service.commit(summary.token, {});
    return { built, summary, commit };
  }

  const pluginSeen = (rig, capId, pluginId) => {
    const cap = rig.manager.listCapabilities().find((c) => c.id === capId);
    const entry = cap && cap.plugins.find((p) => p.id === pluginId);
    return !!entry && entry.missing !== true; // missing=true = 未注册的占位
  };

  const rig = serviceRig();

  const capA = await install(rig, 'py-xlsx-demo');
  check('VW7 py-xlsx-demo 注册成功', rig.manager.isPackage('py-xlsx-demo') === true);

  const capB = await install(rig, 'py-et-user');
  check('VW7 共享同一 py-et-xmlfile 的第二个能力注册成功',
    rig.manager.isPackage('py-et-user') === true,
    capB.commit && JSON.stringify(capB.commit.unchanged));

  check('VW7 两个能力都看到已注册的 py-et-xmlfile（组件只注册一次、共享）',
    pluginSeen(rig, 'py-xlsx-demo', 'py-et-xmlfile')
    && pluginSeen(rig, 'py-et-user', 'py-et-xmlfile'),
    JSON.stringify(rig.manager.listCapabilities().map((c) => ({ id: c.id, plugins: c.plugins }))));

  // 卸载其一：仍被另一个能力引用的组件保留——单份注册的直接证据。
  await rig.manager.unregisterPackage('py-xlsx-demo');
  check('VW7 卸载 py-xlsx-demo 后 py-et-xmlfile 仍注册（py-et-user 仍引用）',
    rig.manager.isPackage('py-xlsx-demo') === false
    && rig.manager.isPackage('py-et-user') === true
    && pluginSeen(rig, 'py-et-user', 'py-et-xmlfile'));

  // 第三个夹具带不同版本（2.0.1，能力自带的 plugin）→ 注册被拒绝，
  // 错误指出冲突的组件。
  const capC = await install(rig, 'py-et-version-clash').then(
    (r) => ({ ok: true, r }),
    (e) => ({ ok: false, e }),
  );
  check('VW7 不同版本的 py-et-xmlfile 被拒绝', capC.ok === false
    && /conflicts with an already registered plugin/.test(capC.e.message)
    && capC.e.message.includes('py-et-xmlfile'),
    capC.ok ? '意外成功' : capC.e.message);
  check('VW7 冲突后原有注册不受影响',
    rig.manager.isPackage('py-et-version-clash') === false
    && rig.manager.isPackage('py-et-user') === true
    && pluginSeen(rig, 'py-et-user', 'py-et-xmlfile'));
}

console.log('vendor-plugins.test: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
