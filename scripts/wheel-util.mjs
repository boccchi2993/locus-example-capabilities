// ============================================================
//  wheel-util — 第三方 wheel 的纯函数工具（D13：能力包携带
//  第三方 Pyodide wheel）。
//
//  包含四块：
//    1. PEP 503 发行包名规范化 + plugin id 规则（py-<规范化包名>）
//    2. wheel 文件名解析 + 平台标签规则（none-any 或
//       cp312 + pyodide_2024_0_wasm32）
//    3. runtime 预装包清单（遮盖检查用）
//    4. wheel 内 .dist-info/METADATA 的最小 ZIP 读取器 +
//       PEP 508 环境标记求值（Pyodide worker 环境）
//
//  TODO(runtime-export)：第 2、3 块的规则与清单目前在本仓库写死（语义
//  与 runtime feat/python-abi-export 的导出一字不差）。待 runtime PR
//  合并、product 锁定版本升级后，改为引用 runtime 导出，见 TODO.md。
// ============================================================

import zlib from 'node:zlib';

// ---------- 1. PEP 503 规范化 + plugin id ----------

// PEP 503：小写，连续的 -_. 折叠为单个 -。
export function normalizeDistName(name) {
  return String(name).toLowerCase().replace(/[-_.]+/g, '-');
}

// D13 第 5 条：示例仓库中同一个 Python 发行包统一使用 plugin id
// py-<规范化包名>，以便多个能力共享同一个组件。
export function pluginIdForDist(dist) {
  return 'py-' + normalizeDistName(dist);
}

// plugin id 允许的字符（组件 id 规则：小写字母数字与 ._-）。
export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

// ---------- 2. wheel 文件名 + 平台标签 ----------

// PEP 427 wheel 文件名：{dist}-{version}(-{build})?-{python}-{abi}-{platform}.whl
// dist / version 不含 -（下划线转义），5 段或 6 段（第 6 段是 build tag，
// 必须以数字开头）；其余形状返回 null。
// 与 runtime feat/python-abi-export 的 parseWheelFilename 同语义。
export function parseWheelFilename(filename) {
  if (typeof filename !== 'string' || !filename.endsWith('.whl')) return null;
  const parts = filename.slice(0, -'.whl'.length).split('-');
  if (parts.length < 5 || parts.length > 6 || parts.some((p) => !p)) return null;
  let build = null;
  let python = parts[2];
  let abi = parts[3];
  let platform = parts[4];
  if (parts.length === 6) {
    build = parts[2];
    if (!/^\d[^-]*$/.test(build)) return null;
    python = parts[3];
    abi = parts[4];
    platform = parts[5];
  }
  return { dist: parts[0], version: parts[1], build, python, abi, platform };
}

// D13 第 3 条：wheel 必须是纯 Python（abi none + platform any）或与当前
// runtime ABI 一致（python 与 abi 标签都含 cp312，platform 恰为
// pyodide_2024_0_wasm32）。语义与 runtime feat/python-abi-export 的
// wheelPlatformCompatible(...).ok 完全一致（该实现按 runtime 预装清单
// 在模块加载时推导 ABI 身份；这里写死的 cp312 / pyodide_2024_0_wasm32
// 就是当前清单 pandas-2.2.0-cp312-cp312-pyodide_2024_0_wasm32 的标签）。
// TODO(runtime-export)：待 runtime PR 合并、product 锁定版本升级后改为
// 引用 runtime 导出（本函数只剩一层薄委托），见 TODO.md。
export function wheelPlatformCompatible(filename) {
  const parsed = parseWheelFilename(filename);
  if (!parsed) return false;
  if (parsed.platform === 'any' && parsed.abi === 'none') return true; // 纯 Python
  return parsed.python.indexOf('cp312') !== -1
    && parsed.abi.indexOf('cp312') !== -1
    && parsed.platform === 'pyodide_2024_0_wasm32';
}

// ---------- 3. runtime 预装包清单 ----------

// D13 第 2 条：不得携带 runtime 已预装的包。当前 runtime（pyodide 0.26.4
// bootstrap）预装：pandas 及其依赖闭包、micropip、packaging。
// TODO(runtime-export)：清单写死在本仓库，待 runtime 导出后改为引用。
export const RUNTIME_PREINSTALLED_PACKAGES = Object.freeze(new Set([
  'micropip',
  'numpy',
  'packaging',
  'pandas',
  'python-dateutil',
  'pytz',
  'six',
].map((n) => normalizeDistName(n))));

// ---------- 4a. wheel 内 METADATA 的最小 ZIP 读取器 ----------

const U32 = (b, o) => b.readUInt32LE(o);
const U16 = (b, o) => b.readUInt16LE(o);
const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

function findEocd(buf) {
  // EOCD 固定 22 字节，注释最多 65535 字节——从尾部向前扫签名。
  const min = Math.max(0, buf.length - (22 + 65535));
  for (let i = buf.length - 22; i >= min; i--) {
    if (U32(buf, i) === EOCD_SIG) return i;
  }
  return -1;
}

// 读 wheel（一个 zip）里指定 dist-info 基名的条目，返回 UTF-8 文本。
// 只实现 wheel 实际用到的那部分 zip：EOCD + central directory +
// local header，stored / deflate 两种压缩。找不到时抛错。
function readWheelMember(bytes, baseName) {
  const buf = Buffer.from(bytes);
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是合法的 wheel（zip）：找不到 EOCD');
  const cdOffset = U32(buf, eocd + 16);
  const cdSize = U32(buf, eocd + 12);
  const totalEntries = U16(buf, eocd + 10);
  const nameRe = new RegExp('^[^/]+\\.dist-info\\/' + baseName + '$');
  let off = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (off + 46 > buf.length || U32(buf, off) !== CDH_SIG) {
      throw new Error('不是合法的 wheel（zip）：central directory 损坏');
    }
    const method = U16(buf, off + 10);
    const compressedSize = U32(buf, off + 20);
    const nameLen = U16(buf, off + 28);
    const extraLen = U16(buf, off + 30);
    const commentLen = U16(buf, off + 32);
    const localOffset = U32(buf, off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (nameRe.test(name)) {
      if (localOffset + 30 > buf.length || U32(buf, localOffset) !== LFH_SIG) {
        throw new Error('不是合法的 wheel（zip）：local header 损坏');
      }
      const lfhNameLen = U16(buf, localOffset + 26);
      const lfhExtraLen = U16(buf, localOffset + 28);
      const dataStart = localOffset + 30 + lfhNameLen + lfhExtraLen;
      if (dataStart + compressedSize > buf.length) {
        throw new Error('不是合法的 wheel（zip）：数据越界');
      }
      const raw = buf.subarray(dataStart, dataStart + compressedSize);
      const out = method === 0 ? raw
        : method === 8 ? zlib.inflateRawSync(raw)
        : (() => { throw new Error('wheel ' + name + ' 使用了不支持的压缩方法 ' + method); })();
      return out.toString('utf8');
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  if (off > cdOffset + cdSize) throw new Error('不是合法的 wheel（zip）：central directory 越界');
  throw new Error('wheel 中找不到匹配 ' + baseName + ' 的条目');
}

// 读 wheel（一个 zip）里的 *.dist-info/METADATA，返回 UTF-8 文本。
export function readWheelMetadata(bytes) {
  return readWheelMember(bytes, 'METADATA');
}

// METADATA 是 RFC 822 风格：头在第一个空行之前，Requires-Dist 每条一行。
export function wheelRequiresDist(metadataText) {
  const out = [];
  for (const line of String(metadataText).split(/\r?\n/)) {
    if (line === '') break;
    const m = /^Requires-Dist:\s*(.+)$/i.exec(line);
    if (m) out.push(m[1].trim());
  }
  return out;
}

// METADATA 头块里的 Name / Version / Summary（首个出现者赢，缺省 null）。
// 值都去首尾空白（Summary 去首尾空白在这里完成）。不处理 RFC 822 折叠
// 行——与 wheelRequiresDist 的最小读取器哲学一致。
// 与 locus_capability_sdk._wheelrules.wheel_metadata_fields 同语义。
export function wheelMetadataFields(metadataText) {
  const fields = { name: null, version: null, summary: null };
  for (const line of String(metadataText).split(/\r?\n/)) {
    if (line === '') break;
    const m = /^(Name|Version|Summary):\s*(.*)$/i.exec(line);
    if (m) {
      const key = m[1].toLowerCase();
      if (fields[key] === null) fields[key] = m[2].trim();
    }
  }
  return fields;
}

// wheel 的 *.dist-info/RECORD，返回 UTF-8 文本。
export function readWheelRecord(bytes) {
  return readWheelMember(bytes, 'RECORD');
}

// 从 RECORD 文本推导可导入的顶层名：顶层包目录（多段路径的首段）与
// 顶层 .py 模块（单段 *.py）；排除 *.dist-info、*.data、__pycache__。
// 排序去重。与 locus_capability_sdk._wheelrules.wheel_top_level_imports
// 同语义。
export function wheelTopLevelImports(recordText) {
  const names = new Set();
  for (const line of String(recordText).split(/\r?\n/)) {
    const arc = line ? line.split(',')[0] : '';
    if (!arc) continue;
    const parts = arc.split('/');
    const first = parts[0];
    if (first.endsWith('.dist-info') || first.endsWith('.data') || first === '__pycache__') continue;
    if (parts.length === 1) {
      if (first.endsWith('.py')) names.add(first.slice(0, -'.py'.length));
    } else {
      names.add(first);
    }
  }
  return [...names].sort();
}

// D14：插件 wheel 的 16 MiB 上限（runtime Python 镜像单文件上限，
// SYNC_MAX_FILE_BYTES，runtime PR #12）。超过的文件在 Locus 内 Python
// 看不见，无法在 Locus 内打包。
export const WHEEL_SIZE_LIMIT_BYTES = 16 * 1024 * 1024;

// ---------- 4b. PEP 508 环境标记 ----------

// 求值环境固定为 runtime 的 Pyodide worker：pyodide 0.26.4 = CPython
// 3.12.1 / emscripten wasm32。无法钉死的变量（platform_release、
// platform_version 等）在求值时抛错——按 D13 依赖顺序检查的要求，
// 判断不了的标记必须报错而不是猜。求值是严格的：不做 Python 的
// 短路，标记里任何判断不了的子表达式都报错（宁可误报不漏报）。
const MARKER_ENV = Object.freeze({
  python_version: '3.12',
  python_full_version: '3.12.1',
  sys_platform: 'emscripten',
  platform_system: 'Emscripten',
  platform_machine: 'wasm32',
  os_name: 'posix',
  implementation_name: 'cpython',
  implementation_version: '3.12.1',
  platform_python_implementation: 'CPython',
});

const MARKER_KEYWORDS = new Set(['or', 'and', 'not', 'in']);

function markerError(marker, why) {
  return new Error('无法判断的环境标记 ' + JSON.stringify(marker) + '（' + why + '）');
}

function tokenizeMarker(marker) {
  const tokens = [];
  let i = 0;
  while (i < marker.length) {
    const c = marker[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(' || c === ')') { tokens.push({ t: c }); i++; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < marker.length && marker[j] !== c) j++;
      if (j >= marker.length) throw markerError(marker, '字符串未闭合');
      tokens.push({ t: 'str', v: marker.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    const two = marker.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '~=', '==='].includes(two)) {
      tokens.push({ t: 'op', v: two }); i += 2; continue;
    }
    if (c === '<' || c === '>') { tokens.push({ t: 'op', v: c }); i++; continue; }
    if (/[A-Za-z0-9_.]/.test(c)) {
      let j = i;
      while (j < marker.length && /[A-Za-z0-9_.]/.test(marker[j])) j++;
      const word = marker.slice(i, j);
      if (MARKER_KEYWORDS.has(word)) tokens.push({ t: word });
      else if (/^[0-9][0-9._*]*$/.test(word)) tokens.push({ t: 'str', v: word }); // 裸数字值
      else tokens.push({ t: 'word', v: word });
      i = j;
      continue;
    }
    throw markerError(marker, '位置 ' + i + ' 附近有无法识别的字符 ' + JSON.stringify(c));
  }
  return tokens;
}

// 标记里是否出现 extra（出现在任何位置都说明这是“装了某个 extra 才
// 需要”的可选依赖——不自动安装依赖，因此一律跳过）。
export function markerReferencesExtra(marker) {
  return tokenizeMarker(marker).some((tok) => tok.t === 'word' && tok.v === 'extra');
}

// PEP 440-lite 版本比较：按 '.' 分段，数字段按数值比，短的用 0 补齐。
// 够用 python_version >= "3.8" 这类标记；复杂版本串不保证。
function versionSegments(v) {
  return String(v).replace(/\*$/, '').split('.').map((s) => (/^\d+$/.test(s) ? Number(s) : s));
}

function compareVersions(a, b) {
  const as = versionSegments(a);
  const bs = versionSegments(b);
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const x = as[i] === undefined ? 0 : as[i];
    const y = bs[i] === undefined ? 0 : bs[i];
    if (x === y) continue;
    const numeric = typeof x === 'number' && typeof y === 'number';
    return (numeric ? x - y : (String(x) < String(y) ? -1 : 1)) < 0 ? -1 : 1;
  }
  return 0;
}

const WILDCARD_RE = /^\d+(?:\.\d+)*\.\*$/;

// a 与 "3.12.*" 这类通配符版本串的相等判断（按 release 段前缀）。
function versionMatchesWildcard(v, wildcard) {
  const prefix = versionSegments(wildcard.slice(0, -2));
  const segs = versionSegments(v);
  if (segs.length < prefix.length) return false;
  return JSON.stringify(segs.slice(0, prefix.length)) === JSON.stringify(prefix);
}

function markerCompare(op, left, right, leftIsVersion, rightIsVersion) {
  if (op === 'in') return String(left).includes(String(right));
  if (op === 'not in') return !String(left).includes(String(right));
  if (op === '===') return String(left) === String(right);
  // 任一侧是版本变量就按 PEP 440-lite 版本序比较（另一侧通常是引号里的
  // 字面量）；"3.12.*" 通配符只支持相等/不等。
  if (leftIsVersion || rightIsVersion) {
    const wildcardLeft = typeof left === 'string' && WILDCARD_RE.test(left);
    const wildcardRight = typeof right === 'string' && WILDCARD_RE.test(right);
    if (op === '==') {
      if (wildcardRight) return versionMatchesWildcard(left, right);
      if (wildcardLeft) return versionMatchesWildcard(right, left);
      return compareVersions(left, right) === 0;
    }
    if (op === '!=') {
      if (wildcardRight) return !versionMatchesWildcard(left, right);
      if (wildcardLeft) return !versionMatchesWildcard(right, left);
      return compareVersions(left, right) !== 0;
    }
    if (wildcardLeft || wildcardRight) {
      throw new Error('版本序运算符不支持通配符版本串（== / != 除外）');
    }
    const c = compareVersions(left, right);
    if (op === '<') return c < 0;
    if (op === '<=') return c <= 0;
    if (op === '>') return c > 0;
    if (op === '>=') return c >= 0;
    if (op === '~=') {
      // PEP 440 兼容释放：V ~= W ⟺ V >= W 且 V 的 release 段以 W 去掉
      // 最后一段为前缀（如 3.12 ~= "3.8" ⟺ >= 3.8 且主版本为 3）。
      if (!leftIsVersion) throw new Error('~= 需要版本变量在左侧');
      const wSegs = versionSegments(String(right));
      if (wSegs.length < 2) throw new Error('~= 至少需要两段版本号: ' + JSON.stringify(right));
      return compareVersions(left, right) >= 0
        && JSON.stringify(versionSegments(left).slice(0, wSegs.length - 1))
          === JSON.stringify(wSegs.slice(0, wSegs.length - 1));
    }
    throw new Error('未知运算符 ' + JSON.stringify(op));
  }
  // 非版本变量（sys_platform 等）：== / != 精确串比较，其余按字典序。
  const s = String(left), t = String(right);
  return op === '==' ? s === t
    : op === '!=' ? s !== t
    : op === '<' ? s < t
    : op === '<=' ? s <= t
    : op === '>' ? s > t
    : op === '>=' ? s >= t
    : false;
}

// 求值一个 PEP 508 环境标记（不含 extra），返回 true/false。
// 判断不了（未知变量、语法不认识）时抛错，错误信息带原标记。
export function evaluateMarker(marker) {
  const tokens = tokenizeMarker(marker);
  let pos = 0;
  const peek = () => tokens[pos];
  const isVersionVar = (v) => ['python_version', 'python_full_version', 'implementation_version'].includes(v);

  function parseOr() {
    let v = parseAnd();
    while (peek() && peek().t === 'or') { pos++; v = parseAnd() || v; }
    return v;
  }
  function parseAnd() {
    let v = parseNot();
    while (peek() && peek().t === 'and') { pos++; v = parseNot() && v; }
    return v;
  }
  function parseNot() {
    if (peek() && peek().t === 'not') { pos++; return !parseNot(); }
    return parseAtom();
  }
  function operand() {
    const tok = peek();
    if (!tok) throw markerError(marker, '表达式意外结束');
    if (tok.t === 'str') { pos++; return tok.v; }
    if (tok.t === 'word') {
      pos++;
      if (!(tok.v in MARKER_ENV)) {
        throw markerError(marker, '变量 "' + tok.v + '" 不在 Pyodide worker 环境清单里');
      }
      return MARKER_ENV[tok.v];
    }
    throw markerError(marker, '期望变量或字符串，得到 ' + JSON.stringify(tok));
  }
  function parseAtom() {
    if (peek() && peek().t === '(') {
      pos++;
      const v = parseOr();
      if (!peek() || peek().t !== ')') throw markerError(marker, '缺少右括号');
      pos++;
      return v;
    }
    const save = pos;
    const leftTok = peek();
    const left = operand();
    const tok = peek();
    if (tok && tok.t === 'op') {
      pos++;
      const rightTok = peek();
      const right = operand();
      return markerCompare(tok.v, left, right,
        leftTok.t === 'word' && isVersionVar(leftTok.v),
        !!rightTok && rightTok.t === 'word' && isVersionVar(rightTok.v));
    }
    if (tok && tok.t === 'in') { pos++; return String(left).includes(String(operand())); }
    if (tok && tok.t === 'not' && tokens[pos + 1] && tokens[pos + 1].t === 'in') {
      pos += 2;
      return !String(left).includes(String(operand()));
    }
    pos = save;
    throw markerError(marker, '缺少比较运算符');
  }
  const result = parseOr();
  if (pos !== tokens.length) throw markerError(marker, '有多余的尾随内容');
  return result;
}
