// ============================================================
//  vendor — 第三方 wheel 清单（vendor/wheels.json）与 pyodide
//  lock 参照文件的加载、校验（检查 1 一致性、检查 2 来源核验）。
//
//  目录约定见 vendor/README.md 与根 README.md 的“第三方 wheel”一节。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { normalizeDistName, pluginIdForDist, parseWheelFilename, PLUGIN_ID_RE } from './wheel-util.mjs';

export const VENDOR_DIR = 'vendor';
export const WHEELS_JSON_NAME = 'wheels.json';
export const WHEELS_DIR_NAME = 'wheels';
export const PYODIDE_LOCK_NAME = 'pyodide-lock-0.26.4.json';
export const PYODIDE_LOCK_URL = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide-lock.json';
export const PYODIDE_VERSION_PINNED = '0.26.4';

const WHEEL_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.whl$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export function vendorDir(repoRoot) {
  return path.join(repoRoot, VENDOR_DIR);
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// ---------- wheels.json ----------

// 读取并校验 vendor/wheels.json。每项：
//   { id, dist, version, filename, sha256, source, license, imports,
//     displayName, description }
// id 必须等于 py-<normalizeDistName(dist)> 且符合组件 id 规则；
// filename 解析出的 dist / version 必须与字段一致。
export function loadVendorEntries(repoRoot) {
  const file = path.join(vendorDir(repoRoot), WHEELS_JSON_NAME);
  if (!fs.existsSync(file)) {
    throw new Error('缺少 ' + VENDOR_DIR + '/' + WHEELS_JSON_NAME);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(VENDOR_DIR + '/' + WHEELS_JSON_NAME + ' 不是合法 JSON: ' + e.message);
  }
  if (!Array.isArray(raw)) {
    throw new Error(VENDOR_DIR + '/' + WHEELS_JSON_NAME + ' 顶层必须是数组');
  }
  const errors = [];
  const byId = new Map();
  const byFilename = new Map();
  raw.forEach((entry, i) => {
    const at = WHEELS_JSON_NAME + '[' + i + ']';
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(at + ' 必须是对象');
      return;
    }
    const before = errors.length;
    for (const field of ['id', 'dist', 'version', 'filename', 'sha256', 'source', 'license', 'displayName', 'description']) {
      if (typeof entry[field] !== 'string' || !entry[field].length) {
        errors.push(at + ' 缺少字符串字段 "' + field + '"');
      }
    }
    if (!Array.isArray(entry.imports) || !entry.imports.length
      || entry.imports.some((s) => typeof s !== 'string' || !s.length)) {
      errors.push(at + ' 的 "imports" 必须是非空字符串数组');
    }
    if (errors.length > before) return; // 该项已不完整，跳过后续校验
    if (entry.source !== 'pypi' && entry.source !== 'pyodide-lock') {
      errors.push(at + ' 的 "source" 必须是 "pypi" 或 "pyodide-lock"，得到 ' + JSON.stringify(entry.source));
    }
    if (!SHA256_RE.test(entry.sha256)) {
      errors.push(at + ' 的 "sha256" 必须是 64 位小写十六进制');
    }
    if (entry.id !== pluginIdForDist(entry.dist)) {
      errors.push(at + ' 的 id 必须是 "' + pluginIdForDist(entry.dist) + '"（py- + PEP 503 规范化包名），得到 ' + JSON.stringify(entry.id));
    }
    if (!PLUGIN_ID_RE.test(entry.id)) {
      errors.push(at + ' 的 id 不符合组件 id 规则（小写字母数字与 ._-）：' + JSON.stringify(entry.id));
    }
    if (!WHEEL_FILENAME_RE.test(entry.filename)) {
      errors.push(at + ' 的 "filename" 必须是 .whl 基本文件名：' + JSON.stringify(entry.filename));
    } else {
      const parsed = parseWheelFilename(entry.filename);
      if (!parsed) {
        errors.push(at + ' 的 "filename" 不是 <dist>-<version>-<py>-<abi>-<platform>.whl 形状');
      } else {
        if (normalizeDistName(parsed.dist) !== normalizeDistName(entry.dist)) {
          errors.push(at + ' 的 filename 发行包（' + parsed.dist + '）与 dist 字段（' + entry.dist + '）不一致');
        }
        if (parsed.version !== entry.version) {
          errors.push(at + ' 的 filename 版本（' + parsed.version + '）与 version 字段（' + entry.version + '）不一致');
        }
      }
    }
    if (byId.has(entry.id)) errors.push(at + ' 的 id 重复：' + entry.id);
    if (byFilename.has(entry.filename)) errors.push(at + ' 的 filename 重复：' + entry.filename);
    byId.set(entry.id, true);
    byFilename.set(entry.filename, true);
  });
  if (errors.length) {
    throw new Error(VENDOR_DIR + '/' + WHEELS_JSON_NAME + ' 校验失败:\n  - ' + errors.join('\n  - '));
  }
  return raw;
}

export function vendorIndexById(entries) {
  return new Map(entries.map((e) => [e.id, e]));
}

export function vendorWheelPath(repoRoot, entry) {
  return path.join(vendorDir(repoRoot), WHEELS_DIR_NAME, entry.filename);
}

export function readVendorWheel(repoRoot, entry) {
  return fs.readFileSync(vendorWheelPath(repoRoot, entry));
}

// 从 vendor 清单项生成 plugins/<id>/plugin.json 的内容（D13 第 1 条的
// 包 v1 形状：runtime python、authority none、恰好一个 python-wheel
// artifact）。build.mjs 在构建时用它把 vendor wheel 材料化进内存工作区。
export function vendorPluginManifest(entry) {
  return {
    schemaVersion: 1,
    plugin: {
      id: entry.id,
      version: entry.version,
      displayName: entry.displayName,
      description: entry.description,
      runtime: 'python',
      authority: 'none',
      provides: { pythonImports: entry.imports.slice() },
    },
    artifacts: [{ path: 'artifacts/' + entry.filename, format: 'python-wheel' }],
  };
}

// ---------- pyodide lock 与 README 记录 ----------

// vendor/README.md 里记录的 pyodide-lock sha256（格式：`sha256:` 反引号
// 包裹的 64 位十六进制）。没有或有多条记录都算错。
export function recordedLockSha256(repoRoot) {
  const readmePath = path.join(vendorDir(repoRoot), 'README.md');
  if (!fs.existsSync(readmePath)) {
    throw new Error('缺少 ' + VENDOR_DIR + '/README.md');
  }
  const text = fs.readFileSync(readmePath, 'utf8');
  const matches = [...text.matchAll(/sha256:\s*`?([0-9a-f]{64})`?/g)];
  if (!matches.length) {
    throw new Error(VENDOR_DIR + '/README.md 里没有记录 pyodide-lock 的 sha256（需要一行 "sha256: `<64位十六进制>`"）');
  }
  const values = new Set(matches.map((m) => m[1]));
  if (values.size > 1) {
    throw new Error(VENDOR_DIR + '/README.md 里记录了多个不同的 sha256: ' + [...values].join(', '));
  }
  return [...values][0];
}

export function loadPyodideLock(repoRoot) {
  const file = path.join(vendorDir(repoRoot), PYODIDE_LOCK_NAME);
  if (!fs.existsSync(file)) {
    throw new Error('缺少 ' + VENDOR_DIR + '/' + PYODIDE_LOCK_NAME);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ---------- 检查 1：vendor 一致性 ----------

// wheels.json 每项的 wheel 文件存在且 sha256 一致；vendor/wheels/ 里没有
// 多余或缺失的文件；pyodide-lock 文件的 sha256 与 vendor/README.md 记录
// 一致。返回错误信息数组（空数组 = 通过）。
export function checkVendorConsistency(repoRoot) {
  const errors = [];
  const wheelsDir = path.join(vendorDir(repoRoot), WHEELS_DIR_NAME);
  let entries;
  try {
    entries = loadVendorEntries(repoRoot);
  } catch (e) {
    return [e.message];
  }

  const onDisk = fs.existsSync(wheelsDir)
    ? fs.readdirSync(wheelsDir).filter((f) => f !== '.' && f !== '..')
    : null;
  if (!onDisk) {
    errors.push('缺少目录 ' + VENDOR_DIR + '/' + WHEELS_DIR_NAME + '/');
  } else {
    const expected = new Set(entries.map((e) => e.filename));
    for (const f of onDisk.sort()) {
      if (!expected.has(f)) errors.push(VENDOR_DIR + '/' + WHEELS_DIR_NAME + '/ 有清单之外的文件: ' + f);
    }
    for (const e of entries) {
      if (!onDisk.includes(e.filename)) {
        errors.push(VENDOR_DIR + '/' + WHEELS_DIR_NAME + '/ 缺少清单里的文件: ' + e.filename);
      }
    }
  }

  for (const entry of entries) {
    const file = vendorWheelPath(repoRoot, entry);
    if (!fs.existsSync(file)) continue; // 缺失已在上面的目录比对里报过
    const actual = sha256Hex(fs.readFileSync(file));
    if (actual !== entry.sha256) {
      errors.push(entry.id + '（' + entry.filename + '）sha256 不一致: 清单记录 ' + entry.sha256 + '，实际 ' + actual);
    }
  }

  let lockActual = null;
  try {
    const lockBytes = fs.readFileSync(path.join(vendorDir(repoRoot), PYODIDE_LOCK_NAME));
    lockActual = sha256Hex(lockBytes);
  } catch (e) {
    errors.push('读取 ' + VENDOR_DIR + '/' + PYODIDE_LOCK_NAME + ' 失败: ' + e.message);
  }
  let recorded = null;
  try {
    recorded = recordedLockSha256(repoRoot);
  } catch (e) {
    errors.push(e.message);
  }
  if (lockActual && recorded && lockActual !== recorded) {
    errors.push(VENDOR_DIR + '/' + PYODIDE_LOCK_NAME + ' 的 sha256 与 ' + VENDOR_DIR + '/README.md 记录不一致: 记录 '
      + recorded + '，实际 ' + lockActual + '（文件被更换过？请更新 README 记录）');
  }
  return errors;
}

// ---------- 检查 2：来源核验 ----------

// 网络不可用时按 D13 要求报错退出，不跳过（CI 能联网）。
async function fetchJson(url) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  } catch (e) {
    throw new Error('在线查询失败（网络不可用？）: ' + url + ' — ' + (e && e.message ? e.message : String(e)));
  }
  if (!res.ok) {
    throw new Error('在线查询返回 HTTP ' + res.status + ': ' + url);
  }
  return res.json();
}

async function pypiSha256For(dist, version, filename) {
  const url = 'https://pypi.org/pypi/' + encodeURIComponent(dist) + '/' + encodeURIComponent(version) + '/json';
  const json = await fetchJson(url);
  const hit = (Array.isArray(json.urls) ? json.urls : []).find((u) => u && u.filename === filename);
  if (!hit) {
    throw new Error('PyPI 上没有文件 ' + filename + '（' + dist + ' ' + version + '）');
  }
  const digest = hit.digests && hit.digests.sha256;
  if (typeof digest !== 'string' || !SHA256_RE.test(digest)) {
    throw new Error('PyPI 返回的 ' + filename + ' 没有 sha256 摘要');
  }
  return digest;
}

// source 核验：
//   - "pyodide-lock"：sha256 必须等于 vendor/pyodide-lock-0.26.4.json 里
//     对应包的记录，且文件名一致；
//   - "pypi"：在线查询 PyPI JSON API，sha256 必须等于该文件名的
//     digests.sha256。
// 返回错误信息数组（空数组 = 通过）。
export async function checkVendorSources(repoRoot) {
  const errors = [];
  let entries;
  try {
    entries = loadVendorEntries(repoRoot);
  } catch (e) {
    return [e.message];
  }
  let lockIndex = null;
  try {
    const lock = loadPyodideLock(repoRoot);
    lockIndex = new Map(Object.keys(lock.packages || {}).map((k) => [normalizeDistName(k), lock.packages[k]]));
  } catch (e) {
    errors.push('读取 ' + VENDOR_DIR + '/' + PYODIDE_LOCK_NAME + ' 失败: ' + e.message);
  }

  for (const entry of entries) {
    const at = entry.id + '（' + entry.filename + '）';
    try {
      if (entry.source === 'pyodide-lock') {
        if (!lockIndex) {
          errors.push(at + ': 无法核验——' + PYODIDE_LOCK_NAME + ' 读取失败');
          continue;
        }
        const pkg = lockIndex.get(normalizeDistName(entry.dist));
        if (!pkg) {
          errors.push(at + ': ' + VENDOR_DIR + '/' + PYODIDE_LOCK_NAME + ' 里没有发行包 "' + entry.dist + '"');
        } else {
          if (pkg.file_name !== entry.filename) {
            errors.push(at + ': pyodide-lock 记录的文件名是 ' + JSON.stringify(pkg.file_name) + '，与清单不一致');
          }
          if (typeof pkg.sha256 !== 'string' || !SHA256_RE.test(pkg.sha256)) {
            errors.push(at + ': pyodide-lock 里该包没有合法的 sha256 记录');
          } else if (pkg.sha256 !== entry.sha256) {
            errors.push(at + ': sha256 与 pyodide-lock 记录不一致: 清单 ' + entry.sha256 + '，pyodide-lock ' + pkg.sha256);
          }
        }
      } else if (entry.source === 'pypi') {
        const actual = await pypiSha256For(entry.dist, entry.version, entry.filename);
        if (actual !== entry.sha256) {
          errors.push(at + ': sha256 与 PyPI 公布值不一致: 清单 ' + entry.sha256 + '，PyPI ' + actual);
        }
      } else {
        errors.push(at + ': 未知 source ' + JSON.stringify(entry.source));
      }
    } catch (e) {
      errors.push(at + ': ' + (e && e.message ? e.message : String(e)));
    }
  }
  return errors;
}
