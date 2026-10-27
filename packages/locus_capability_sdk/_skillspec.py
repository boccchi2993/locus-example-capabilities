# ============================================================
#  locus_capability_sdk._skillspec — skill spec rules.
#
#  Python port of scripts/skill-spec.mjs, with the SAME rule names as
#  diagnostic codes so the cross-check (XC2) can compare them 1:1:
#    literal-key          — no literal API key (`sk-` + 16+ alphanumerics)
#    undeclared-variable  — every curl $NAME must be a declared credential
#    url-outside-prefix   — credential curl targets must stay inside
#                           origin + pathPrefix
# ============================================================

import json
import os
import re

LITERAL_KEY_PATTERN = re.compile(r"sk-[A-Za-z0-9]{16,}")
VAR_PATTERN = re.compile(r"\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?")
URL_PATTERN = re.compile(r"https?://[^\s'\"`<>]+")


def extract_curl_commands(text):
    """One curl command = the line containing curl, plus continuation lines."""
    lines = text.split("\n")
    commands = []
    i = 0
    while i < len(lines):
        if not re.search(r"\bcurl\b", lines[i]):
            i += 1
            continue
        cmd = lines[i]
        while cmd.rstrip().endswith("\\") and i + 1 < len(lines):
            cmd = cmd.rstrip()[:-1] + " " + lines[i + 1].strip()
            i += 1
        commands.append(cmd)
        i += 1
    return commands


def _target_url_of(cmd):
    m = URL_PATTERN.search(cmd)
    if not m:
        return None
    return re.sub(r"[),.;:'\"]+$", "", m.group(0))


def _walk_skill_md_files(project_dir, rel="", out=None):
    if out is None:
        out = []
    for entry in sorted(os.scandir(os.path.join(project_dir, rel) if rel else project_dir),
                        key=lambda e: e.name):
        rel_posix = (rel + "/" + entry.name) if rel else entry.name
        if entry.is_dir(follow_symlinks=False):
            _walk_skill_md_files(project_dir, rel_posix, out)
        elif entry.is_file(follow_symlinks=False) and entry.name == "SKILL.md":
            out.append(rel_posix)
    return out


def check_skill_specs(project_dir):
    """Returns [{code, path, message}] — empty list = pass."""
    violations = []
    with open(os.path.join(project_dir, "capability.json"), "rb") as f:
        manifest = json.loads(f.read().decode("utf-8"))
    credentials = manifest.get("capability", {}).get("credentials")
    if not isinstance(credentials, list):
        credentials = []

    for rel in _walk_skill_md_files(project_dir):
        with open(os.path.join(project_dir, rel), "rb") as f:
            text = f.read().decode("utf-8")
        at = "%s/%s" % (project_dir, rel)

        if LITERAL_KEY_PATTERN.search(text):
            violations.append({
                "code": "literal-key",
                "path": at,
                "message": "%s 出现 sk- 字面密钥（sk- 后 16 个以上字母数字）" % at,
            })

        for cmd in extract_curl_commands(text):
            names = [m.group(1) for m in VAR_PATTERN.finditer(cmd)]
            if not names:
                continue
            url = _target_url_of(cmd)
            for name in names:
                cred = next((c for c in credentials if isinstance(c, dict)
                             and c.get("name") == name), None)
                if cred is None:
                    violations.append({
                        "code": "undeclared-variable",
                        "path": at,
                        "message": "%s 的 curl 使用了未在 capability.json credentials "
                                   "中声明的变量 $%s" % (at, name),
                    })
                    continue
                prefix = cred["origin"] + cred["pathPrefix"]
                if not url or not url.startswith(prefix):
                    violations.append({
                        "code": "url-outside-prefix",
                        "path": at,
                        "message": "%s 的 curl 目标 URL %s 不以凭据 %s 的 %s 开头"
                                   % (at, json.dumps(url), name, json.dumps(prefix)),
                    })
    return violations
