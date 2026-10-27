# ============================================================
#  locus_capability_sdk._wheelrules — D13 wheel rules + vendor.
#
#  Python port of scripts/wheel-util.mjs + the capability part of
#  scripts/wheel-checks.mjs (rules 3/4/5): platform tags, runtime
#  preinstalled shadowing and dependency order. The pinned Pyodide
#  worker identity (CPython 3.12.1 / pyodide 0.26.4 / wasm32) and the
#  preinstalled set match the runtime's PYTHON_ABI /
#  PYTHON_RUNTIME_PACKAGES derivation (verified against the
#  locus-runtime export shipped with the locked product).
#
#  Codes for checks that have no JS diagnostic code (rules 3/4/5
#  report plain message strings in check.mjs):
#    wheel-id-invalid, wheel-shadow-preinstalled, wheel-unresolvable,
#    wheel-platform-incompatible, wheel-metadata-unreadable,
#    wheel-requires-unparseable, wheel-marker-undecidable,
#    wheel-dependency-missing, wheel-dependency-order
# ============================================================

import json
import os
import re
import struct
import zlib

# ---------- PEP 503 normalization + plugin id ----------


def normalize_dist_name(name: str) -> str:
    return re.sub(r"[-_.]+", "-", str(name)).lower()


def plugin_id_for_dist(dist: str) -> str:
    return "py-" + normalize_dist_name(dist)


PLUGIN_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")


# ---------- wheel filename + platform tags ----------


def parse_wheel_filename(filename):
    if not isinstance(filename, str) or not filename.endswith(".whl"):
        return None
    parts = filename[:-len(".whl")].split("-")
    if len(parts) < 5 or len(parts) > 6 or any(not p for p in parts):
        return None
    build = None
    python_tag, abi_tag, platform_tag = parts[2], parts[3], parts[4]
    if len(parts) == 6:
        build = parts[2]
        if not re.fullmatch(r"\d[^-]*", build):
            return None
        python_tag, abi_tag, platform_tag = parts[3], parts[4], parts[5]
    return {"dist": parts[0], "version": parts[1], "build": build,
            "python": python_tag, "abi": abi_tag, "platform": platform_tag}


# The runtime ABI identity (PYTHON_ABI), derived by locus-runtime from
# the bootstrap manifest's native wheels — currently
# pandas-2.2.0-cp312-cp312-pyodide_2024_0_wasm32.
PYTHON_ABI = {"python": "cp312", "platform": "pyodide_2024_0_wasm32"}


def wheel_platform_compatible(filename):
    parsed = parse_wheel_filename(filename)
    if not parsed:
        return {"ok": False, "kind": None,
                "reason": ("not a valid wheel filename (PEP 427 {dist}-{version}(-{build})"
                           "-{python}-{abi}-{platform}.whl): %s" % str(filename))}
    if parsed["platform"] == "any" and parsed["abi"] == "none":
        return {"ok": True, "kind": "pure", "reason": ""}
    if (PYTHON_ABI["python"] in parsed["python"]
            and PYTHON_ABI["python"] in parsed["abi"]
            and parsed["platform"] == PYTHON_ABI["platform"]):
        return {"ok": True, "kind": "native", "reason": ""}
    return {"ok": False, "kind": None,
            "reason": ("wheel tags %s-%s-%s do not match this runtime (needs python and abi "
                       "tags containing %s on platform %s, or a pure wheel: abi none, "
                       "platform any)" % (parsed["python"], parsed["abi"], parsed["platform"],
                                          PYTHON_ABI["python"], PYTHON_ABI["platform"]))}


# ---------- runtime preinstalled packages ----------

RUNTIME_PREINSTALLED_PACKAGES = frozenset(
    normalize_dist_name(n) for n in (
        "micropip", "numpy", "packaging", "pandas", "python-dateutil", "pytz", "six",
    ))


# ---------- minimal zip reader for wheel METADATA ----------

_EOCD_SIG = 0x06054B50
_CDH_SIG = 0x02014B50
_LFH_SIG = 0x04034B50


def _find_eocd(buf):
    start = max(0, len(buf) - (22 + 65535))
    i = len(buf) - 22
    while i >= start:
        if struct.unpack_from("<I", buf, i)[0] == _EOCD_SIG:
            return i
        i -= 1
    return -1


def read_wheel_metadata(data: bytes) -> str:
    """Return the UTF-8 text of the wheel's *.dist-info/METADATA."""
    buf = bytes(data)
    eocd = _find_eocd(buf)
    if eocd < 0:
        raise ValueError("不是合法的 wheel（zip）：找不到 EOCD")
    cd_offset = struct.unpack_from("<I", buf, eocd + 16)[0]
    cd_size = struct.unpack_from("<I", buf, eocd + 12)[0]
    total_entries = struct.unpack_from("<H", buf, eocd + 10)[0]
    off = cd_offset
    for _ in range(total_entries):
        if off + 46 > len(buf) or struct.unpack_from("<I", buf, off)[0] != _CDH_SIG:
            raise ValueError("不是合法的 wheel（zip）：central directory 损坏")
        method = struct.unpack_from("<H", buf, off + 10)[0]
        compressed_size = struct.unpack_from("<I", buf, off + 20)[0]
        name_len = struct.unpack_from("<H", buf, off + 28)[0]
        extra_len = struct.unpack_from("<H", buf, off + 30)[0]
        comment_len = struct.unpack_from("<H", buf, off + 32)[0]
        local_offset = struct.unpack_from("<I", buf, off + 42)[0]
        name = buf[off + 46:off + 46 + name_len].decode("utf-8")
        if re.fullmatch(r"[^/]+\.dist-info/METADATA", name):
            if local_offset + 30 > len(buf) \
                    or struct.unpack_from("<I", buf, local_offset)[0] != _LFH_SIG:
                raise ValueError("不是合法的 wheel（zip）：local header 损坏")
            lfh_name_len = struct.unpack_from("<H", buf, local_offset + 26)[0]
            lfh_extra_len = struct.unpack_from("<H", buf, local_offset + 28)[0]
            data_start = local_offset + 30 + lfh_name_len + lfh_extra_len
            if data_start + compressed_size > len(buf):
                raise ValueError("不是合法的 wheel（zip）：数据越界")
            raw = buf[data_start:data_start + compressed_size]
            if method == 0:
                out = raw
            elif method == 8:
                try:
                    out = zlib.decompress(raw, -15)
                except zlib.error as e:
                    raise ValueError("不是合法的 wheel（zip）：deflate 数据损坏（%s）" % e)
            else:
                raise ValueError("wheel METADATA 使用了不支持的压缩方法 %d" % method)
            return out.decode("utf-8")
        off += 46 + name_len + extra_len + comment_len
    if off > cd_offset + cd_size:
        raise ValueError("不是合法的 wheel（zip）：central directory 越界")
    raise ValueError("wheel 中找不到 .dist-info/METADATA")


def wheel_requires_dist(metadata_text):
    out = []
    for line in re.split(r"\r?\n", str(metadata_text)):
        if line == "":
            break
        m = re.fullmatch(r"Requires-Dist:\s*(.+)", line, re.IGNORECASE)
        if m:
            out.append(m.group(1).strip())
    return out


# ---------- PEP 508 environment markers (Pyodide worker, strict) ----------

MARKER_ENV = {
    "python_version": "3.12",
    "python_full_version": "3.12.1",
    "sys_platform": "emscripten",
    "platform_system": "Emscripten",
    "platform_machine": "wasm32",
    "os_name": "posix",
    "implementation_name": "cpython",
    "implementation_version": "3.12.1",
    "platform_python_implementation": "CPython",
}

MARKER_KEYWORDS = {"or", "and", "not", "in"}


def _marker_error(marker, why):
    raise ValueError("无法判断的环境标记 %s（%s）" % (json.dumps(marker, ensure_ascii=True), why))


def _tokenize_marker(marker):
    tokens = []
    i = 0
    while i < len(marker):
        c = marker[i]
        if c.isspace():
            i += 1
            continue
        if c in "()":
            tokens.append({"t": c})
            i += 1
            continue
        if c in "\"'":
            j = i + 1
            while j < len(marker) and marker[j] != c:
                j += 1
            if j >= len(marker):
                _marker_error(marker, "字符串未闭合")
            tokens.append({"t": "str", "v": marker[i + 1:j]})
            i = j + 1
            continue
        two = marker[i:i + 2]
        if two in ("==", "!=", "<=", ">=", "~=", "==="):
            tokens.append({"t": "op", "v": two})
            i += 2
            continue
        if c in "<>":
            tokens.append({"t": "op", "v": c})
            i += 1
            continue
        if re.fullmatch(r"[A-Za-z0-9_.]", c):
            j = i
            while j < len(marker) and re.fullmatch(r"[A-Za-z0-9_.]", marker[j]):
                j += 1
            word = marker[i:j]
            if word in MARKER_KEYWORDS:
                tokens.append({"t": word})
            elif re.fullmatch(r"[0-9][0-9._*]*", word):
                tokens.append({"t": "str", "v": word})  # bare numeric value
            else:
                tokens.append({"t": "word", "v": word})
            i = j
            continue
        _marker_error(marker, "位置 %d 附近有无法识别的字符 %s"
                      % (i, json.dumps(c, ensure_ascii=True)))
    return tokens


def marker_references_extra(marker) -> bool:
    return any(tok["t"] == "word" and tok["v"] == "extra" for tok in _tokenize_marker(marker))


def _version_segments(v):
    v = re.sub(r"\*$", "", str(v))
    return [int(s) if re.fullmatch(r"\d+", s) else s for s in v.split(".")]


def _compare_versions(a, b):
    as_ = _version_segments(a)
    bs = _version_segments(b)
    length = max(len(as_), len(bs))
    for i in range(length):
        x = as_[i] if i < len(as_) else 0
        y = bs[i] if i < len(bs) else 0
        if x == y:
            continue
        numeric = isinstance(x, (int, float)) and isinstance(y, (int, float))
        return -1 if (x - y if numeric else (-1 if str(x) < str(y) else 1)) < 0 else 1
    return 0


_WILDCARD_RE = re.compile(r"^\d+(?:\.\d+)*\.\*$")


def _version_matches_wildcard(v, wildcard):
    prefix = _version_segments(wildcard[:-2])
    segs = _version_segments(v)
    if len(segs) < len(prefix):
        return False
    return json.dumps(segs[:len(prefix)]) == json.dumps(prefix)


_VERSION_VARS = ("python_version", "python_full_version", "implementation_version")


def _marker_compare(op, left, right, left_is_version, right_is_version):
    if op == "in":
        return str(left) in str(right)
    if op == "not in":
        return str(left) not in str(right)
    if op == "===":
        return str(left) == str(right)
    if left_is_version or right_is_version:
        wildcard_left = isinstance(left, str) and _WILDCARD_RE.fullmatch(left) is not None
        wildcard_right = isinstance(right, str) and _WILDCARD_RE.fullmatch(right) is not None
        if op == "==":
            if wildcard_right:
                return _version_matches_wildcard(left, right)
            if wildcard_left:
                return _version_matches_wildcard(right, left)
            return _compare_versions(left, right) == 0
        if op == "!=":
            if wildcard_right:
                return not _version_matches_wildcard(left, right)
            if wildcard_left:
                return not _version_matches_wildcard(right, left)
            return _compare_versions(left, right) != 0
        if wildcard_left or wildcard_right:
            raise ValueError("版本序运算符不支持通配符版本串（== / != 除外）")
        c = _compare_versions(left, right)
        return {"<": c < 0, "<=": c <= 0, ">": c > 0, ">=": c >= 0}.get(op, False) \
            if op in ("<", "<=", ">", ">=") else _compatible_release(left, right, op)
    s, t = str(left), str(right)
    return {"==": s == t, "!=": s != t, "<": s < t, "<=": s <= t,
            ">": s > t, ">=": s >= t}.get(op, False)


def _compatible_release(left, right, op):
    if op != "~=":
        raise ValueError("未知运算符 %s" % json.dumps(op, ensure_ascii=True))
    w_segs = _version_segments(str(right))
    if len(w_segs) < 2:
        raise ValueError("~= 至少需要两段版本号: %s" % json.dumps(right, ensure_ascii=True))
    return (_compare_versions(left, right) >= 0
            and json.dumps(_version_segments(left)[:len(w_segs) - 1])
            == json.dumps(w_segs[:len(w_segs) - 1]))


def evaluate_marker(marker) -> bool:
    tokens = _tokenize_marker(marker)
    pos = 0

    def peek():
        return tokens[pos] if pos < len(tokens) else None

    def is_version_var(v):
        return v in _VERSION_VARS

    def parse_or():
        v = parse_and()
        while peek() is not None and peek()["t"] == "or":
            pos_pos()
            v = parse_and() or v
        return v

    def pos_pos():
        nonlocal pos
        pos += 1

    def parse_and():
        v = parse_not()
        while peek() is not None and peek()["t"] == "and":
            pos_pos()
            v = parse_not() and v
        return v

    def parse_not():
        if peek() is not None and peek()["t"] == "not":
            pos_pos()
            return not parse_not()
        return parse_atom()

    def operand():
        tok = peek()
        if tok is None:
            _marker_error(marker, "表达式意外结束")
        if tok["t"] == "str":
            pos_pos()
            return tok["v"]
        if tok["t"] == "word":
            pos_pos()
            if tok["v"] not in MARKER_ENV:
                _marker_error(marker, "变量 \"%s\" 不在 Pyodide worker 环境清单里" % tok["v"])
            return MARKER_ENV[tok["v"]]
        _marker_error(marker, "期望变量或字符串，得到 %s" % json.dumps(tok, ensure_ascii=True))

    def parse_atom():
        nonlocal pos
        if peek() is not None and peek()["t"] == "(":
            pos_pos()
            v = parse_or()
            if peek() is None or peek()["t"] != ")":
                _marker_error(marker, "缺少右括号")
            pos_pos()
            return v
        save = pos
        left_tok = peek()
        left = operand()
        tok = peek()
        if tok is not None and tok["t"] == "op":
            pos_pos()
            right_tok = peek()
            right = operand()
            return _marker_compare(
                tok["v"], left, right,
                left_tok["t"] == "word" and is_version_var(left_tok["v"]),
                right_tok is not None and right_tok["t"] == "word"
                and is_version_var(right_tok["v"]))
        if tok is not None and tok["t"] == "in":
            pos_pos()
            return str(left) in str(operand())
        if (tok is not None and tok["t"] == "not" and pos + 1 < len(tokens)
                and tokens[pos + 1]["t"] == "in"):
            pos_pos()
            pos_pos()
            return str(left) not in str(operand())
        pos = save
        _marker_error(marker, "缺少比较运算符")

    result = parse_or()
    if pos != len(tokens):
        _marker_error(marker, "有多余的尾随内容")
    return result


# ---------- vendor/wheels.json ----------

def find_repo_root(project_dir):
    """Walk up from project_dir to the directory holding vendor/wheels.json."""
    p = os.path.abspath(project_dir)
    while True:
        candidate = os.path.join(p, "vendor", "wheels.json")
        if os.path.isfile(candidate):
            return p
        parent = os.path.dirname(p)
        if parent == p:
            return None
        p = parent


def load_vendor_entries(repo_root):
    with open(os.path.join(repo_root, "vendor", "wheels.json"), "rb") as f:
        entries = json.loads(f.read().decode("utf-8"))
    if not isinstance(entries, list):
        raise ValueError("vendor/wheels.json 顶层必须是数组")
    out = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        if entry.get("source") != "local":
            out.append(entry)
            continue
        # source "local": derive the wheel bytes from the source tree —
        # the entry's filename/sha256 must already match the committed
        # wheel (checked by checkVendorConsistency); rebuild equality is
        # the source check (check.mjs / XC6).
        out.append(entry)
    return out


# ---------- rules 3 / 4 / 5 for one capability directory ----------

_PEP508_NAME_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?")


def _parse_requirement(raw):
    semi = raw.find(";")
    req = (raw[:semi] if semi >= 0 else raw).strip()
    m = _PEP508_NAME_RE.match(req)
    if not m:
        return None
    return {"name": m.group(0), "marker": (raw[semi + 1:].strip() if semi >= 0 else None)}


def _read_local_plugin_wheel(project_dir, plugin_id):
    manifest_path = os.path.join(project_dir, "plugins", plugin_id, "plugin.json")
    if not os.path.isfile(manifest_path):
        return None
    try:
        with open(manifest_path, "rb") as f:
            manifest = json.loads(f.read().decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as e:
        raise ValueError("plugins/%s/plugin.json 不是合法 JSON: %s" % (plugin_id, e))
    artifacts = manifest.get("artifacts") if isinstance(manifest, dict) else None
    if not isinstance(artifacts, list) or len(artifacts) != 1 \
            or not isinstance(artifacts[0], dict) \
            or not isinstance(artifacts[0].get("path"), str):
        raise ValueError("plugins/%s/plugin.json 必须恰好声明一个 artifacts 项" % plugin_id)
    wheel_path = os.path.join(project_dir, "plugins", plugin_id, artifacts[0]["path"])
    with open(wheel_path, "rb") as f:
        return {"filename": os.path.basename(wheel_path), "bytes": f.read()}


def check_capability_wheel_rules(repo_root, project_dir):
    """Rules 3/4/5 for the py- plugins declared in project_dir's capability.json.

    Returns [{code, path, message}] (empty = pass).
    """
    errors = []
    manifest_path = os.path.join(project_dir, "capability.json")
    try:
        with open(manifest_path, "rb") as f:
            capability = json.loads(f.read().decode("utf-8")).get("capability")
    except (OSError, ValueError, UnicodeDecodeError) as e:
        return [{"code": "wheel-capability-unreadable", "path": "capability.json",
                 "message": "%s: 读取 capability.json 失败: %s" % (project_dir, e)}]
    plugins = capability.get("plugins") if isinstance(capability, dict) else None
    if not isinstance(plugins, list):
        plugins = []

    vendor_by_id = None

    def resolve_vendor(pid):
        nonlocal vendor_by_id
        if vendor_by_id is None:
            entries = load_vendor_entries(repo_root) if repo_root else []
            vendor_by_id = {e["id"]: e for e in entries if isinstance(e, dict) and "id" in e}
        return vendor_by_id.get(pid)

    resolved = []
    for index, pid in enumerate(plugins):
        if not isinstance(pid, str) or not pid.startswith("py-"):
            continue  # 非 python wheel plugin 不在本检查范围
        dist = normalize_dist_name(pid[len("py-"):])
        if PLUGIN_ID_RE.fullmatch(pid) is None:
            errors.append({"code": "wheel-id-invalid", "path": pid,
                           "message": "%s: plugin id 不符合组件 id 规则（小写字母数字与 ._-）" % pid})
        if dist in RUNTIME_PREINSTALLED_PACKAGES:
            errors.append({"code": "wheel-shadow-preinstalled", "path": pid,
                           "message": "%s: 遮盖 runtime 预装包 \"%s\"（D13 第 2 条：能力不得"
                                      "携带 runtime 已预装的包）" % (pid, dist)})
        filename = None
        data = None
        local = None
        try:
            local = _read_local_plugin_wheel(project_dir, pid)
        except (OSError, ValueError) as e:
            errors.append({"code": "wheel-unresolvable", "path": pid,
                           "message": "%s: 读取 wheel 失败: %s" % (pid, e)})
        if local is not None:
            filename, data = local["filename"], local["bytes"]
        else:
            entry = resolve_vendor(pid)
            if entry is not None:
                filename = entry["filename"]
                wheel_path = os.path.join(repo_root, "vendor", "wheels", entry["filename"])
                try:
                    with open(wheel_path, "rb") as f:
                        data = f.read()
                except OSError as e:
                    errors.append({"code": "wheel-unresolvable", "path": pid,
                                   "message": "%s: 读取 wheel 失败: %s" % (pid, e)})
            else:
                errors.append({
                    "code": "wheel-unresolvable", "path": pid,
                    "message": "%s: vendor/wheels.json 里没有这个 id，能力目录下也没有 "
                               "plugins/%s/（py- 插件只能来自 vendor 或能力自带的 plugins/ 目录）"
                               % (pid, pid)})
        if filename is not None and not wheel_platform_compatible(filename)["ok"]:
            errors.append({
                "code": "wheel-platform-incompatible", "path": pid,
                "message": "%s: wheel %s 的平台标签不兼容（需要 *-none-any 或 cp312 + "
                           "pyodide_2024_0_wasm32）" % (pid, filename)})
        resolved.append({"id": pid, "index": index, "filename": filename, "bytes": data})

    for r in resolved:
        if r["bytes"] is None:
            continue  # 解析失败的上面已经报错
        try:
            metadata_text = read_wheel_metadata(r["bytes"])
        except ValueError as e:
            errors.append({"code": "wheel-metadata-unreadable", "path": r["id"],
                           "message": "%s: 读取 wheel %s 的 METADATA 失败: %s"
                                      % (r["id"], r["filename"], e)})
            continue
        for raw in wheel_requires_dist(metadata_text):
            req = _parse_requirement(raw)
            if req is None:
                errors.append({"code": "wheel-requires-unparseable", "path": r["id"],
                               "message": "%s: 无法解析的 Requires-Dist \"%s\"（wheel %s）"
                                          % (r["id"], raw, r["filename"])})
                continue
            if req["marker"] and marker_references_extra(req["marker"]):
                continue
            holds = None
            if req["marker"]:
                try:
                    holds = evaluate_marker(req["marker"])
                except ValueError as e:
                    errors.append({
                        "code": "wheel-marker-undecidable", "path": r["id"],
                        "message": "%s: 环境标记无法判断 — %s（Requires-Dist \"%s\"，wheel %s）"
                                   % (r["id"], e, raw, r["filename"])})
                    continue
                if not holds:
                    continue
            dep_dist = normalize_dist_name(req["name"])
            if dep_dist in RUNTIME_PREINSTALLED_PACKAGES:
                continue  # runtime 预装，无需自带
            provider_id = plugin_id_for_dist(dep_dist)
            if provider_id not in plugins:
                errors.append({
                    "code": "wheel-dependency-missing", "path": r["id"],
                    "message": "%s: 缺少依赖 \"%s\" — 应以 plugin \"%s\" 的形式提供在 "
                               "plugins 列表中，且排在依赖它的 \"%s\" 之前（Requires-Dist "
                               "\"%s\"，wheel %s）"
                               % (r["id"], req["name"], provider_id, r["id"], raw, r["filename"])})
            elif plugins.index(provider_id) >= r["index"]:
                provider_index = plugins.index(provider_id)
                errors.append({
                    "code": "wheel-dependency-order", "path": r["id"],
                    "message": "%s: 依赖顺序错误 — \"%s\" 由 \"%s\"（plugins[%d]）提供，"
                               "但它必须排在依赖它的 \"%s\"（plugins[%d]）之前"
                               % (r["id"], req["name"], provider_id, provider_index,
                                  r["id"], r["index"])})
    return errors
