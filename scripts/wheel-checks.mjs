// ============================================================
//  wheel-checks — D13 第三方 wheel 的三项规则检查（平台标签 /
//  预装遮盖 / 依赖顺序），供 scripts/check.mjs 与测试共用。
//
//    检查 3（平台标签）：wheel 必须 none-any 或 cp312 +
//    pyodide_2024_0_wasm32（规则在 wheel-util.wheelPlatformCompatible）。
//    检查 4（预装遮盖）：wheel 的发行包不得是 runtime 预装包。
//    检查 5（依赖顺序）：读每个 wheel 的 .dist-info/METADATA
//    Requires-Dist，只考虑无 extra 条件且环境标记对
//    Python 3.12 / sys_platform=emscripten 成立的依赖；每个依赖
//    要么是 runtime 预装包，要么由 capability.json plugins 列表中
//    位置更靠前的 py-<包名> plugin 提供。
//
//  TODO(runtime-export)：平台规则与预装清单写死在本仓库（见
//  wheel-util.mjs），待 runtime 导出后改为引用，见 TODO.md。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';

import {
  normalizeDistName,
  pluginIdForDist,
  PLUGIN_ID_RE,
  wheelPlatformCompatible,
  RUNTIME_PREINSTALLED_PACKAGES,
  readWheelMetadata,
  wheelRequiresDist,
  evaluateMarker,
  markerReferencesExtra,
} from './wheel-util.mjs';
import {
  loadVendorEntries,
  readVendorWheel,
} from './vendor.mjs';

const PEP508_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?/;

// 解析一条 Requires-Dist：name[extras](版本约束) ; 环境标记
// → { name, marker }；解析不了返回 null。
function parseRequirement(raw) {
  const semi = raw.indexOf(';');
  const req = (semi >= 0 ? raw.slice(0, semi) : raw).trim();
  const m = PEP508_NAME_RE.exec(req);
  if (!m) return null;
  return { name: m[0], marker: semi >= 0 ? raw.slice(semi + 1).trim() : null };
}

// 能力目录里自己写的 plugins/<id>/（plugin.json + artifacts 下的 wheel），
// 返回 { filename, bytes }；没有则返回 null。
function readLocalPluginWheel(sourceDir, pluginId) {
  const manifestPath = path.join(sourceDir, 'plugins', pluginId, 'plugin.json');
  if (!fs.existsSync(manifestPath)) return null;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    throw new Error('plugins/' + pluginId + '/plugin.json 不是合法 JSON: ' + e.message);
  }
  const artifacts = manifest && Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  if (artifacts.length !== 1 || !artifacts[0] || typeof artifacts[0].path !== 'string') {
    throw new Error('plugins/' + pluginId + '/plugin.json 必须恰好声明一个 artifacts 项');
  }
  const wheelPath = path.join(sourceDir, 'plugins', pluginId, artifacts[0].path);
  return {
    filename: path.basename(wheelPath),
    bytes: fs.readFileSync(wheelPath),
  };
}

// 对一个能力目录做检查 3 / 4 / 5（只看 capability.json 里声明的 plugin，
// 不做构建）。返回错误信息数组（空数组 = 通过）。
export function checkCapabilityWheelRules(repoRoot, sourceDir) {
  const errors = [];
  const manifestPath = path.join(sourceDir, 'capability.json');
  let capability;
  try {
    capability = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).capability;
  } catch (e) {
    return [sourceDir + ': 读取 capability.json 失败: ' + e.message];
  }
  const plugins = capability && Array.isArray(capability.plugins) ? capability.plugins : [];

  let vendorById = null; // 惰性加载，绝大多数能力用不到
  const resolveVendor = (id) => {
    if (!vendorById) {
      const entries = loadVendorEntries(repoRoot);
      vendorById = new Map(entries.map((e) => [e.id, e]));
    }
    return vendorById.get(id) || null;
  };

  // 逐个声明了的 plugin：id 规则 → 预装遮盖 → 解析 wheel → 平台标签。
  const resolved = []; // { id, index, filename, bytes }
  plugins.forEach((id, index) => {
    if (typeof id !== 'string' || !id.startsWith('py-')) return; // 非 python wheel plugin 不在本检查范围
    const dist = normalizeDistName(id.slice('py-'.length));
    if (!PLUGIN_ID_RE.test(id)) {
      errors.push(id + ': plugin id 不符合组件 id 规则（小写字母数字与 ._-）');
    }
    if (RUNTIME_PREINSTALLED_PACKAGES.has(dist)) {
      errors.push(id + ': 遮盖 runtime 预装包 "' + dist + '"（D13 第 2 条：能力不得携带 runtime 已预装的包）');
    }
    let filename = null;
    let bytes = null;
    try {
      const local = readLocalPluginWheel(sourceDir, id);
      if (local) {
        filename = local.filename;
        bytes = local.bytes;
      } else {
        const entry = resolveVendor(id);
        if (entry) {
          filename = entry.filename;
          bytes = readVendorWheel(repoRoot, entry);
        } else {
          errors.push(id + ': vendor/wheels.json 里没有这个 id，能力目录下也没有 plugins/' + id
            + '/（py- 插件只能来自 vendor 或能力自带的 plugins/ 目录）');
        }
      }
    } catch (e) {
      errors.push(id + ': 读取 wheel 失败: ' + (e && e.message ? e.message : String(e)));
    }
    if (filename && !wheelPlatformCompatible(filename)) {
      errors.push(id + ': wheel ' + filename + ' 的平台标签不兼容（需要 *-none-any 或 cp312 + pyodide_2024_0_wasm32）');
    }
    resolved.push({ id, index, filename, bytes });
  });

  // 检查 5：依赖顺序。对解析出 wheel 的每个 plugin 读 METADATA。
  for (const r of resolved) {
    if (!r.bytes) continue; // 解析失败的上面已经报错
    let metadataText;
    try {
      metadataText = readWheelMetadata(r.bytes);
    } catch (e) {
      errors.push(r.id + ': 读取 wheel ' + r.filename + ' 的 METADATA 失败: ' + (e && e.message ? e.message : String(e)));
      continue;
    }
    for (const raw of wheelRequiresDist(metadataText)) {
      const req = parseRequirement(raw);
      if (!req) {
        errors.push(r.id + ': 无法解析的 Requires-Dist "' + raw + '"（wheel ' + r.filename + '）');
        continue;
      }
      // extra 条件 = “装了某个 extra 才需要”的可选依赖：不自动安装
      // 依赖，因此不要求出现在 plugins 列表里，跳过。
      if (req.marker && markerReferencesExtra(req.marker)) continue;
      if (req.marker) {
        let holds;
        try {
          holds = evaluateMarker(req.marker);
        } catch (e) {
          errors.push(r.id + ': 环境标记无法判断 — ' + (e && e.message ? e.message : String(e))
            + '（Requires-Dist "' + raw + '"，wheel ' + r.filename + '）');
          continue;
        }
        if (!holds) continue;
      }
      const depDist = normalizeDistName(req.name);
      if (RUNTIME_PREINSTALLED_PACKAGES.has(depDist)) continue; // runtime 预装，无需自带
      const providerId = pluginIdForDist(depDist);
      const providerIndex = plugins.indexOf(providerId);
      if (providerIndex < 0) {
        errors.push(r.id + ': 缺少依赖 "' + req.name + '" — 应以 plugin "' + providerId
          + '" 的形式提供在 plugins 列表中，且排在依赖它的 "' + r.id + '" 之前'
          + '（Requires-Dist "' + raw + '"，wheel ' + r.filename + '）');
      } else if (providerIndex >= r.index) {
        errors.push(r.id + ': 依赖顺序错误 — "' + req.name + '" 由 "' + providerId
          + '"（plugins[' + providerIndex + ']）提供，但它必须排在依赖它的 "' + r.id
          + '"（plugins[' + r.index + ']）之前');
      }
    }
  }
  return errors;
}

// 对 vendor 全表做检查 3 / 4（清单里的每个 wheel 都必须平台兼容、
// 不得遮盖预装包——不管当前有没有能力引用它）。返回错误信息数组。
export function checkVendorWheelRules(repoRoot) {
  const errors = [];
  let entries;
  try {
    entries = loadVendorEntries(repoRoot);
  } catch (e) {
    return [e.message];
  }
  for (const entry of entries) {
    if (!wheelPlatformCompatible(entry.filename)) {
      errors.push('vendor: ' + entry.id + '（' + entry.filename
        + '）的平台标签不兼容（需要 *-none-any 或 cp312 + pyodide_2024_0_wasm32）');
    }
    const dist = normalizeDistName(entry.dist);
    if (RUNTIME_PREINSTALLED_PACKAGES.has(dist)) {
      errors.push('vendor: ' + entry.id + ' 遮盖 runtime 预装包 "' + dist
        + '"（D13 第 2 条：vendor 不得收录 runtime 已预装的包）');
    }
  }
  return errors;
}
