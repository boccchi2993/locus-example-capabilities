# ============================================================
#  locus_capability_sdk — the Locus capability authoring SDK.
#
#  Pure Python 3.12 standard library. Byte-identical to the JS
#  packaging pipeline (locus-product locked at bc7114d5fa69569b43f8b4b
#  3c24545de909760b8 + this repository's scripts/*.mjs), pinned by the
#  cross-check in tests/sdk-crosscheck.test.mjs:
#
#    sdk.validate(project_dir)  -> [{code, path, message}]  ([] = pass)
#    sdk.build_wheel(src_dir, dist, version, out_dir, summary="")
#    sdk.build(project_dir, out_dir) -> {ok, path|diagnostics, sha256, bytes}
#    sdk.inspect(locus_path)    -> product-import-style summary
#
#  .locus archives are STORE-ONLY (method 0, the 2026-10-28 owner
#  decision): deterministic on every engine, no deflate involved.
#
#  Like the JS builder, files in the project directory that the
#  package does not declare (src/, tests/, README.md, locus.json,
#  ...) are silently ignored — never read, never packaged, never a
#  diagnostic.
# ============================================================

import json
import os

from ._archive import (
    LOCUS_LIMITS,
    LOCUS_MD_NAME,
    build_files_list,
    expected_package_paths,
    manifest_digest,
    parse_locus_md,
    read_locus_archive,
    render_locus_md,
    repin_manifest,
    verify_locus_files,
    write_locus_archive,
)
from ._canon import canonical_json, sha256_hex
from ._project import (
    FsWorkspace,
    MemWorkspace,
    build_project,
    validate_project,
)
from ._skillspec import check_skill_specs
from ._version import __version__
from ._wheel import build_wheel as _build_wheel
from ._wheelrules import (
    check_capability_wheel_rules,
    find_repo_root,
    load_vendor_entries,
)

LOCUS_JSON_NAME = "locus.json"  # 能力目录的元文件，不进包


class SdkError(Exception):
    """Fatal SDK usage faults (mirrors the JS build.mjs thrown Errors)."""


def _diagnostic(code, path, message):
    return {"code": code, "path": path, "message": message}


def validate(project_dir, repo_root=None):
    """Validate a capability project directory.

    Returns a diagnostic list [{code, path, message}]; an empty list
    means the project passes. Covers:
      - the product project validation (validateProject / buildProject
        rules, codes package_*),
      - the D13 wheel rules (platform tags, runtime shadowing,
        dependency order — codes wheel-*),
      - the skill spec rules (codes literal-key / undeclared-variable /
        url-outside-prefix, identical to scripts/skill-spec.mjs).
    Diagnostic ORDER mirrors the JS (path, code, message).
    """
    project_dir = os.path.abspath(project_dir)
    repo_root = find_repo_root(project_dir) if repo_root is None else os.path.abspath(repo_root)
    diagnostics = []

    for d in check_capability_wheel_rules(repo_root, project_dir):
        diagnostics.append(d)
    for d in check_skill_specs(project_dir):
        diagnostics.append(d)

    # Judge the project AS THE BUILD PIPELINE SEES IT: vendor plugins
    # materialized into the in-memory workspace (scripts/build.mjs's
    # materializeVendorPlugins), so a py- id that only exists in vendor
    # validates instead of reporting package_ref_missing. A missing
    # capability.json is left to the project rules to report.
    files = {}
    if os.path.isfile(os.path.join(project_dir, "capability.json")):
        files = _collect_package_files(project_dir)
        if repo_root:
            try:
                _materialize_vendor_plugins(project_dir, files, repo_root)
            except (OSError, ValueError):
                pass  # malformed vendor data — the project rules below will flag it

    validation = validate_project(MemWorkspace(files), "")
    diagnostics.extend(validation["diagnostics"])
    return sort_public(diagnostics)


def sort_public(diagnostics):
    seen = set()
    out = []
    for d in diagnostics:
        key = (d.get("path") or "", d["code"], d["message"])
        if key in seen:
            continue
        seen.add(key)
        out.append(d)
    out.sort(key=lambda d: (d.get("path") or "", d["code"], d["message"]))
    return out


def build_wheel(src_dir, dist, version, out_dir, summary=""):
    """Deterministic pure-Python wheel; returns the output path. See _wheel."""
    return _build_wheel(src_dir, dist, version, out_dir, summary)


def _read_locus_json(source_dir):
    with open(os.path.join(source_dir, LOCUS_JSON_NAME), "rb") as f:
        meta = json.loads(f.read().decode("utf-8"))
    for field in ("title", "author", "purpose"):
        if not isinstance(meta.get(field), str) or not meta[field]:
            raise SdkError("%s: %s 缺少字符串字段 \"%s\"" % (source_dir, LOCUS_JSON_NAME, field))
    changelog = meta.get("changelog")
    if (not isinstance(changelog, list) or not changelog
            or any(not isinstance(entry, str) or not entry for entry in changelog)):
        raise SdkError('%s: %s 的 "changelog" 必须是非空字符串数组' % (source_dir, LOCUS_JSON_NAME))
    if len(meta["author"]) > 200:
        raise SdkError("%s: author 超过 200 字符上限" % source_dir)
    if len(meta["purpose"]) > 2000:
        raise SdkError("%s: purpose 超过 2000 字符上限" % source_dir)
    return meta


def _render_locus_body(meta):
    lines = []
    lines.append("# " + meta["title"])
    lines.append("")
    lines.append(meta["purpose"])
    lines.append("")
    lines.append("## 更改记录")
    lines.append("")
    for entry in meta["changelog"]:
        lines.append("- " + entry)
    lines.append("")
    return "\n".join(lines)


def _collect_package_files(source_dir):
    """Every file in the capability directory except locus.json, POSIX-keyed."""
    files = {}

    def walk(rel):
        directory = os.path.join(source_dir, rel.replace("/", os.sep)) if rel else source_dir
        for entry in sorted(os.scandir(directory), key=lambda e: e.name):
            rel_posix = (rel + "/" + entry.name) if rel else entry.name
            if entry.is_symlink():
                continue
            if entry.is_dir(follow_symlinks=False):
                walk(rel_posix)
            elif entry.is_file(follow_symlinks=False):
                if not rel and entry.name == LOCUS_JSON_NAME:
                    continue  # 元文件不进包
                with open(entry.path, "rb") as f:
                    files[rel_posix] = f.read()

    walk("")
    return files


def _vendor_plugin_manifest(entry):
    return {
        "schemaVersion": 1,
        "plugin": {
            "id": entry["id"],
            "version": entry["version"],
            "displayName": entry["displayName"],
            "description": entry["description"],
            "runtime": "python",
            "authority": "none",
            "provides": {"pythonImports": list(entry["imports"])},
        },
        "artifacts": [{"path": "artifacts/" + entry["filename"], "format": "python-wheel"}],
    }


def _materialize_vendor_plugins(source_dir, files, repo_root):
    """py- ids without a local plugins/<id>/ come from vendor/wheels.json."""
    with open(os.path.join(source_dir, "capability.json"), "rb") as f:
        capability = json.loads(f.read().decode("utf-8"))
    declared = capability.get("capability", {}).get("plugins") \
        if isinstance(capability.get("capability"), dict) else None
    declared = declared if isinstance(declared, list) else []
    py_ids = [p for p in declared if isinstance(p, str) and p.startswith("py-")]
    if not py_ids:
        return
    entries = load_vendor_entries(repo_root)
    by_id = {e["id"]: e for e in entries}
    for pid in py_ids:
        manifest_rel = "plugins/%s/plugin.json" % pid
        if manifest_rel in files:
            continue  # 自研 plugin 优先
        entry = by_id.get(pid)
        if entry is None:
            continue  # 交由 buildProject 以 package_ref_missing 拒绝
        files[manifest_rel] = (
            json.dumps(_vendor_plugin_manifest(entry), ensure_ascii=False, indent=2) + "\n"
        ).encode("utf-8")
        wheel_rel = "plugins/%s/artifacts/%s" % (pid, entry["filename"])
        with open(os.path.join(repo_root, "vendor", "wheels", entry["filename"]), "rb") as f:
            files[wheel_rel] = f.read()


def build(project_dir, out_dir, repo_root=None):
    """Validate, then build <id>-<version>.locus into out_dir.

    Returns {ok, path, sha256, bytes} on success; on validation failure
    {ok: False, diagnostics} with NO output file. locus.json problems
    raise SdkError (same as the JS build.mjs).
    """
    source_dir = os.path.abspath(project_dir)
    out_dir = os.path.abspath(out_dir)
    repo_root = find_repo_root(source_dir) if repo_root is None else os.path.abspath(repo_root)

    if not os.path.isfile(os.path.join(source_dir, "capability.json")):
        raise SdkError("%s: 缺少 capability.json，不是一个能力目录" % source_dir)
    meta = _read_locus_json(source_dir)

    files = _collect_package_files(source_dir)
    if repo_root:
        _materialize_vendor_plugins(source_dir, files, repo_root)

    workspace = MemWorkspace(files)
    built = build_project(workspace, "")
    if not built["ok"]:
        return {"ok": False,
                "diagnostics": [
                    {"code": d["code"], "path": d["path"], "message": d["message"]}
                    for d in built["diagnostics"]],
                "path": None, "sha256": None, "bytes": None}
    lock = built["bundle"]["lock"]

    package_files = {rel: workspace.read_bytes(rel) for rel in expected_package_paths(lock)}

    manifest = repin_manifest({
        "schemaVersion": 1,
        "id": lock["capability"]["id"],
        "version": lock["capability"]["version"],
        "author": meta["author"],
        "purpose": meta["purpose"],
    }, package_files)

    locus_md = render_locus_md(_render_locus_body(meta), manifest)
    data = write_locus_archive(package_files, locus_md)

    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "%s-%s.locus" % (manifest["id"], manifest["version"]))
    with open(out_path, "wb") as f:
        f.write(data)
    return {"ok": True, "diagnostics": [], "path": out_path,
            "sha256": sha256_hex(data), "bytes": len(data)}


def inspect(locus_path):
    """Import-style summary of a .locus (mirrors product analyze/inspect).

    Returns {ok, diagnostics, id, version, author, purpose, body, digest,
    mismatched, components: {plugins, skills, mcps} (each [{id, displayName}]),
    credentials, fileCount, totalBytes}.
    """
    with open(locus_path, "rb") as f:
        data = f.read()
    return inspect_bytes(data)


def inspect_bytes(data):
    result = _analyze(data)
    if not result["ok"]:
        return {
            "ok": False,
            "diagnostics": result["diagnostics"],
            "id": None, "version": None, "author": None, "purpose": None,
            "body": None, "digest": None, "mismatched": [],
            "components": None, "credentials": None,
            "fileCount": None, "totalBytes": None,
        }
    files = result["files"]
    manifest = result["manifest"]
    lock = result["lock"]
    return {
        "ok": True,
        "diagnostics": [],
        "id": manifest["id"],
        "version": manifest["version"],
        "author": manifest["author"],
        "purpose": manifest["purpose"],
        "body": result["body"],
        "digest": manifest_digest(manifest),
        "mismatched": result["mismatched"],
        "components": {
            "plugins": [{"id": p["descriptor"]["id"], "displayName": p["descriptor"]["displayName"]}
                        for p in lock["plugins"]],
            "skills": [{"id": s["descriptor"]["id"], "displayName": s["descriptor"]["displayName"]}
                       for s in lock["skills"]],
            "mcps": [{"id": m["id"], "displayName": m["displayName"]} for m in lock["mcps"]],
        },
        "credentials": lock["capability"].get("credentials", []),
        "fileCount": len(files),
        "totalBytes": sum(len(b) for b in files.values()),
    }


def _analyze(data):
    """product analyze() port: read → parse → verify → build → wheel checks."""
    read = read_locus_archive(data)
    if not read["ok"]:
        return {"ok": False, "diagnostics": read["diagnostics"]}
    parsed = parse_locus_md(read["locusMd"])
    if not parsed["ok"]:
        return {"ok": False, "diagnostics": parsed["diagnostics"]}
    manifest = parsed["manifest"]
    files = read["files"]

    verification = verify_locus_files(manifest, files)
    if verification["missing"] or verification["extra"]:
        parts = []
        if verification["missing"]:
            parts.append("missing: " + ", ".join(verification["missing"]))
        if verification["extra"]:
            parts.append("unexpected: " + ", ".join(verification["extra"]))
        return {"ok": False, "diagnostics": [_diagnostic(
            "capability_closed_list", "",
            "the archive does not match its closed file list (" + "; ".join(parts) + ")")]}
    mismatched = [m["path"] for m in verification["mismatched"]]

    workspace = MemWorkspace(files)
    built = build_project(workspace, "")
    if not built["ok"]:
        detail = "; ".join(
            d["code"] + ((" at " + d["path"]) if d["path"] else "")
            for d in built["diagnostics"])
        return {"ok": False, "diagnostics": [_diagnostic(
            "capability_build", "",
            "project build failed: " + detail)]}
    lock = built["bundle"]["lock"]

    expected = expected_package_paths(lock)
    actual = sorted(files.keys())
    if expected != actual:
        return {"ok": False, "diagnostics": [_diagnostic(
            "capability_unexpected_files", "",
            "archive files do not equal the package’s closed runtime set (expected %d files, "
            "archive holds %d)" % (len(expected), len(actual)))]}
    if manifest["id"] != lock["capability"]["id"] \
            or manifest["version"] != lock["capability"]["version"]:
        return {"ok": False, "diagnostics": [_diagnostic(
            "capability_identity", "",
            "manifest identity %s does not match capability.json %s"
            % (json.dumps(manifest["id"] + "@" + manifest["version"]),
               json.dumps(lock["capability"]["id"] + "@" + lock["capability"]["version"])))]}

    # D13 §2/§3 wheel import checks (product analyze(): the single
    # artifact per plugin must be pure-python or ABI-compatible, and
    # must not shadow a runtime-preinstalled distribution).
    from ._wheelrules import (
        RUNTIME_PREINSTALLED_PACKAGES,
        normalize_dist_name,
        wheel_platform_compatible,
    )
    wheel_diagnostics = []
    for p in lock["plugins"]:
        if not p["artifacts"]:
            continue
        a = p["artifacts"][0]
        filename = a["path"].split("/")[-1]
        if not filename.endswith("-none-any.whl"):
            plat = wheel_platform_compatible(filename)
            if not plat["ok"]:
                wheel_diagnostics.append(_diagnostic(
                    "capability_wheel_platform", a["path"], plat["reason"]))
        dash = filename.find("-")
        dist = normalize_dist_name(filename[:dash]) if dash > 0 else None
        if dist and dist in RUNTIME_PREINSTALLED_PACKAGES:
            wheel_diagnostics.append(_diagnostic(
                "capability_wheel_shadows_runtime", a["path"],
                "the wheel installs %s, but the runtime already provides it "
                "(a capability package must not carry a runtime-preloaded distribution)" % dist))
    if wheel_diagnostics:
        return {"ok": False, "diagnostics": wheel_diagnostics}

    return {"ok": True, "files": files, "manifest": manifest, "body": parsed["body"],
            "mismatched": mismatched, "lock": lock}
