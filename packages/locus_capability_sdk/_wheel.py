# ============================================================
#  locus_capability_sdk._wheel — deterministic pure-Python wheels.
#
#  build_wheel packs ONE top-level package (or module) from a source
#  directory into {dist}-{version}-py3-none-any.whl. Deterministic by
#  construction: fixed DOS timestamps (1980-01-01 00:00), sorted
#  entries, fixed permissions (regular file 0o644), fixed compression
#  (STORED — a wheel is mostly already-compressible text but zip
#  determinism beats a few bytes; the vendor reproducibility check
#  rebuilds and byte-compares), fixed METADATA/WHEEL/RECORD format.
#
#  dist names are PEP 427-escaped; RECORD hashes use the URL-safe
#  base64 sha256 without padding, with RECORD's own line left empty.
# ============================================================

import base64
import hashlib
import os
import re
import zipfile

from ._version import __version__

WHEEL_TAG = "py3-none-any"


def escape_dist_name(dist: str) -> str:
    """PEP 427 wheel filename escaping for the distribution part."""
    return re.sub(r"[^\w\d.]+", "_", dist, flags=re.UNICODE)


def _collect_package_entries(src_dir: str):
    """Top-level packages (dirs with __init__.py) and modules (*.py).

    Returns a sorted list of (arcname, absolute_path). Extra files in
    the source directory that belong to no top-level package/module
    are ignored (the JS builder ignores undeclared project files too).
    """
    entries = []
    for name in sorted(os.listdir(src_dir)):
        full = os.path.join(src_dir, name)
        if os.path.islink(full):
            continue
        if os.path.isdir(full):
            if name == "__pycache__" or not os.path.exists(os.path.join(full, "__init__.py")):
                continue
            for dirpath, dirnames, filenames in os.walk(full):
                dirnames[:] = [d for d in sorted(dirnames)
                               if d != "__pycache__"
                               and not os.path.islink(os.path.join(dirpath, d))]
                for fn in sorted(filenames):
                    if fn.endswith((".pyc", ".pyo")):
                        continue
                    abs_path = os.path.join(dirpath, fn)
                    if os.path.islink(abs_path):
                        continue
                    rel = os.path.relpath(abs_path, src_dir)
                    entries.append((rel.replace(os.sep, "/"), abs_path))
        elif name.endswith(".py"):
            entries.append((name, full))
    if not entries:
        raise ValueError(
            "build_wheel: no top-level package (directory with __init__.py) "
            "or module (*.py) found under %s" % src_dir)
    return sorted(entries)


def _record_hash(data: bytes) -> str:
    digest = hashlib.sha256(data).digest()
    return "sha256=" + base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def build_wheel(src_dir: str, dist: str, version: str, out_dir: str, summary: str = "") -> str:
    """Build {dist}-{version}-py3-none-any.whl; returns the output path."""
    if not isinstance(dist, str) or not dist:
        raise ValueError("build_wheel: dist must be a non-empty string")
    if not isinstance(version, str) or not version:
        raise ValueError("build_wheel: version must be a non-empty string")
    if not isinstance(summary, str):
        raise ValueError("build_wheel: summary must be a string")

    dist_escaped = escape_dist_name(dist)
    dist_info = "%s-%s.dist-info" % (dist_escaped, version)

    package_entries = _collect_package_entries(src_dir)

    metadata = (
        "Metadata-Version: 2.1\n"
        "Name: %s\n"
        "Version: %s\n"
        "Summary: %s\n" % (dist, version, summary)
    )
    wheel_file = (
        "Wheel-Version: 1.0\n"
        "Generator: locus_capability_sdk %s\n"
        "Root-Is-Purelib: true\n"
        "Tag: %s\n" % (__version__, WHEEL_TAG)
    )

    # Sorted arcnames, dist-info included in the sort (deterministic order).
    all_entries = [(arc, path, None) for arc, path in package_entries]
    all_entries.append((dist_info + "/METADATA", None, metadata.encode("utf-8")))
    all_entries.append((dist_info + "/WHEEL", None, wheel_file.encode("utf-8")))
    all_entries.sort(key=lambda e: e[0])

    record_lines = []
    for arc, path, inline in all_entries:
        data = inline if inline is not None else open(path, "rb").read()
        record_lines.append("%s,%s,%d" % (arc, _record_hash(data), len(data)))
    record_lines.append(dist_info + "/RECORD,,")
    record = "\n".join(record_lines) + "\n"
    all_entries.append((dist_info + "/RECORD", None, record.encode("utf-8")))

    wheel_filename = "%s-%s-%s.whl" % (dist_escaped, version, WHEEL_TAG)
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, wheel_filename)

    # Fixed zip metadata; STORED compression; deterministic central directory.
    with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_STORED) as zf:
        for arc, path, inline in all_entries:
            data = inline if inline is not None else open(path, "rb").read()
            info = zipfile.ZipInfo(arc, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED
            info.create_system = 3  # unix, so the fixed external attrs are meaningful
            info.external_attr = (0o100644) << 16  # regular file, 0o644
            zf.writestr(info, data)
    return out_path
