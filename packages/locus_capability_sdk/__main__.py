# ============================================================
#  locus_capability_sdk command line — usable from plain CPython
#  (CAPABILITY-AUTHORING §10: building a capability must not require
#  running Locus).
#
#  Usage:
#    python -m locus_capability_sdk validate <project_dir>
#    python -m locus_capability_sdk build <project_dir> <out_dir>
#    python -m locus_capability_sdk build-wheel <src_dir> <dist> <version> <out_dir> [--summary S]
#    python -m locus_capability_sdk inspect <path/to.pkg.locus>
#    python -m locus_capability_sdk wheel-info <whl>
#    python -m locus_capability_sdk verify-wheel <whl> <metadata.json>
#    python -m locus_capability_sdk plugin-from-wheel <project_dir> <whl>
#
#  Every subcommand prints one JSON document on stdout. Exit code 0 =
#  operation succeeded (validate: no diagnostics; build: file written;
#  inspect: ok), 1 = clean failure (diagnostics are the JSON), 2 =
#  usage / fatal error (message on stderr).
# ============================================================

import json
import sys

from . import (  # noqa: E402
    SdkError,
    build,
    build_wheel,
    inspect,
    plugin_from_wheel,
    validate,
    verify_wheel,
    wheel_info,
)
from ._version import __version__  # noqa: E402


def _print(doc):
    json.dump(doc, sys.stdout, ensure_ascii=False, sort_keys=True)
    sys.stdout.write("\n")


def main(argv):
    import os

    if not argv or argv[0] in ("-h", "--help"):
        sys.stderr.write(__doc__ or "")
        return 2
    cmd = argv[0]
    args = argv[1:]
    try:
        if cmd == "validate":
            if len(args) != 1:
                sys.stderr.write("usage: locus_capability_sdk validate <project_dir>\n")
                return 2
            diagnostics = validate(args[0])
            _print({"ok": not diagnostics, "diagnostics": diagnostics})
            return 0 if not diagnostics else 1

        if cmd == "build":
            if len(args) != 2:
                sys.stderr.write("usage: locus_capability_sdk build <project_dir> <out_dir>\n")
                return 2
            result = build(args[0], args[1])
            _print(result)
            return 0 if result["ok"] else 1

        if cmd == "build-wheel":
            summary = ""
            rest = []
            i = 0
            while i < len(args):
                if args[i] == "--summary":
                    if i + 1 >= len(args):
                        sys.stderr.write("build-wheel: --summary needs a value\n")
                        return 2
                    summary = args[i + 1]
                    i += 2
                    continue
                rest.append(args[i])
                i += 1
            if len(rest) != 4:
                sys.stderr.write("usage: locus_capability_sdk build-wheel "
                                 "<src_dir> <dist> <version> <out_dir> [--summary S]\n")
                return 2
            src_dir, dist, version, out_dir = rest
            path = build_wheel(src_dir, dist, version, out_dir, summary)
            import hashlib
            with open(path, "rb") as f:
                digest = hashlib.sha256(f.read()).hexdigest()
            _print({"path": path, "sha256": digest})
            return 0

        if cmd == "inspect":
            if len(args) != 1:
                sys.stderr.write("usage: locus_capability_sdk inspect <path.pkg.locus>\n")
                return 2
            result = inspect(args[0])
            _print(result)
            return 0 if result["ok"] else 1

        if cmd == "wheel-info":
            if len(args) != 1:
                sys.stderr.write("usage: locus_capability_sdk wheel-info <whl>\n")
                return 2
            _print(wheel_info(args[0]))
            return 0

        if cmd == "verify-wheel":
            if len(args) != 2:
                sys.stderr.write(
                    "usage: locus_capability_sdk verify-wheel <whl> <metadata.json>\n")
                return 2
            result = verify_wheel(args[0], args[1])
            _print(result)
            return 0 if result["ok"] else 1

        if cmd == "plugin-from-wheel":
            if len(args) != 2:
                sys.stderr.write(
                    "usage: locus_capability_sdk plugin-from-wheel <project_dir> <whl>\n")
                return 2
            result = plugin_from_wheel(args[0], args[1])
            _print(result)
            return 0

        if cmd in ("-V", "--version"):
            _print({"version": __version__})
            return 0

        sys.stderr.write("unknown command: %s\n%s" % (cmd, __doc__ or ""))
        return 2
    except SdkError as e:
        sys.stderr.write("error: %s\n" % e)
        return 2
    except (OSError, ValueError) as e:
        sys.stderr.write("error: %s\n" % e)
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
