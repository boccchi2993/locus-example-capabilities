# ============================================================
#  locus_capability_sdk._project — project validation + build.
#
#  Python port of locus-product src/capability-package.js
#  (validateProject / buildProject / canonical lock), locked at
#  bc7114d5fa69569b43f8b4b3c24545de909760b8. Diagnostic codes, their
#  order (path, code, message), de-duplication, the normalized
#  descriptor shapes and the lock shape all mirror the JS: the
#  cross-check (tests/sdk-crosscheck.test.mjs XC2) compares the code
#  SETS against scripts/build.mjs's buildProject failures, and the
#  lock feeds the LOCUS.md manifest whose digest XC1/XC3 pin.
#
#  Like the JS, files in the project directory that are not part of
#  the declared package (src/, tests/, README.md, locus.json, ...)
#  are silently IGNORED: they are never read by the plan, produce no
#  diagnostic and never enter the archive (verified 2026-10-28
#  against the JS builder; see the task report / PR description).
# ============================================================

import functools
import json

from ._canon import canonical_json, sha256_hex
from ._descriptors import (
    ExtensionDescriptorError,
    SKILL_INSTANCE_MAX_BYTES,
    validate_capability_descriptor,
    validate_mcp_descriptor,
    validate_plugin_descriptor,
    validate_skill_descriptor,
)

PACKAGE_SCHEMA_VERSION = 1

PACKAGE_MANIFEST_MAX_BYTES = 256 * 1024
PACKAGE_SKILL_MAX_BYTES = SKILL_INSTANCE_MAX_BYTES
PACKAGE_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024
PACKAGE_TOTAL_MAX_BYTES = 128 * 1024 * 1024
PACKAGE_MAX_COMPONENTS = 128
PACKAGE_MAX_SHIPPED_FILES = 256

PACKAGE_PLUGIN_RUNTIME = "python"
PACKAGE_ARTIFACT_FORMAT = "python-wheel"
PACKAGE_SKILL_SOURCE_NAME = "SKILL.md"
PACKAGE_ARTIFACTS_DIR = "artifacts"

PACKAGE_CONSTANTS = {
    "SCHEMA_VERSION": PACKAGE_SCHEMA_VERSION,
    "MANIFEST_MAX_BYTES": PACKAGE_MANIFEST_MAX_BYTES,
    "SKILL_MAX_BYTES": PACKAGE_SKILL_MAX_BYTES,
    "ARTIFACT_MAX_BYTES": PACKAGE_ARTIFACT_MAX_BYTES,
    "TOTAL_MAX_BYTES": PACKAGE_TOTAL_MAX_BYTES,
    "MAX_COMPONENTS": PACKAGE_MAX_COMPONENTS,
    "MAX_SHIPPED_FILES": PACKAGE_MAX_SHIPPED_FILES,
    "PLUGIN_RUNTIME": PACKAGE_PLUGIN_RUNTIME,
    "ARTIFACT_FORMAT": PACKAGE_ARTIFACT_FORMAT,
    "SKILL_SOURCE_NAME": PACKAGE_SKILL_SOURCE_NAME,
}


# ---------- workspace errors (mirror the provider error names) ----------

class WorkspaceNotFoundError(Exception):
    name = "NotFoundError"


class WorkspaceTypeMismatchError(Exception):
    name = "TypeMismatchError"


class WorkspaceInvariantError(Exception):
    """Programmer fault — mirrors the JS thrown Errors."""


class WorkspaceAdapter:
    """Abstract reader: stat / read_bytes / list over POSIX relative paths."""

    def stat(self, rel):
        raise NotImplementedError

    def read_bytes(self, rel):
        raise NotImplementedError

    def list(self, rel):
        raise NotImplementedError


class FsWorkspace(WorkspaceAdapter):
    """A real project directory on disk. Relative POSIX paths only."""

    def __init__(self, root_dir):
        import os
        self._os = os
        self._root = os.path.abspath(root_dir)

    def _resolve(self, rel):
        os = self._os
        if rel in ("", "."):
            return self._root
        if "\\" in rel or rel.startswith("/"):
            raise WorkspaceInvariantError("workspace paths must be POSIX relatives: %r" % rel)
        parts = rel.split("/")
        if any(not p or p in (".", "..") for p in parts):
            raise WorkspaceInvariantError("invalid workspace path: %r" % rel)
        return os.path.join(self._root, *parts)

    def stat(self, rel):
        import os
        p = self._resolve(rel)
        if not os.path.lexists(p):
            raise WorkspaceNotFoundError(rel)
        if os.path.islink(p):
            # The JS workspaces treat symlinks as neither file nor directory.
            raise WorkspaceTypeMismatchError(rel)
        if os.path.isdir(p):
            return {"kind": "directory", "size": None}
        if os.path.isfile(p):
            return {"kind": "file", "size": os.path.getsize(p)}
        raise WorkspaceTypeMismatchError(rel)

    def read_bytes(self, rel):
        p = self._resolve(rel)
        try:
            with open(p, "rb") as f:
                return f.read()
        except IsADirectoryError:
            raise WorkspaceTypeMismatchError(rel)
        except FileNotFoundError:
            raise WorkspaceNotFoundError(rel)

    def list(self, rel):
        import os
        p = self._resolve(rel)
        try:
            entries = list(os.scandir(p))
        except NotADirectoryError:
            raise WorkspaceTypeMismatchError(rel)
        except FileNotFoundError:
            raise WorkspaceNotFoundError(rel)
        out = []
        for e in entries:
            if e.is_symlink():
                # skipped by the JS providers as well (not file, not directory)
                continue
            if e.is_dir():
                out.append({"name": e.name, "kind": "directory"})
            elif e.is_file():
                out.append({"name": e.name, "kind": "file"})
        return out


class MemWorkspace(WorkspaceAdapter):
    """In-memory files keyed by POSIX relative path (analyze over an archive)."""

    def __init__(self, files=None):
        self.files = dict(files or {})
        for path in self.files:
            if "\\" in path or path.startswith("/") or not path:
                raise WorkspaceInvariantError("invalid workspace path: %r" % path)
            if any(not p or p in (".", "..") for p in path.split("/")):
                raise WorkspaceInvariantError("invalid workspace path: %r" % path)

    @staticmethod
    def _norm(rel):
        return "" if rel in ("", ".") else rel

    def _is_dir(self, rel):
        prefix = rel + "/" if rel else ""
        return any(path.startswith(prefix) for path in self.files)

    def stat(self, rel):
        rel = self._norm(rel)
        if rel in self.files:
            return {"kind": "file", "size": len(self.files[rel])}
        if self._is_dir(rel):
            return {"kind": "directory", "size": None}
        raise WorkspaceNotFoundError(rel)

    def read_bytes(self, rel):
        rel = self._norm(rel)
        if rel in self.files:
            return self.files[rel]
        if self._is_dir(rel):
            raise WorkspaceTypeMismatchError(rel)
        raise WorkspaceNotFoundError(rel)

    def list(self, rel):
        rel = self._norm(rel)
        prefix = rel + "/" if rel else ""
        names = {}
        for path in self.files:
            if not path.startswith(prefix):
                continue
            rest = path[len(prefix):]
            seg = rest.split("/", 1)[0]
            names[seg] = "file" if "/" not in rest else "directory"
        return [{"name": n, "kind": k} for n, k in names.items()]


# ---------- diagnostics ----------

def package_diagnostic(code, path, message):
    return {"severity": "error", "code": code, "path": path, "message": message}


def compare_diagnostics(a, b):
    if a["path"] != b["path"]:
        return -1 if a["path"] < b["path"] else 1
    if a["code"] != b["code"]:
        return -1 if a["code"] < b["code"] else 1
    if a["message"] != b["message"]:
        return -1 if a["message"] < b["message"] else 1
    return 0


def sort_diagnostics(diagnostics):
    seen = set()
    out = []
    for d in diagnostics:
        key = d["path"] + "\0" + d["code"] + "\0" + d["message"]
        if key in seen:
            continue
        seen.add(key)
        out.append(d)
    out.sort(key=functools.cmp_to_key(compare_diagnostics))
    return out


# ---------- small helpers ----------

def _is_plain_object(value):
    return isinstance(value, dict)


def _join_project_path(root, rel):
    return (root + "/" + rel) if root else rel


def _assert_under_root(provider_path, root):
    prefix = (root + "/") if root else ""
    if provider_path != root and not provider_path.startswith(prefix):
        raise WorkspaceInvariantError(
            "internal read escaped the project root: " + provider_path)


def _source_rel_path_reject_reason(raw, under=None):
    import re
    if not isinstance(raw, str) or not len(raw):
        return "path must be a non-empty string"
    if "\\" in raw:
        return "backslash path separators are not allowed: " + json.dumps(raw)
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in raw):
        return "control characters are not allowed in paths"
    if raw.startswith("/"):
        return "absolute paths are not allowed: " + json.dumps(raw)
    if re.match(r"^[A-Za-z]:", raw):
        return "drive letters are not allowed: " + json.dumps(raw)
    segments = raw.split("/")
    for seg in segments:
        if not len(seg):
            return "empty path segment: " + json.dumps(raw)
        if seg in (".", ".."):
            return "path traversal is not allowed: " + json.dumps(raw)
    if under is not None and (not segments or segments[0] != under):
        return 'path must stay under "%s/": %s' % (under, json.dumps(raw))
    return None


def _compare_strings(a, b):
    return (a > b) - (a < b)


# ---------- strict manifest reading ----------

def _read_manifest_object(workspace, provider_path, logical_path, diagnostics):
    try:
        st = workspace.stat(provider_path)
    except (WorkspaceNotFoundError, WorkspaceTypeMismatchError):
        diagnostics.append(package_diagnostic(
            "package_manifest_missing", logical_path,
            "required manifest is missing: " + logical_path))
        return None
    if st["kind"] != "file":
        diagnostics.append(package_diagnostic(
            "package_manifest_unreadable", logical_path,
            logical_path + " is not a regular file"))
        return None
    size = st["size"]
    if size is not None and size > PACKAGE_MANIFEST_MAX_BYTES:
        diagnostics.append(package_diagnostic(
            "package_manifest_too_large", logical_path,
            "%s is %d bytes, over the %d-byte manifest limit"
            % (logical_path, size, PACKAGE_MANIFEST_MAX_BYTES)))
        return None
    data = workspace.read_bytes(provider_path)
    if len(data) > PACKAGE_MANIFEST_MAX_BYTES:
        diagnostics.append(package_diagnostic(
            "package_manifest_too_large", logical_path,
            "%s is %d bytes, over the %d-byte manifest limit"
            % (logical_path, len(data), PACKAGE_MANIFEST_MAX_BYTES)))
        return None
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        diagnostics.append(package_diagnostic(
            "package_json_invalid", logical_path,
            logical_path + " is not valid UTF-8 text"))
        return None
    try:
        parsed = json.loads(text)
    except ValueError as e:
        diagnostics.append(package_diagnostic(
            "package_json_invalid", logical_path,
            "%s is not valid JSON: %s" % (logical_path, e)))
        return None
    if not _is_plain_object(parsed):
        diagnostics.append(package_diagnostic(
            "package_json_invalid", logical_path,
            logical_path + " must contain a JSON object"))
        return None
    return parsed


def _check_schema_version(parsed, logical_path, diagnostics):
    if parsed.get("schemaVersion") != PACKAGE_SCHEMA_VERSION \
            or isinstance(parsed.get("schemaVersion"), bool):
        diagnostics.append(package_diagnostic(
            "package_schema_version", logical_path,
            "unsupported package schemaVersion: %s (this build implements exactly %d)"
            % (json.dumps(parsed.get("schemaVersion")), PACKAGE_SCHEMA_VERSION)))
        return False
    return True


def _reject_unknown_fields(obj, allowed, logical_path, what, diagnostics):
    for key in obj.keys():
        if key not in allowed:
            diagnostics.append(package_diagnostic(
                "package_field_unknown", logical_path,
                '%s has unknown field "%s" (allowed: %s)' % (what, key, ", ".join(allowed))))


def _normalize_descriptor(kind, raw, logical_path, diagnostics):
    validator = {
        "capability": validate_capability_descriptor,
        "plugin": validate_plugin_descriptor,
        "skill": validate_skill_descriptor,
        "mcp": validate_mcp_descriptor,
    }[kind]
    try:
        return validator(raw)
    except ExtensionDescriptorError as e:
        diagnostics.append(package_diagnostic(
            "package_descriptor_invalid", logical_path, str(e)))
        return None


# ---------- per-kind source manifest validation ----------

def _validate_capability_manifest(parsed, logical_path, diagnostics):
    if not _check_schema_version(parsed, logical_path, diagnostics):
        return None
    _reject_unknown_fields(parsed, ["schemaVersion", "capability"], logical_path, logical_path,
                           diagnostics)
    if not _is_plain_object(parsed.get("capability")):
        diagnostics.append(package_diagnostic(
            "package_field_missing", logical_path,
            logical_path + ' requires a "capability" object'))
        return None
    _reject_unknown_fields(
        parsed["capability"],
        ["id", "version", "displayName", "description", "plugins", "skills", "mcps", "credentials"],
        logical_path, "capability descriptor", diagnostics)
    credentials = parsed["capability"].get("credentials")
    if credentials is not None and not isinstance(credentials, list):
        diagnostics.append(package_diagnostic(
            "package_field_invalid", logical_path,
            'capability descriptor field "credentials" must be an array, got %s'
            % type(credentials).__name__))
        return None
    return _normalize_descriptor("capability", parsed["capability"], logical_path, diagnostics)


def _validate_plugin_manifest(parsed, dir_id, logical_path, diagnostics):
    if not _check_schema_version(parsed, logical_path, diagnostics):
        return None
    _reject_unknown_fields(parsed, ["schemaVersion", "plugin", "artifacts"], logical_path,
                           logical_path, diagnostics)
    if not _is_plain_object(parsed.get("plugin")):
        diagnostics.append(package_diagnostic(
            "package_field_missing", logical_path,
            logical_path + ' requires a "plugin" object'))
        return None
    _reject_unknown_fields(
        parsed["plugin"],
        ["id", "version", "displayName", "description", "runtime", "authority", "provides"],
        logical_path, "plugin descriptor", diagnostics)

    if parsed["plugin"].get("runtime") != PACKAGE_PLUGIN_RUNTIME:
        runtime = parsed["plugin"].get("runtime")
        diagnostics.append(package_diagnostic(
            "package_runtime_unsupported", logical_path,
            'package v1 supports runtime "%s" only, got %s'
            % (PACKAGE_PLUGIN_RUNTIME, json.dumps(runtime))))

    artifacts = parsed.get("artifacts")
    if not isinstance(artifacts, list):
        diagnostics.append(package_diagnostic(
            "package_field_missing", logical_path,
            logical_path + ' requires an "artifacts" array'))
        return None
    if len(artifacts) != 1:
        diagnostics.append(package_diagnostic(
            "package_artifact_policy", logical_path,
            "%s must declare exactly one %s artifact, got %d"
            % (logical_path, PACKAGE_ARTIFACT_FORMAT, len(artifacts))))
    out_artifacts = []
    for i, entry in enumerate(artifacts):
        entry_path = "%s#artifacts[%d]" % (logical_path, i)
        if not _is_plain_object(entry):
            diagnostics.append(package_diagnostic(
                "package_field_unknown", entry_path, "artifact entries must be objects"))
            continue
        _reject_unknown_fields(entry, ["path", "format"], entry_path, "artifact entry", diagnostics)
        reason = _source_rel_path_reject_reason(entry.get("path"), under=PACKAGE_ARTIFACTS_DIR)
        if reason:
            diagnostics.append(package_diagnostic(
                "package_path_invalid", entry_path, reason))
            continue
        if entry.get("format") != PACKAGE_ARTIFACT_FORMAT:
            diagnostics.append(package_diagnostic(
                "package_artifact_policy", entry_path,
                "unsupported artifact format: %s (package v1 supports exactly \"%s\")"
                % (json.dumps(entry.get("format")), PACKAGE_ARTIFACT_FORMAT)))
            continue
        out_artifacts.append({"sourcePath": entry["path"], "logicalPath": None,
                              "format": entry["format"]})

    descriptor = _normalize_descriptor("plugin", parsed["plugin"], logical_path, diagnostics)
    if descriptor is None:
        return None
    if descriptor["id"] != dir_id:
        diagnostics.append(package_diagnostic(
            "package_id_mismatch", logical_path,
            'plugin directory name "%s" does not match descriptor id "%s"'
            % (dir_id, descriptor["id"])))
        return None
    for a in out_artifacts:
        a["logicalPath"] = "plugins/%s/%s" % (descriptor["id"], a["sourcePath"])
    return {"descriptor": descriptor, "artifacts": out_artifacts}


def _validate_skill_manifest(parsed, dir_id, logical_path, diagnostics):
    if not _check_schema_version(parsed, logical_path, diagnostics):
        return None
    _reject_unknown_fields(parsed, ["schemaVersion", "skill", "source"], logical_path,
                           logical_path, diagnostics)
    if not _is_plain_object(parsed.get("skill")):
        diagnostics.append(package_diagnostic(
            "package_field_missing", logical_path,
            logical_path + ' requires a "skill" object'))
        return None
    _reject_unknown_fields(parsed["skill"], ["id", "version", "displayName", "description"],
                           logical_path, "skill descriptor", diagnostics)
    if parsed.get("source") != PACKAGE_SKILL_SOURCE_NAME:
        diagnostics.append(package_diagnostic(
            "package_source_invalid", logical_path,
            'skill "source" must be exactly "%s", got %s'
            % (PACKAGE_SKILL_SOURCE_NAME, json.dumps(parsed.get("source")))))
    descriptor = _normalize_descriptor("skill", parsed["skill"], logical_path, diagnostics)
    if descriptor is None:
        return None
    if descriptor["id"] != dir_id:
        diagnostics.append(package_diagnostic(
            "package_id_mismatch", logical_path,
            'skill directory name "%s" does not match descriptor id "%s"'
            % (dir_id, descriptor["id"])))
        return None
    source_logical = "skills/%s/%s" % (descriptor["id"], PACKAGE_SKILL_SOURCE_NAME)
    return {"descriptor": descriptor, "sourceLogical": source_logical}


def _validate_mcp_manifest(parsed, dir_id, logical_path, diagnostics):
    if not _check_schema_version(parsed, logical_path, diagnostics):
        return None
    _reject_unknown_fields(parsed, ["schemaVersion", "mcp"], logical_path, logical_path, diagnostics)
    if not _is_plain_object(parsed.get("mcp")):
        diagnostics.append(package_diagnostic(
            "package_field_missing", logical_path,
            logical_path + ' requires an "mcp" object'))
        return None
    _reject_unknown_fields(parsed["mcp"], ["id", "displayName", "description"],
                           logical_path, "mcp descriptor", diagnostics)
    descriptor = _normalize_descriptor("mcp", parsed["mcp"], logical_path, diagnostics)
    if descriptor is None:
        return None
    if descriptor["id"] != dir_id:
        diagnostics.append(package_diagnostic(
            "package_id_mismatch", logical_path,
            'mcp directory name "%s" does not match descriptor id "%s"'
            % (dir_id, descriptor["id"])))
        return None
    return {"descriptor": descriptor}


# ---------- discovery ----------

def _scan_component_dir(workspace, root, dir_name, diagnostics):
    found = {}
    provider_path = _join_project_path(root, dir_name)
    try:
        entries = workspace.list(provider_path)
    except WorkspaceNotFoundError:
        return found  # absent dir = no components
    except WorkspaceTypeMismatchError:
        diagnostics.append(package_diagnostic(
            "package_component_dir_invalid", dir_name, dir_name + "/ must be a directory"))
        return found
    for entry in entries:
        name = entry["name"]
        if (not isinstance(name, str) or not len(name) or "/" in name or "\\" in name
                or any(ord(c) < 0x20 or ord(c) == 0x7F for c in name)
                or name in (".", "..")):
            diagnostics.append(package_diagnostic(
                "package_component_dir_invalid", dir_name,
                "%s/ contains an invalid entry name: %s" % (dir_name, json.dumps(str(name)))))
            continue
        if entry["kind"] != "directory":
            diagnostics.append(package_diagnostic(
                "package_component_dir_invalid", dir_name + "/" + name,
                "%s/ entries must be component directories, got a file: %s" % (dir_name, name)))
            continue
        import re
        if not re.fullmatch(r"[a-z0-9][a-z0-9._-]*", name):
            diagnostics.append(package_diagnostic(
                "package_id_invalid", dir_name + "/" + name,
                "%s/ directory name must match %s: %s"
                % (dir_name, r"/^[a-z0-9][a-z0-9._-]*$/", name)))
            continue
        if name in found:
            diagnostics.append(package_diagnostic(
                "package_duplicate", dir_name + "/" + name,
                "duplicate %s component id: %s" % (dir_name, name)))
            continue
        found[name] = dir_name + "/" + name
    return found


# ---------- project validation ----------

def validate_project(workspace, root=None):
    """validateProject({ workspace, root }) port.

    Returns {ok, diagnostics, normalized?} with diagnostics carrying
    severity/code/path/message (JS shape); the public sdk.validate()
    projects them to {code, path, message}.
    """
    root = _normalize_root(root)
    ws = workspace
    diagnostics = []

    try:
        st = ws.stat(root or ".")
        if st["kind"] != "directory":
            diagnostics.append(package_diagnostic(
                "package_root_missing", root or ".",
                "project root is not a directory: " + (root or ".")))
    except (WorkspaceNotFoundError, WorkspaceTypeMismatchError):
        diagnostics.append(package_diagnostic(
            "package_root_missing", root or ".",
            "project root does not exist: " + (root or ".")))

    cap_parsed = _read_manifest_object(ws, _join_project_path(root, "capability.json"),
                                       "capability.json", diagnostics)
    capability = None
    if cap_parsed is not None:
        capability = _validate_capability_manifest(cap_parsed, "capability.json", diagnostics)

    plugin_dirs = _scan_component_dir(ws, root, "plugins", diagnostics)
    skill_dirs = _scan_component_dir(ws, root, "skills", diagnostics)
    mcp_dirs = _scan_component_dir(ws, root, "mcp", diagnostics)
    component_count = len(plugin_dirs) + len(skill_dirs) + len(mcp_dirs)
    if component_count > PACKAGE_MAX_COMPONENTS:
        diagnostics.append(package_diagnostic(
            "package_too_many_components", root or ".",
            "project declares %d components, over the %d-component limit"
            % (component_count, PACKAGE_MAX_COMPONENTS)))

    plugins = []
    for pid in sorted(plugin_dirs.keys()):
        logical_path = "plugins/%s/plugin.json" % pid
        parsed = _read_manifest_object(ws, _join_project_path(root, logical_path),
                                       logical_path, diagnostics)
        if parsed is None:
            continue
        validated = _validate_plugin_manifest(parsed, pid, logical_path, diagnostics)
        if validated is None:
            continue
        for a in validated["artifacts"]:
            artifact_provider = _join_project_path(
                root, "plugins/%s/%s" % (pid, a["sourcePath"]))
            _assert_under_root(artifact_provider, root)
            try:
                st = ws.stat(artifact_provider)
                if st["kind"] != "file":
                    diagnostics.append(package_diagnostic(
                        "package_artifact_unreadable", a["logicalPath"],
                        a["logicalPath"] + " is not a regular file"))
                elif st["size"] is not None and st["size"] > PACKAGE_ARTIFACT_MAX_BYTES:
                    diagnostics.append(package_diagnostic(
                        "package_artifact_too_large", a["logicalPath"],
                        "%s is %d bytes, over the %d-byte artifact limit"
                        % (a["logicalPath"], st["size"], PACKAGE_ARTIFACT_MAX_BYTES)))
            except (WorkspaceNotFoundError, WorkspaceTypeMismatchError):
                diagnostics.append(package_diagnostic(
                    "package_artifact_missing", a["logicalPath"],
                    "declared plugin artifact is missing: " + a["logicalPath"]))
        plugins.append(validated)

    skills = []
    for sid in sorted(skill_dirs.keys()):
        logical_path = "skills/%s/skill.json" % sid
        parsed = _read_manifest_object(ws, _join_project_path(root, logical_path),
                                       logical_path, diagnostics)
        if parsed is None:
            continue
        validated = _validate_skill_manifest(parsed, sid, logical_path, diagnostics)
        if validated is None:
            continue
        source_provider = _join_project_path(root, validated["sourceLogical"])
        _assert_under_root(source_provider, root)
        try:
            st = ws.stat(source_provider)
            if st["kind"] != "file":
                diagnostics.append(package_diagnostic(
                    "package_skill_source_missing", validated["sourceLogical"],
                    validated["sourceLogical"] + " is not a regular file"))
            elif st["size"] is not None and st["size"] > PACKAGE_SKILL_MAX_BYTES:
                diagnostics.append(package_diagnostic(
                    "package_skill_too_large", validated["sourceLogical"],
                    "%s is %d bytes, over the %d-byte skill source limit"
                    % (validated["sourceLogical"], st["size"], PACKAGE_SKILL_MAX_BYTES)))
            else:
                data = ws.read_bytes(source_provider)
                if len(data) > PACKAGE_SKILL_MAX_BYTES:
                    diagnostics.append(package_diagnostic(
                        "package_skill_too_large", validated["sourceLogical"],
                        "%s is %d bytes, over the %d-byte skill source limit"
                        % (validated["sourceLogical"], len(data), PACKAGE_SKILL_MAX_BYTES)))
                else:
                    try:
                        data.decode("utf-8")
                    except UnicodeDecodeError:
                        diagnostics.append(package_diagnostic(
                            "package_skill_source_invalid", validated["sourceLogical"],
                            validated["sourceLogical"]
                            + " must be UTF-8 text (binary skill sources are refused)"))
        except (WorkspaceNotFoundError, WorkspaceTypeMismatchError):
            diagnostics.append(package_diagnostic(
                "package_skill_source_missing", validated["sourceLogical"],
                "declared skill source is missing: " + validated["sourceLogical"]))
        skills.append(validated)

    mcps = []
    for mid in sorted(mcp_dirs.keys()):
        logical_path = "mcp/%s/mcp.json" % mid
        parsed = _read_manifest_object(ws, _join_project_path(root, logical_path),
                                       logical_path, diagnostics)
        if parsed is None:
            continue
        validated = _validate_mcp_manifest(parsed, mid, logical_path, diagnostics)
        if validated is not None:
            mcps.append(validated)

    if capability is not None:
        plugin_ids = {p["descriptor"]["id"] for p in plugins}
        skill_ids = {s["descriptor"]["id"] for s in skills}
        mcp_ids = {m["descriptor"]["id"] for m in mcps}
        for ref in capability["plugins"]:
            if ref not in plugin_ids:
                diagnostics.append(package_diagnostic(
                    "package_ref_missing", "capability.json",
                    "capability %s references missing local plugin: %s" % (capability["id"], ref)))
        for ref in capability["skills"]:
            if ref not in skill_ids:
                diagnostics.append(package_diagnostic(
                    "package_ref_missing", "capability.json",
                    "capability %s references missing local skill: %s" % (capability["id"], ref)))
        for ref in capability["mcps"]:
            if ref not in mcp_ids:
                diagnostics.append(package_diagnostic(
                    "package_ref_missing", "capability.json",
                    "capability %s references missing local mcp: %s "
                    "(a package must describe the MCP requirements it names)"
                    % (capability["id"], ref)))
        for p in plugins:
            if p["descriptor"]["id"] not in capability["plugins"]:
                diagnostics.append(package_diagnostic(
                    "package_component_unreferenced", "plugins/" + p["descriptor"]["id"],
                    "plugin %s is not referenced by capability %s"
                    % (p["descriptor"]["id"], capability["id"])))
        for s in skills:
            if s["descriptor"]["id"] not in capability["skills"]:
                diagnostics.append(package_diagnostic(
                    "package_component_unreferenced", "skills/" + s["descriptor"]["id"],
                    "skill %s is not referenced by capability %s"
                    % (s["descriptor"]["id"], capability["id"])))
        for m in mcps:
            if m["descriptor"]["id"] not in capability["mcps"]:
                diagnostics.append(package_diagnostic(
                    "package_component_unreferenced", "mcp/" + m["descriptor"]["id"],
                    "mcp %s is not referenced by capability %s"
                    % (m["descriptor"]["id"], capability["id"])))

    sorted_diagnostics = sort_diagnostics(diagnostics)
    if sorted_diagnostics or capability is None:
        return {"ok": False, "diagnostics": sorted_diagnostics, "normalized": None}

    normalized_plugins = [
        {
            "descriptor": p["descriptor"],
            "artifacts": [
                {"sourcePath": a["sourcePath"], "logicalPath": a["logicalPath"],
                 "format": a["format"]}
                for a in p["artifacts"]
            ],
        }
        for p in sorted(plugins, key=lambda p: p["descriptor"]["id"])
    ]
    normalized_skills = [
        {"descriptor": s["descriptor"], "sourceLogical": s["sourceLogical"]}
        for s in sorted(skills, key=lambda s: s["descriptor"]["id"])
    ]
    normalized_mcps = [
        {"descriptor": m["descriptor"]}
        for m in sorted(mcps, key=lambda m: m["descriptor"]["id"])
    ]

    source_plan = []
    for p in normalized_plugins:
        for a in p["artifacts"]:
            source_plan.append({
                "kind": "artifact",
                "pluginId": p["descriptor"]["id"],
                "logicalPath": a["logicalPath"],
                "providerPath": _join_project_path(
                    root, "plugins/%s/%s" % (p["descriptor"]["id"], a["sourcePath"])),
                "format": a["format"],
            })
    for s in normalized_skills:
        source_plan.append({
            "kind": "skill-source",
            "skillId": s["descriptor"]["id"],
            "logicalPath": s["sourceLogical"],
            "providerPath": _join_project_path(root, s["sourceLogical"]),
        })
    source_plan.sort(key=lambda entry: entry["logicalPath"])
    for entry in source_plan:
        _assert_under_root(entry["providerPath"], root)

    if len(source_plan) > PACKAGE_MAX_SHIPPED_FILES:
        diagnostics.append(package_diagnostic(
            "package_too_many_files", root or ".",
            "project ships %d runtime files, over the %d-file limit"
            % (len(source_plan), PACKAGE_MAX_SHIPPED_FILES)))
        return {"ok": False, "diagnostics": sort_diagnostics(diagnostics), "normalized": None}

    return {
        "ok": True,
        "diagnostics": [],
        "normalized": {
            "capability": capability,
            "plugins": normalized_plugins,
            "skills": normalized_skills,
            "mcps": normalized_mcps,
            "sourcePlan": source_plan,
        },
    }


def _normalize_root(root):
    if root is None:
        return ""
    if not isinstance(root, str):
        raise WorkspaceInvariantError("root must be a string workspace path")
    if "\\" in root:
        raise WorkspaceInvariantError('root must use POSIX "/" separators')
    if root in ("", "."):
        return ""
    if root.startswith("/") or any(not seg or seg in (".", "..") for seg in root.split("/")):
        raise WorkspaceInvariantError("invalid project root: %r" % root)
    return root


# ---------- build ----------

def build_project(workspace, root=None):
    """buildProject({ workspace, root }) port.

    Returns {ok, diagnostics, bundle?}; bundle = {lock, files} with
    files a dict logicalPath -> bytes (the JS CapabilityBundle holds
    private copies — a plain dict serves the same role here).
    """
    root = _normalize_root(root)
    validation = validate_project(workspace, root)
    if not validation["ok"]:
        return {"ok": False, "diagnostics": validation["diagnostics"], "bundle": None}
    normalized = validation["normalized"]
    diagnostics = []
    files = {}
    integrity = {}
    artifact_entries = {}
    skill_entries = {}
    total_bytes = 0
    total_overflow = False

    for entry in normalized["sourcePlan"]:
        _assert_under_root(entry["providerPath"], root)
        cap = PACKAGE_ARTIFACT_MAX_BYTES if entry["kind"] == "artifact" else PACKAGE_SKILL_MAX_BYTES
        artifact = entry["kind"] == "artifact"
        missing_code = "package_artifact_missing" if artifact else "package_skill_source_missing"
        unreadable_code = "package_artifact_unreadable" if artifact else "package_skill_source_missing"
        too_large_code = "package_artifact_too_large" if artifact else "package_skill_too_large"
        try:
            st = workspace.stat(entry["providerPath"])
            if st["kind"] != "file":
                diagnostics.append(package_diagnostic(
                    unreadable_code, entry["logicalPath"],
                    entry["logicalPath"] + " is not a regular file"))
                continue
            if st["size"] is not None and st["size"] > cap:
                diagnostics.append(package_diagnostic(
                    too_large_code, entry["logicalPath"],
                    "%s is %d bytes, over the %d-byte limit"
                    % (entry["logicalPath"], st["size"], cap)))
                continue
        except (WorkspaceNotFoundError, WorkspaceTypeMismatchError):
            diagnostics.append(package_diagnostic(
                missing_code, entry["logicalPath"],
                "shipped file disappeared during build: " + entry["logicalPath"]))
            continue
        try:
            data = workspace.read_bytes(entry["providerPath"])
        except (WorkspaceNotFoundError, WorkspaceTypeMismatchError):
            diagnostics.append(package_diagnostic(
                missing_code, entry["logicalPath"],
                "shipped file disappeared during build: " + entry["logicalPath"]))
            continue
        if len(data) > cap:
            diagnostics.append(package_diagnostic(
                too_large_code, entry["logicalPath"],
                "%s is %d bytes, over the %d-byte limit" % (entry["logicalPath"], len(data), cap)))
            continue
        if entry["kind"] == "skill-source":
            try:
                data.decode("utf-8")
            except UnicodeDecodeError:
                diagnostics.append(package_diagnostic(
                    "package_skill_source_invalid", entry["logicalPath"],
                    entry["logicalPath"] + " must be UTF-8 text"))
                continue
        if total_bytes + len(data) > PACKAGE_TOTAL_MAX_BYTES:
            if not total_overflow:
                diagnostics.append(package_diagnostic(
                    "package_total_too_large", root or ".",
                    "shipped runtime bytes exceed the %d-byte package total"
                    % PACKAGE_TOTAL_MAX_BYTES))
                total_overflow = True
            continue
        total_bytes += len(data)
        digest = sha256_hex(data)
        files[entry["logicalPath"]] = data
        integrity[entry["logicalPath"]] = {"size": len(data), "sha256": digest}
        if entry["kind"] == "artifact":
            artifact_entries.setdefault(entry["pluginId"], []).append({
                "path": entry["logicalPath"],
                "format": entry["format"],
                "size": len(data),
                "sha256": digest,
            })
        else:
            skill_entries[entry["skillId"]] = {
                "sourcePath": entry["logicalPath"],
                "size": len(data),
                "sha256": digest,
            }

    if diagnostics:
        return {"ok": False, "diagnostics": sort_diagnostics(diagnostics), "bundle": None}
    if len(files) != len(normalized["sourcePlan"]):
        raise WorkspaceInvariantError("build did not materialize every planned file")

    # The lock omits an EMPTY credentials list so a credential-free
    # package serializes byte-identically to its pre-C3 lock (JS:
    # digest stability); a non-empty list rides verbatim.
    lock_capability = dict(normalized["capability"])
    credentials = lock_capability.get("credentials")
    if isinstance(credentials, list) and len(credentials) == 0:
        del lock_capability["credentials"]

    lock = {
        "schemaVersion": PACKAGE_SCHEMA_VERSION,
        "capability": lock_capability,
        "plugins": [
            {
                "descriptor": p["descriptor"],
                "artifacts": artifact_entries.get(p["descriptor"]["id"], []),
            }
            for p in normalized["plugins"]
        ],
        "skills": [
            {
                "descriptor": s["descriptor"],
                "sourcePath": skill_entries[s["descriptor"]["id"]]["sourcePath"],
                "size": skill_entries[s["descriptor"]["id"]]["size"],
                "sha256": skill_entries[s["descriptor"]["id"]]["sha256"],
            }
            for s in normalized["skills"]
        ],
        "mcps": [m["descriptor"] for m in normalized["mcps"]],
        "files": [
            {"path": path, "size": integrity[path]["size"], "sha256": integrity[path]["sha256"]}
            for path in sorted(integrity.keys())
        ],
    }

    return {"ok": True, "diagnostics": [], "bundle": {"lock": lock, "files": files}}


def serialize_lock(lock) -> str:
    return canonical_json(lock) + "\n"
