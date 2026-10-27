# ============================================================
#  locust_capability_sdk._canon — canonical JSON + sha256 helpers.
#
#  Python port of locus-product src/capability-package.js
#  canonicalJson(): sorted object keys, no whitespace, arrays in
#  order, UTF-8 without ASCII escaping. The byte output must stay
#  IDENTICAL to the JS implementation — the LOCUS.md manifest, the
#  bundle lock serialization and the manifest digest all flow
#  through here, and the cross-check (tests/sdk-crosscheck.test.mjs)
#  pins the equality.
# ============================================================

import hashlib
import json


def canonical_json(value) -> str:
    """Canonical JSON string: sorted keys, ','/'/'  separators.

    Byte-identical to the JS canonicalJson() for the plain data this
    SDK handles (str / int / bool / None / list / dict).
    """
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def canonical_json_bytes(value) -> bytes:
    return canonical_json(value).encode("utf-8")


def sha256_hex(data: bytes) -> str:
    """Lowercase hex sha256 — identical to the harness sha256Hex()."""
    return hashlib.sha256(data).hexdigest()
