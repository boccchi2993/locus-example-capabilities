# ============================================================
#  locus_capability_sdk._wheeltools — D14 第三方 wheel 工具。
#
#  模型在 Locus 里用 bash `curl -o` 下载第三方 wheel 后（D14 第 1 条），
#  来源核实、依赖闭包与顺序检查、打包前的可导入性测试都发生在
#  capability-authoring 侧（D14 第 3 条）——本模块就是这些职责的 SDK
#  实现，只依赖标准库、完全离线：
#
#    wheel_info(path)                 wheel 文件的全部要点（离线读取）
#    verify_wheel(wheel, metadata)    与发布方元数据逐字节核对 sha256
#    plugin_from_wheel(project, whl)  规范描述符 plugins/py-<名>/plugin.json
#    test_site(wheels, site)          解压进非挂载点目录并插到 sys.path 最前
#
#  描述符规范化（D14 第 5 条：同 id 的插件要跨能力共享，描述符与 wheel
#  必须逐字节相同）：displayName = METADATA Name 原样、description =
#  METADATA Summary 去首尾空白（空则 "<Name> <Version>"）、
#  provides.pythonImports 从 RECORD 推导（顶层包目录 + 顶层 .py 模块）。
#  同一个 wheel 因此总是生成逐字节相同的 plugin.json；JS 侧的
#  scripts/vendor.mjs vendorPluginManifest 用同一规则从 wheel 字节推导，
#  由 tests/sdk-crosscheck.test.mjs XC7 强制两边逐字节一致。
# ============================================================

import io
import json
import os
import sys
import zipfile

from ._canon import sha256_hex
from ._wheelrules import (
    WHEEL_SIZE_LIMIT_BYTES,
    normalize_dist_name,
    parse_wheel_filename,
    plugin_id_for_dist,
    read_wheel_metadata,
    read_wheel_record,
    wheel_metadata_fields,
    wheel_platform_compatible,
    wheel_requires_dist,
    wheel_top_level_imports,
)

PYODIDE_LOCK_VERSION = "0.26.4"  # 与 vendor/pyodide-lock-0.26.4.json 一致

# runtime worker 的数据挂载点（locus-runtime vfs.js MANAGED_ROOTS 一字不差：
# /mnt/workspace、/mnt/upload、/mnt/download 挂在 /mnt 下，另有 /home/locus
# 与 /tmp）。/mnt 整个拒绝——将来新增挂载也在 /mnt 下。解压进这些目录会把
# 文件镜像进 Python 视图（同步报告、SPIKE-SYNC 实验证实的干扰源），test_site
# 一律拒绝；/opt/locus-site 这类不属于任何挂载点的路径才允许。
DATA_MOUNT_ROOTS = ("/tmp", "/home/locus", "/mnt")


def _sdk_error(message):
    from . import SdkError
    raise SdkError(message)


# ---------- wheel_info ----------


def wheel_info(path):
    """Everything worth knowing about a wheel file, read offline.

    Returns {filename, name, normalized, version, summary,
    tags: {python, abi, platform}, pure, platform_ok, requires, imports,
    bytes, sha256}. name/summary come from METADATA; tags from the wheel
    filename; imports from RECORD (top-level packages/modules); requires
    is the raw Requires-Dist list.
    """
    with open(path, "rb") as f:
        data = f.read()
    filename = os.path.basename(path)
    metadata_text = read_wheel_metadata(data)
    metadata_fields = wheel_metadata_fields(metadata_text)
    parsed = parse_wheel_filename(filename)
    pure = bool(parsed and parsed["abi"] == "none" and parsed["platform"] == "any")
    return {
        "filename": filename,
        "name": metadata_fields["name"],
        "normalized": normalize_dist_name(metadata_fields["name"]) if metadata_fields["name"] else None,
        "version": metadata_fields["version"],
        "summary": metadata_fields["summary"],
        "tags": {"python": parsed["python"] if parsed else None,
                 "abi": parsed["abi"] if parsed else None,
                 "platform": parsed["platform"] if parsed else None},
        "pure": pure,
        "platform_ok": wheel_platform_compatible(filename)["ok"],
        "requires": wheel_requires_dist(metadata_text),
        "imports": wheel_top_level_imports(read_wheel_record(data)),
        "bytes": len(data),
        "sha256": sha256_hex(data),
    }


# ---------- verify_wheel ----------


def _diagnostic(code, message):
    return {"code": code, "message": message}


def _is_sha256_hex(value):
    return isinstance(value, str) and len(value) == 64 \
        and all(c in "0123456789abcdef" for c in value)


def verify_wheel(wheel_path, metadata_path):
    """Compare the wheel's sha256 against publisher metadata, offline.

    metadata_path 是模型用 curl 下载的发布方元数据文件，两种格式都支持：
      - PyPI 版本 JSON（https://pypi.org/pypi/<name>/<version>/json）：
        在 urls[] 里按 filename 找条目，比对 digests.sha256；
      - pyodide-lock.json（Pyodide 官方 lock）：在 packages 里按 file_name
        找条目，比对 sha256，并核对 info.version 为 0.26.4。

    Returns {ok, source: "pypi" | "pyodide-lock" | None, filename,
    expected, actual, diagnostics: [{code, message}]}. 不联网；找不到
    条目、格式不认识、sha256 不符、lock 版本不对都给出明确诊断。
    """
    with open(wheel_path, "rb") as f:
        data = f.read()
    filename = os.path.basename(wheel_path)
    actual = sha256_hex(data)
    result = {"ok": False, "source": None, "filename": filename,
              "expected": None, "actual": actual, "diagnostics": []}

    with open(metadata_path, "rb") as f:
        raw = f.read().decode("utf-8")
    try:
        doc = json.loads(raw)
    except ValueError as e:
        result["diagnostics"].append(_diagnostic(
            "unknown-format", "元数据不是合法 JSON: %s" % e))
        return result

    if isinstance(doc, dict) and isinstance(doc.get("urls"), list):
        result["source"] = "pypi"
        hit = None
        for entry in doc["urls"]:
            if isinstance(entry, dict) and entry.get("filename") == filename:
                hit = entry
                break
        if hit is None:
            result["diagnostics"].append(_diagnostic(
                "entry-not-found",
                "PyPI 元数据的 urls[] 里没有文件 %s（元数据里共有 %d 个文件）"
                % (filename, len(doc["urls"]))))
            return result
        digests = hit.get("digests")
        expected = digests.get("sha256") if isinstance(digests, dict) else None
        if not _is_sha256_hex(expected):
            result["diagnostics"].append(_diagnostic(
                "missing-digest", "PyPI 元数据里 %s 没有 sha256 摘要" % filename))
            return result
        result["expected"] = expected
        if expected != actual:
            result["diagnostics"].append(_diagnostic(
                "sha256-mismatch",
                "sha256 不符: 元数据 %s，实际 %s" % (expected, actual)))
        result["ok"] = not result["diagnostics"]
        return result

    if isinstance(doc, dict) and isinstance(doc.get("packages"), dict):
        result["source"] = "pyodide-lock"
        info = doc.get("info")
        lock_version = info.get("version") if isinstance(info, dict) else None
        if lock_version != PYODIDE_LOCK_VERSION:
            result["diagnostics"].append(_diagnostic(
                "lock-version-unsupported",
                "pyodide-lock 的 info.version 是 %s，本 SDK 只认 %s（与 "
                "vendor/pyodide-lock-%s.json / runtime ABI 一致）"
                % (json.dumps(lock_version), PYODIDE_LOCK_VERSION, PYODIDE_LOCK_VERSION)))
        hit = None
        for entry in doc["packages"].values():
            if isinstance(entry, dict) and entry.get("file_name") == filename:
                hit = entry
                break
        if hit is None:
            result["diagnostics"].append(_diagnostic(
                "entry-not-found",
                "pyodide-lock 的 packages 里没有 file_name 为 %s 的条目" % filename))
            return result
        expected = hit.get("sha256")
        if not _is_sha256_hex(expected):
            result["diagnostics"].append(_diagnostic(
                "missing-digest", "pyodide-lock 里 %s 没有合法的 sha256 记录" % filename))
            return result
        result["expected"] = expected
        if expected != actual:
            result["diagnostics"].append(_diagnostic(
                "sha256-mismatch",
                "sha256 不符: lock 记录 %s，实际 %s" % (expected, actual)))
        result["ok"] = not result["diagnostics"]
        return result

    result["diagnostics"].append(_diagnostic(
        "unknown-format",
        "元数据格式不认识：既不是 PyPI 版本 JSON（缺少 urls 数组），也不是 "
        "pyodide-lock.json（缺少 packages 对象）"))
    return result


# ---------- plugin_from_wheel ----------


def canonical_plugin_descriptor(name, version, summary, imports, wheel_filename):
    """The canonical descriptor for a wheel, as a Python object.

    单一事实来源：displayName = METADATA Name 原样；description = Summary
    去首尾空白（空则 "<Name> <Version>"）；version = METADATA Version；
    provides.pythonImports = RECORD 推导的顶层名。runtime python、
    authority none、恰好一个 artifacts/<wheel 文件名>、format
    python-wheel（D13 第 1 条的包 v1 形状）。runtime/harness 的描述符
    校验器（validatePluginDescriptor）对 description / displayName 没有
    长度上限，唯一约束是 plugin.json 本身 ≤ 包层 MANIFEST_MAX_BYTES
    （256 KiB）——不做截断。
    """
    return {
        "schemaVersion": 1,
        "plugin": {
            "id": plugin_id_for_dist(name),
            "version": version,
            "displayName": name,
            "description": summary,
            "runtime": "python",
            "authority": "none",
            "provides": {"pythonImports": list(imports)},
        },
        "artifacts": [{"path": "artifacts/" + wheel_filename, "format": "python-wheel"}],
    }


def serialize_plugin_descriptor(descriptor):
    """Bytes of a plugin.json — 与本仓库现有 plugin.json 完全一致：
    UTF-8、ensure_ascii=False、2 空格缩进、键序即上面字面量的插入序、
    末尾一个换行。"""
    return (json.dumps(descriptor, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def plugin_from_wheel(project_dir, wheel_path):
    """Materialize the canonical descriptor for a wheel into a project.

    生成 plugins/py-<规范化发行名>/plugin.json 并把 wheel 复制到
    plugins/<id>/artifacts/<wheel 文件名>。幂等：同一个 wheel 重复调用
    生成逐字节相同的文件。若同 id 的 artifacts/ 下已有任何不同的文件
    （不同字节或不同文件名的 wheel），拒绝——那会产生描述符或字节不同
    的同 id 组件，D14 第 5 条下导入端会拒绝共存，SDK 提前拦住。
    返回 {id, path, descriptor}（path 是 plugin.json）。
    """
    project_dir = os.path.abspath(project_dir)
    with open(wheel_path, "rb") as f:
        data = f.read()
    filename = os.path.basename(wheel_path)
    fields = wheel_metadata_fields(read_wheel_metadata(data))
    if not fields["name"] or not fields["version"]:
        raise ValueError("wheel METADATA 缺少 Name 或 Version 头: %s" % filename)
    summary = fields["summary"] or ""
    if not summary:
        summary = "%s %s" % (fields["name"], fields["version"])
    descriptor = canonical_plugin_descriptor(
        fields["name"], fields["version"], summary,
        wheel_top_level_imports(read_wheel_record(data)), filename)

    pid = descriptor["plugin"]["id"]
    if normalize_dist_name(fields["name"]) != pid[len("py-"):]:
        # plugin_id_for_dist 只会因 name 为空串以外的病态输入偏离；防御性断言。
        raise ValueError("无法从 METADATA Name 推导 plugin id: %s" % fields["name"])

    plugin_dir = os.path.join(project_dir, "plugins", pid)
    artifacts_dir = os.path.join(plugin_dir, "artifacts")
    if os.path.isdir(artifacts_dir):
        for existing_name in sorted(os.listdir(artifacts_dir)):
            existing_path = os.path.join(artifacts_dir, existing_name)
            if not os.path.isfile(existing_path):
                continue
            with open(existing_path, "rb") as f:
                existing = f.read()
            if existing_name != filename or existing != data:
                _sdk_error(
                    "%s 已有同 id 但不同的 wheel（现有 artifacts/%s %d 字节，新 wheel "
                    "artifacts/%s %d 字节）——D14 第 5 条：同 plugin id 的组件要共存必须"
                    "描述符与 wheel 逐字节相同；请改用不同 plugin id 或先删除 plugins/%s/"
                    % (existing_path, existing_name, len(existing), filename, len(data), pid))

    os.makedirs(artifacts_dir, exist_ok=True)
    manifest_path = os.path.join(plugin_dir, "plugin.json")
    artifact_path = os.path.join(artifacts_dir, filename)
    with open(manifest_path, "wb") as f:
        f.write(serialize_plugin_descriptor(descriptor))
    with open(artifact_path, "wb") as f:
        f.write(data)
    return {"id": pid, "path": manifest_path, "descriptor": descriptor}


# ---------- test_site ----------


def _check_site_mount(site):
    normalized = str(site).replace("\\", "/")
    if not normalized.startswith("/"):
        _sdk_error(
            "test_site: site 必须是绝对 POSIX 路径，得到 %s" % json.dumps(site))
    for root in DATA_MOUNT_ROOTS:
        if normalized == root or normalized.startswith(root + "/"):
            _sdk_error(
                "test_site: site %s 在数据挂载点 %s 下——解压进数据挂载点会把文件"
                "镜像进 Python 视图（同步报告与镜像上限干扰测试）。请用不属于任何"
                "数据挂载点的目录，如 /opt/locus-site" % (json.dumps(site), root))


def test_site(wheel_paths, site="/opt/locus-site", allow_unsafe_site_for_tests=False):
    """Extract wheels into a scratch site dir and put it on sys.path.

    把各 wheel 解压进 site（zipfile 逐条目安全解压，拒绝绝对路径与
    “..”成员），然后插到 sys.path 最前（已在则不重复插）——之后同一
    worker 内可直接 import 这些 wheel 的顶层模块，用于打包前的可导入性
    测试。已解压过相同字节的 wheel 跳过：site 下写
    .locus-installed/<sha256> 标记。返回 {site, installed, skipped}
    （installed/sked 项是 wheel 基本文件名，按传入顺序）。

    约束（docstring 即契约）：
      - site 必须不在任何数据挂载点下：/tmp、/home/locus、/mnt/... 都
        不行，传入这些路径直接报错（SdkError）。默认 /opt/locus-site。
      - worker 重启后解压出的文件消失，需要重新调用本函数。
      - 只用于打包前的测试，不影响打包结果：能力包的 wheel 仍由
        plugins/ 与 vendor 提供。

    allow_unsafe_site_for_tests=True 跳过挂载点检查——只给 SDK 自己的
    测试用（在普通 CPython 上用系统临时目录验证行为），能力创作时禁止
    使用。
    """
    if not allow_unsafe_site_for_tests:
        _check_site_mount(site)
    if isinstance(wheel_paths, str):
        wheel_paths = [wheel_paths]
    site = str(site)
    marker_dir = os.path.join(site, ".locus-installed")
    os.makedirs(marker_dir, exist_ok=True)

    installed = []
    skipped = []
    for wheel_path in wheel_paths:
        with open(wheel_path, "rb") as f:
            data = f.read()
        filename = os.path.basename(wheel_path)
        marker = os.path.join(marker_dir, sha256_hex(data))
        if os.path.exists(marker):
            skipped.append(filename)
            continue
        site_real = os.path.realpath(site)
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            for member in zf.infolist():
                member_name = member.filename.replace("\\", "/")
                if member_name.startswith("/") or ".." in member_name.split("/"):
                    raise ValueError(
                        "wheel %s 有不安全的 zip 成员 %s（绝对路径或 ..）"
                        % (filename, member.filename))
                if member_name.endswith("/"):
                    continue
                target = os.path.join(site, member_name)
                if os.path.realpath(target) != site_real \
                        and not os.path.realpath(target).startswith(site_real + os.sep):
                    raise ValueError(
                        "wheel %s 的成员 %s 解压后越出 site 目录"
                        % (filename, member.filename))
                zf.extract(member, site)
        with open(marker, "wb") as f:
            f.write(b"")
        installed.append(filename)

    if site not in sys.path:
        sys.path.insert(0, site)
    return {"site": site, "installed": installed, "skipped": skipped}
