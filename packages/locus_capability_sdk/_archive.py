# ============================================================
#  locus_capability_sdk._archive — the .locus package container.
#
#  Python port of locus-product src/locus-archive.js (locked at
#  bc7114d5fa69569b43f8b4b3c24545de909760b8):
#    - deterministic ZIP writing — STORE-ONLY (method 0, the
#      2026-10-28 owner decision): fixed DOS timestamps, LOCUS.md
#      first then path order, UTF-8 flag exactly when the name has a
#      non-ASCII byte, zero external attributes. Identical inputs
#      pack to byte-identical archives on every engine (Node,
#      browsers, Python), because stored bytes depend only on the
#      inputs — no deflate implementation is involved.
#    - reading (central-directory only, bounded, hostile-input
#      rejecting) still accepts methods 0 and 8, so archives written
#      before the store-only change remain readable.
#    - LOCUS.md render/parse, manifest verification + repinning,
#      digest, expected package paths, limits.
#
#  The byte layout mirrors the JS writer field by field; the
#  cross-check (tests/sdk-crosscheck.test.mjs XC1) pins archive-byte
#  equality against scripts/build.mjs.
# ============================================================

import json
import re
import struct
import zlib

from ._canon import canonical_json, canonical_json_bytes, sha256_hex


def _js_json(s):
    return json.dumps(s, ensure_ascii=True)

LOCUS_MD_NAME = "LOCUS.md"

LOCUS_LIMITS = {
    "maxEntries": 257,  # 256 project files + LOCUS.md
    "maxFileBytes": 64 * 1024 * 1024,
    "maxTotalBytes": 128 * 1024 * 1024,
    "maxLocusMdBytes": 256 * 1024,
}

_LOCAL_SIG = 0x04034B50
_CENTRAL_SIG = 0x02014B50
_EOCD_SIG = 0x06054B50
_ZIP64_LOCATOR_SIG = 0x07064B50


class LocusArchiveError(Exception):
    """Programmer invariant of the writer — mirrors the JS thrown Errors."""


def _diagnostic(code, path, message, **extra):
    d = {"code": code, "path": path, "message": message}
    d.update(extra)
    return d


def _failed(diagnostics):
    return {"ok": False, "diagnostics": diagnostics, "files": None, "locusMd": None}


def _archive_name_reject_reason(name):
    # Mirrors archiveNameRejectReason: POSIX-style relatives only;
    # directory entries keep their trailing slash (not an empty segment).
    if not isinstance(name, str) or not len(name):
        return "name must be a non-empty string"
    if name.startswith("/"):
        return "absolute path"
    if "\\" in name:
        return "backslash path separator"
    if "\0" in name:
        return "NUL byte"
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in name):
        return "control character"
    segments = name.split("/")
    checked = segments[:-1] if name.endswith("/") else segments
    for seg in checked:
        if not len(seg):
            return "empty path segment"
        if seg in (".", ".."):
            return "dot path segment"
    return None


def crc32(data: bytes) -> int:
    return zlib.crc32(data) & 0xFFFFFFFF


# ---------- write (store-only) ----------

def write_locus_archive(files, locus_md_text: str) -> bytes:
    """Pack files + LOCUS.md into a deterministic store-only .locus.

    files: dict path -> bytes WITHOUT LOCUS.md (it is written
    separately). Byte-identical to the JS writeLocusArchive (locked
    product, store-only): every entry method 0, DOS time 0 / date 33
    (1980-01-01), external attributes 0, versions 20.
    """
    if LOCUS_MD_NAME in files:
        raise LocusArchiveError(
            "files must not contain " + LOCUS_MD_NAME + "; it is written separately")
    if not isinstance(locus_md_text, str):
        raise LocusArchiveError("writeLocusArchive requires a string LOCUS.md")
    locus_md_bytes = locus_md_text.encode("utf-8")
    normalized = {}
    for path, data in files.items():
        if not isinstance(path, str) or _archive_name_reject_reason(path):
            raise LocusArchiveError("refusing to write invalid entry name: %r" % (path,))
        if not isinstance(data, (bytes, bytearray)):
            raise LocusArchiveError("file %s must be bytes" % path)
        data = bytes(data)
        if len(data) > LOCUS_LIMITS["maxFileBytes"]:
            raise LocusArchiveError(
                "file %s is %d bytes, over the %d-byte limit"
                % (path, len(data), LOCUS_LIMITS["maxFileBytes"]))
        normalized[path] = data
    files = normalized
    if len(files) + 1 > LOCUS_LIMITS["maxEntries"]:
        raise LocusArchiveError(
            "%d entries would exceed the %d-entry limit"
            % (len(files) + 1, LOCUS_LIMITS["maxEntries"]))
    total_bytes = len(locus_md_bytes) + sum(len(d) for d in files.values())
    if total_bytes > LOCUS_LIMITS["maxTotalBytes"]:
        raise LocusArchiveError(
            "%d total bytes would exceed the %d-byte limit"
            % (total_bytes, LOCUS_LIMITS["maxTotalBytes"]))
    if len(locus_md_bytes) > LOCUS_LIMITS["maxLocusMdBytes"]:
        raise LocusArchiveError(
            "%s is %d bytes, over the %d-byte limit"
            % (LOCUS_MD_NAME, len(locus_md_bytes), LOCUS_LIMITS["maxLocusMdBytes"]))

    # LOCUS.md first, then everything else in path order.
    ordered = [(LOCUS_MD_NAME, locus_md_bytes)]
    ordered.extend(sorted(files.items()))

    chunks = []
    centrals = []
    offset = 0
    for name, data in ordered:
        name_bytes = name.encode("utf-8")
        crc = crc32(data)
        method = 0  # store-only: archive bytes never depend on a deflate engine
        payload = data
        utf8_flag = 0x0800 if any(b > 0x7F for b in name_bytes) else 0
        local = struct.pack(
            "<IHHHHHIIIHH",
            _LOCAL_SIG,
            20,             # version needed
            utf8_flag,      # flags
            method,
            0,              # time 1980-01-01 00:00
            33,             # date 1980-01-01
            crc,
            len(payload),
            len(data),
            len(name_bytes),
            0,              # extra field length
        ) + name_bytes
        chunks.append(local)
        chunks.append(payload)
        centrals.append((name_bytes, utf8_flag, crc, method, len(payload), len(data), offset))
        offset += len(local) + len(payload)

    cd_start = offset
    for name_bytes, utf8_flag, crc, method, comp_size, uncomp_size, local_offset in centrals:
        rec = struct.pack(
            "<IHHHHHHIIIHHHHHII",
            _CENTRAL_SIG,
            20,             # version made by
            20,             # version needed
            utf8_flag,      # flags
            method,
            0,              # time
            33,             # date
            crc,
            comp_size,
            uncomp_size,
            len(name_bytes),
            0,              # extra field length
            0,              # comment length
            0,              # disk number start
            0,              # internal attributes
            0,              # external attributes (regular file)
            local_offset,
        ) + name_bytes
        chunks.append(rec)
        offset += len(rec)

    eocd = struct.pack(
        "<IHHHHIIH",
        _EOCD_SIG,
        0,                  # this disk
        0,                  # central directory disk
        len(centrals),      # entries on this disk
        len(centrals),
        offset - cd_start,  # central directory size
        cd_start,           # central directory offset
        0,                  # comment length
    )
    chunks.append(eocd)
    return b"".join(chunks)


# ---------- read (bounded, central directory only) ----------

def _u16(data, off):
    return data[off] | (data[off + 1] << 8)


def _u32(data, off):
    return struct.unpack_from("<I", data, off)[0]


def _in_bounds(data, off, length):
    return off >= 0 and length >= 0 and off + length <= len(data)


def _inflate_raw_bounded(data, file_cap, total_cap, total_so_far):
    """Inflate a 'deflate-raw' slice with hard byte caps.

    Mirrors the JS inflateRawBounded: the file cap is checked first,
    then the running total; a corrupt stream counts as a short read.
    Returns (data_or_None, count, abort_or_None).
    """
    count = 0
    try:
        out = zlib.decompressobj(-15).decompress(data, file_cap + 1)
        count = len(out)
    except zlib.error:
        return None, count, None
    if count > file_cap:
        return None, count, "file"
    if total_so_far + count > total_cap:
        return None, count, "total"
    return out, count, None


def read_locus_archive(data: bytes, limits=None):
    """Read a .locus archive. Returns {ok, diagnostics, files, locusMd}.

    files (on success) is a dict path -> bytes WITHOUT LOCUS.md.
    """
    lim = dict(LOCUS_LIMITS)
    if limits:
        lim.update(limits)
    diagnostics = []

    # --- End of Central Directory (search the tail, comment <= 64 KiB) ---
    eocd_pos = -1
    max_comment = min(65535, len(data) - 22)
    for back in range(0, max_comment + 1):
        pos = len(data) - 22 - back
        if _u32(data, pos) != _EOCD_SIG:
            continue
        if _u16(data, pos + 20) != back:  # comment must reach EOF exactly
            continue
        eocd_pos = pos
        break
    if eocd_pos < 0:
        return _failed([_diagnostic(
            "locus_not_zip", "",
            "no End of Central Directory record found (not a zip, or truncated)")])

    if eocd_pos >= 20 and _u32(data, eocd_pos - 20) == _ZIP64_LOCATOR_SIG:
        diagnostics.append(_diagnostic(
            "locus_zip64", "",
            "zip64 EOCD locator is present; zip64 archives are not supported"))

    disk_number = _u16(data, eocd_pos + 4)
    cd_start_disk = _u16(data, eocd_pos + 6)
    total_entries = _u16(data, eocd_pos + 10)
    cd_size = _u32(data, eocd_pos + 12)
    cd_offset = _u32(data, eocd_pos + 16)

    if disk_number != 0 or cd_start_disk != 0:
        diagnostics.append(_diagnostic(
            "locus_multi_disk", "",
            "multi-disk archive (disk %d, central directory on disk %d)"
            % (disk_number, cd_start_disk)))
    if total_entries == 0xFFFF or cd_size == 0xFFFFFFFF or cd_offset == 0xFFFFFFFF:
        diagnostics.append(_diagnostic(
            "locus_zip64", "", "zip64 placeholder values in the End of Central Directory"))
    if total_entries > lim["maxEntries"]:
        diagnostics.append(_diagnostic(
            "locus_too_many_entries", "",
            "%d central directory entries, over the %d-entry limit"
            % (total_entries, lim["maxEntries"])))
    if not _in_bounds(data, cd_offset, cd_size) or total_entries * 46 > cd_size:
        diagnostics.append(_diagnostic(
            "locus_not_zip", "",
            "central directory extent is out of bounds (offset %d, size %d)"
            % (cd_offset, cd_size)))
    if diagnostics:
        return _failed(diagnostics)

    # --- Central directory records ---
    entries = []
    seen_names = set()
    off = cd_offset
    for i in range(total_entries):
        if not _in_bounds(data, off, 46) or _u32(data, off) != _CENTRAL_SIG:
            diagnostics.append(_diagnostic(
                "locus_not_zip", "",
                "central directory record %d is out of bounds or has a bad signature" % i))
            return _failed(diagnostics)
        flags = _u16(data, off + 8)
        method = _u16(data, off + 10)
        crc = _u32(data, off + 16)
        comp_size = _u32(data, off + 20)
        uncomp_size = _u32(data, off + 24)
        name_len = _u16(data, off + 28)
        extra_len = _u16(data, off + 30)
        comment_len = _u16(data, off + 32)
        disk_start = _u16(data, off + 34)
        external_attrs = _u32(data, off + 38)
        local_offset = _u32(data, off + 42)
        record_end = off + 46 + name_len + extra_len + comment_len

        if disk_start != 0:
            diagnostics.append(_diagnostic(
                "locus_multi_disk", "", "entry %d starts on disk %d" % (i, disk_start)))
        if comp_size == 0xFFFFFFFF or uncomp_size == 0xFFFFFFFF or local_offset == 0xFFFFFFFF:
            diagnostics.append(_diagnostic(
                "locus_zip64", "", "zip64 placeholder values in central directory entry %d" % i))

        name = None
        name_bytes = None
        if not _in_bounds(data, off + 46, name_len):
            diagnostics.append(_diagnostic(
                "locus_bad_name", "", "entry %d name is out of bounds" % i))
        else:
            name_bytes = data[off + 46:off + 46 + name_len]
            try:
                name = name_bytes.decode("utf-8")
            except UnicodeDecodeError:
                name = None
                diagnostics.append(_diagnostic(
                    "locus_bad_name", "", "entry %d name is not valid UTF-8" % i))
        if name is not None:
            reason = _archive_name_reject_reason(name)
            if reason:
                diagnostics.append(_diagnostic(
                    "locus_bad_name", name,
                    "entry name rejected: %s: %s" % (reason, _js_json(name))))
                name = None  # hostile name — no further per-name accounting
            elif name in seen_names:
                diagnostics.append(_diagnostic(
                    "locus_duplicate_entry", name,
                    "path appears twice in the central directory: %s" % _js_json(name)))
            else:
                seen_names.add(name)

        is_dir = name is not None and name.endswith("/")
        unix_type = (external_attrs >> 16) & 0o170000
        if unix_type == 0o120000:
            diagnostics.append(_diagnostic(
                "locus_symlink", name or "",
                "entry %s is a symbolic link" % (String_or_index(name, i))))
        if flags & 0x0001:
            diagnostics.append(_diagnostic(
                "locus_encrypted", name or "",
                "entry %s is encrypted (general purpose flag bit 0)" % String_or_index(name, i)))
        if method not in (0, 8):
            diagnostics.append(_diagnostic(
                "locus_method_unsupported", name or "",
                "entry %s uses unsupported compression method %d" % (String_or_index(name, i), method)))

        # Local file header: signature + identical name, located FROM the
        # central directory — never parsed as a forward stream.
        data_start = -1
        if not _in_bounds(data, local_offset, 30) or _u32(data, local_offset) != _LOCAL_SIG:
            diagnostics.append(_diagnostic(
                "locus_local_header_mismatch", name or "",
                "entry %s local file header is missing or has a bad signature"
                % String_or_index(name, i)))
        else:
            local_name_len = _u16(data, local_offset + 26)
            local_extra_len = _u16(data, local_offset + 28)
            name_start = local_offset + 30
            if (not _in_bounds(data, name_start, local_name_len)
                    or name_bytes is None
                    or data[name_start:name_start + local_name_len] != name_bytes):
                diagnostics.append(_diagnostic(
                    "locus_local_header_mismatch", name or "",
                    "entry %s local file header name differs from the central directory"
                    % String_or_index(name, i)))
            else:
                data_start = name_start + local_name_len + local_extra_len
        if data_start >= 0 and comp_size != 0xFFFFFFFF and not _in_bounds(data, data_start, comp_size):
            diagnostics.append(_diagnostic(
                "locus_not_zip", "",
                "entry %s data extent is out of bounds (truncated archive)"
                % String_or_index(name, i)))
            data_start = -1

        entries.append({"name": name, "isDir": is_dir, "method": method, "crc": crc,
                        "compSize": comp_size, "uncompSize": uncomp_size, "dataStart": data_start})
        off = record_end
    if diagnostics:
        return _failed(diagnostics)

    # --- Extraction (bounded, counted) ---
    files = {}
    total_bytes = 0
    for entry in entries:
        if entry["isDir"]:
            continue
        name = entry["name"]
        cap = lim["maxLocusMdBytes"] if name == LOCUS_MD_NAME else lim["maxFileBytes"]
        if entry["uncompSize"] > cap:
            diagnostics.append(_diagnostic(
                "locus_file_too_large", name,
                "%s declares %d uncompressed bytes, over the %d-byte limit"
                % (name, entry["uncompSize"], cap)))
            continue
        blob = data[entry["dataStart"]:entry["dataStart"] + entry["compSize"]]
        if entry["method"] == 0:
            if len(blob) > cap:
                diagnostics.append(_diagnostic(
                    "locus_file_too_large", name,
                    "%s is %d stored bytes, over the %d-byte limit" % (name, len(blob), cap)))
                continue
            if total_bytes + len(blob) > lim["maxTotalBytes"]:
                diagnostics.append(_diagnostic(
                    "locus_total_too_large", name,
                    "archive exceeded the %d-byte total while reading %s (%d bytes)"
                    % (lim["maxTotalBytes"], name, len(blob))))
                continue
            res_data, res_count, res_abort = bytes(blob), len(blob), None
        else:
            res_data, res_count, res_abort = _inflate_raw_bounded(
                blob, cap, lim["maxTotalBytes"], total_bytes)
        if res_abort == "file":
            diagnostics.append(_diagnostic(
                "locus_file_too_large", name,
                "%s exceeded the %d-byte limit while inflating (aborted after %d bytes)"
                % (name, cap, res_count), bytesRead=res_count))
            continue
        if res_abort == "total":
            diagnostics.append(_diagnostic(
                "locus_total_too_large", name,
                "archive exceeded the %d-byte total while inflating %s (aborted after %d bytes)"
                % (lim["maxTotalBytes"], name, res_count), bytesRead=res_count))
            continue
        total_bytes += res_count
        if res_count != entry["uncompSize"] or res_data is None:
            diagnostics.append(_diagnostic(
                "locus_size_mismatch", name,
                "%s inflated to %d bytes but the central directory declares %d"
                % (name, res_count, entry["uncompSize"])))
            continue
        actual_crc = crc32(res_data)
        if actual_crc != entry["crc"]:
            diagnostics.append(_diagnostic(
                "locus_crc_mismatch", name,
                "%s CRC-32 mismatch: central directory declares %08x, data hashes to %08x"
                % (name, entry["crc"], actual_crc)))
            continue
        files[name] = res_data
    if diagnostics:
        return _failed(diagnostics)

    # --- LOCUS.md (the one meta file, decoded strictly) ---
    if LOCUS_MD_NAME not in files:
        return _failed([_diagnostic(
            "locus_missing_locus_md", LOCUS_MD_NAME,
            "no " + LOCUS_MD_NAME + " at the archive root")])
    try:
        locus_md = files[LOCUS_MD_NAME].decode("utf-8")
    except UnicodeDecodeError:
        return _failed([_diagnostic(
            "locus_bad_locus_md", LOCUS_MD_NAME, LOCUS_MD_NAME + " is not valid UTF-8")])
    del files[LOCUS_MD_NAME]
    return {"ok": True, "diagnostics": [], "files": files, "locusMd": locus_md}


def String_or_index(name, i):
    # Mirrors the JS `name === null ? String(i) : JSON.stringify(name)` wording.
    return _js_json(name) if name is not None else str(i)


# ---------- LOCUS.md ----------

def _split_locus_md_blocks(text):
    lines = text.split("\n")
    blocks = []
    i = 0
    while i < len(lines):
        if lines[i].strip() != "```locus-manifest":
            i += 1
            continue
        close = -1
        for j in range(i + 1, len(lines)):
            if lines[j].strip() == "```":
                close = j
                break
        if close < 0:
            break  # unterminated block is not a complete block
        blocks.append({"start": i, "end": close, "json": "\n".join(lines[i + 1:close])})
        i = close + 1
    return lines, blocks


def _body_without_blocks(lines, blocks):
    out = []
    i = 0
    for b in blocks:
        while i < b["start"]:
            out.append(lines[i])
            i += 1
        out.append("")  # the block leaves exactly one empty line in place
        i = b["end"] + 1
    while i < len(lines):
        out.append(lines[i])
        i += 1
    return "\n".join(out)


def _validate_locus_manifest(manifest):
    diagnostics = []
    allowed = ["schemaVersion", "id", "version", "author", "purpose", "files"]
    if isinstance(manifest, dict):
        for k in manifest.keys():
            if k not in allowed:
                diagnostics.append(_diagnostic(
                    "locus_manifest_field", "", "unknown manifest field: " + _js_json(k)))
    if not isinstance(manifest, dict) or "schemaVersion" not in manifest:
        diagnostics.append(_diagnostic(
            "locus_manifest_field", "", "missing field: schemaVersion"))
    elif not (isinstance(manifest["schemaVersion"], int)
              and not isinstance(manifest["schemaVersion"], bool)
              and manifest["schemaVersion"] == 1):
        diagnostics.append(_diagnostic(
            "locus_manifest_field", "", "schemaVersion must be the number 1"))
    for field, max_len in (("id", None), ("version", None), ("author", 200), ("purpose", 2000)):
        if not isinstance(manifest, dict) or field not in manifest:
            diagnostics.append(_diagnostic(
                "locus_manifest_field", "", "missing field: " + field))
            continue
        value = manifest[field]
        if not isinstance(value, str):
            diagnostics.append(_diagnostic(
                "locus_manifest_field", "", field + " must be a string"))
        elif max_len is not None and len(value) > max_len:
            diagnostics.append(_diagnostic(
                "locus_manifest_field", "",
                "%s is %d characters, over the %d-character limit" % (field, len(value), max_len)))
    if isinstance(manifest, dict):
        for field in ("id", "version"):
            if isinstance(manifest.get(field), str) and not len(manifest[field]):
                diagnostics.append(_diagnostic(
                    "locus_manifest_field", "", field + " must be a non-empty string"))
    if not isinstance(manifest, dict) or "files" not in manifest:
        diagnostics.append(_diagnostic(
            "locus_manifest_field", "", "missing field: files"))
        return diagnostics, None
    if not isinstance(manifest.get("files"), list):
        diagnostics.append(_diagnostic(
            "locus_manifest_field", "", "files must be an array"))
        return diagnostics, None
    return diagnostics, _validate_manifest_files(manifest["files"], diagnostics)


def _validate_manifest_files(file_list, diagnostics):
    out = []
    for item in file_list:
        if not isinstance(item, dict) or isinstance(item, list):
            diagnostics.append(_diagnostic(
                "locus_manifest_files", "", "files entry must be a JSON object"))
            continue
        keys = sorted(item.keys())
        expected_keys = ["path", "sha256", "size"]
        if keys != expected_keys:
            diagnostics.append(_diagnostic(
                "locus_manifest_files", "",
                "files entry must have exactly the fields { path, size, sha256 }"))
            continue
        path, size, sha256 = item["path"], item["size"], item["sha256"]
        reason = _archive_name_reject_reason(path)
        if reason:
            diagnostics.append(_diagnostic(
                "locus_manifest_files", "",
                "files entry path rejected: %s: %s" % (reason, _js_json(path))))
            continue
        if path == LOCUS_MD_NAME:
            diagnostics.append(_diagnostic(
                "locus_manifest_files", "", "files must not contain " + LOCUS_MD_NAME))
            continue
        if not (isinstance(size, int) and not isinstance(size, bool) and size >= 0):
            diagnostics.append(_diagnostic(
                "locus_manifest_files", "",
                "files entry %s size must be a non-negative integer" % _js_json(path)))
            continue
        if not isinstance(sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", sha256):
            diagnostics.append(_diagnostic(
                "locus_manifest_files", "",
                "files entry %s sha256 must be 64 lowercase hex characters" % _js_json(path)))
            continue
        out.append({"path": path, "size": size, "sha256": sha256})
    for i in range(1, len(out)):
        prev, cur = out[i - 1]["path"], out[i]["path"]
        if prev == cur:
            diagnostics.append(_diagnostic(
                "locus_manifest_files", "", "duplicate path in files: " + _js_json(cur)))
        elif prev > cur:
            diagnostics.append(_diagnostic(
                "locus_manifest_files", "",
                "files must be sorted by path: %s before %s" % (_js_json(prev), _js_json(cur))))
    return out


def parse_locus_md(text: str):
    """Parse the LOCUS.md manifest block. Returns {ok, diagnostics, manifest, body}."""
    if not isinstance(text, str):
        raise TypeError("parse_locus_md requires a string")
    lines, blocks = _split_locus_md_blocks(text)
    if len(blocks) == 0:
        return _failed_parse([_diagnostic(
            "locus_manifest_missing", "", "no ```locus-manifest code block found")])
    if len(blocks) > 1:
        return _failed_parse([_diagnostic(
            "locus_manifest_multiple", "",
            "%d ```locus-manifest code blocks found, exactly one is allowed" % len(blocks))])
    block = blocks[0]
    try:
        manifest = json.loads(block["json"])
    except ValueError as e:
        return _failed_parse([_diagnostic(
            "locus_manifest_json", "",
            "the locus-manifest block is not valid JSON: %s" % (e,))])
    if not isinstance(manifest, dict):
        return _failed_parse([_diagnostic(
            "locus_manifest_json", "", "the locus-manifest block must contain a JSON object")])
    diagnostics, files = _validate_locus_manifest(manifest)
    if diagnostics:
        return _failed_parse(diagnostics)
    return {
        "ok": True,
        "diagnostics": [],
        "manifest": {
            "schemaVersion": manifest["schemaVersion"],
            "id": manifest["id"],
            "version": manifest["version"],
            "author": manifest["author"],
            "purpose": manifest["purpose"],
            "files": files,
        },
        "body": _body_without_blocks(lines, blocks),
    }


def _failed_parse(diagnostics):
    return {"ok": False, "diagnostics": diagnostics, "manifest": None, "body": None}


def render_locus_md(body: str, manifest) -> str:
    """body + the ```locus-manifest fenced block — byte-identical to JS renderLocusMd."""
    text = "" if body is None else body
    if not isinstance(text, str):
        raise TypeError("render_locus_md body must be a string")
    body_part = text if (len(text) and text.endswith("\n")) or not len(text) else text + "\n"
    return body_part + "```locus-manifest\n" + canonical_json(manifest) + "\n```\n"


# ---------- manifest helpers ----------

def manifest_digest(manifest) -> str:
    return sha256_hex(canonical_json_bytes(manifest))


def verify_locus_files(manifest, files):
    """Returns {missing, extra, mismatched} — mirrors verifyLocusFiles."""
    file_list = manifest.get("files") if isinstance(manifest, dict) and isinstance(
        manifest.get("files"), list) else []
    expected = {f["path"]: f for f in file_list}
    missing = []
    mismatched = []
    for f in file_list:
        if f["path"] not in files:
            missing.append(f["path"])
            continue
        data = files[f["path"]]
        size = len(data)
        sha = sha256_hex(data)
        if size != f["size"] or sha != f["sha256"]:
            mismatched.append({
                "path": f["path"],
                "expected": {"size": f["size"], "sha256": f["sha256"]},
                "actual": {"size": size, "sha256": sha},
            })
    extra = sorted(p for p in files.keys() if p not in expected)
    missing.sort()
    mismatched.sort(key=lambda m: m["path"])
    return {"missing": missing, "extra": extra, "mismatched": mismatched}


def repin_manifest(manifest, files):
    """manifest with files re-pinned to the ACTUAL bytes — mirrors repinManifest."""
    if LOCUS_MD_NAME in files:
        raise LocusArchiveError("repinManifest files must not contain " + LOCUS_MD_NAME)
    out = dict(manifest)
    out["files"] = build_files_list(files)
    return out


def build_files_list(files):
    return [
        {"path": path, "size": len(files[path]), "sha256": sha256_hex(files[path])}
        for path in sorted(files.keys())
    ]


def expected_package_paths(lock):
    """capability.json + one descriptor per component + every lock.files path, sorted."""
    if not isinstance(lock, dict):
        raise TypeError("expected_package_paths requires a lock object")
    out = {"capability.json"}
    for p in lock.get("plugins") or []:
        out.add("plugins/%s/plugin.json" % p["descriptor"]["id"])
    for s in lock.get("skills") or []:
        out.add("skills/%s/skill.json" % s["descriptor"]["id"])
    for m in lock.get("mcps") or []:
        out.add("mcp/%s/mcp.json" % m["id"])
    for f in lock.get("files") or []:
        out.add(f["path"])
    return sorted(out)
