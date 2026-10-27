# Capability Authoring

Use this skill when the user asks for a new capability ("make me a capability
that …", "做一个……的能力"). You design the capability, write the project, test
it, and package it into a deterministic `.locus` file the user imports in
Settings. The judgment and the rules live here; the machinery lives in this
capability's plugin — `import locus_capability_sdk as sdk` works in any Python
block, and so does the command line `python -m locus_capability_sdk`.

## 1. Judge what to build

Start by asking whether a new capability is needed at all:

- If your existing tools can do the task in this conversation, just do it.
  A capability is for work that will be reused by later tasks, not for one-offs.
- Knowledge or process guidance only (how to structure a report, how to review
  a document) → a **skill** alone.
- A deterministic computation that later tasks will reuse (parse a file format,
  score text, convert units) → a **plugin**: a pure-Python wheel the runtime
  installs offline before tasks run.
- The task needs an external HTTP API → a **skill that uses curl with a
  declared credential**; the user connects their key once and it is injected
  only into approved requests that stay inside the declared target.
- Not supported in this version: MCP servers, downloading third-party wheels,
  or plugin code that opens network connections. A plugin imports only the
  Python standard library plus pandas/numpy (preinstalled in Locus Python).

Skills and plugins usually pair up — the plugin computes, the skill teaches
when and how to call it. If a request mentions an API key, that is a credential
declared in capability.json; never hard-code keys in code or text.

## 2. Project layout and rules

A capability project is one directory:

```
<project>/
  locus.json                       # author, title, purpose, changelog (not packaged)
  capability.json                  # the capability descriptor
  skills/<skill-id>/skill.json     # one descriptor per skill
  skills/<skill-id>/SKILL.md       # the skill text (what the model reads)
  plugins/<plugin-id>/plugin.json  # one descriptor per plugin
  plugins/<plugin-id>/artifacts/   # the wheel, written by build_wheel
  src/<python-package>/...         # plugin source (not packaged)
  tests/...                        # optional (not packaged)
```

Where to put the project: `/mnt/workspace/capabilities/<id>/` when
`/mnt/workspace` is mounted, otherwise `/home/locus/capability-projects/<id>/`.
Files outside the declared package (src/, tests/, locus.json, README.md) are
ignored by the packager — they never enter the `.locus` and never cause errors.

Rules the SDK enforces (`sdk.validate` prints one diagnostic per violation):

- **ids** are lowercase letters, digits, dot, dash, underscore (`text-tools`,
  not `Text Tools`); the project directory name is the capability id.
- **versions** have three numeric parts (`1.0.0`). Every repack of changed
  content bumps the patch part first (`1.0.1`, `1.0.2`, …) — the version is in
  the `.locus` filename and in the user's replace prompt, so the same version
  must never mean two different files.
- **capability.json** fields: schemaVersion 1; id, version, displayName,
  description, plugins, skills, mcps. `credentials` only when the task really
  needs an external API.
- **plugin.json**: runtime "python", authority "none", `provides.pythonImports`
  listing the exact importable package names, and exactly one artifact
  `artifacts/<dist>-<version>-py3-none-any.whl`.
- **skill.json**: id, version, displayName, description, and `"source":
  "SKILL.md"`.
- **locus.json** (not packaged): author, title, purpose (both go into the
  package manifest), changelog (a list; the first entry notes the date of the
  first version).
- **credentials**: name (`UPPER_SNAKE`), label, description, origin, pathPrefix,
  header (`Authorization`, `X-Api-Key`, or a custom `X-…` name), scheme
  (`Bearer` or omitted). The origin must be an `https://` public DNS host with
  no path. **Never declare a credential for an `http://` address or for a
  private, loopback or local host** (localhost, 127.0.0.1, 10.x, 192.168.x,
  `.local`, `.internal`, …) — the SDK refuses to package it and import refuses
  to install it.
- **curl in skill text**: a credential variable may appear only in a request
  header's value, spelled exactly as declared — `-H "Authorization: Bearer
  $NAME"` with scheme Bearer, or `-H "X-Api-Key: $NAME"` without — and the
  request URL must stay inside the credential's origin + pathPrefix. `$NAME` in
  a URL, body, or any other command is left as literal text and rejected by the
  skill rules. Never write a real key value; the variable is the only accepted
  form.

## 3. Locus environment limits

- One Python program = one separate bash call, wrapped in a quoted heredoc:
  `python <<'PY'` … `PY`. Do not chain a Python heredoc with other commands in
  the same call, and do not use backslash line continuations.
- There is no network access and no installing packages at authoring time —
  that is why plugin imports are limited to the standard library plus
  pandas/numpy.
- `/mnt/upload` is read-only input; `/mnt/workspace` persists across tasks;
  `/mnt/download` is where deliverables for the user go (the `.locus` is built
  there); `/tmp` is scratch space.
- Helpers defined in an earlier Python block stay alive while the worker lives.
  If a later block fails with `NameError`, the worker restarted: re-run the
  earlier block, then retry.

## 4. Workflow

1. **Confirm the need.** Restate the request as one sentence; ask one or two
   questions only when the behavior is genuinely ambiguous.
2. **Write the project files** (layout in §2). Keep the first version small:
   one skill, at most one plugin.
3. **Test the plugin from source**: put `src/` on `sys.path`, import the
   package, assert the outputs — all in one bash call. Fix failures here,
   before packaging.
4. **Package** (one bash call):
   `sdk.build_wheel("src", "<dist>", "<version>", "plugins/<plugin-id>/artifacts", summary=…)`
   → `sdk.validate(".")` — the diagnostics list must be empty; every message
   tells you which file and rule failed → `sdk.build(".", "/mnt/download")`
   → `sdk.inspect(result["path"])` and check the summary (id, version,
   components, credentials, file count).
5. **Deliver.** Tell the user:
   - the complete path of the `.locus` file;
   - the import step: open **Settings → Capabilities → Import from path** and
     paste that path;
   - what they will see after import: the components (each plugin and skill by
     display name) and, for every declared credential, the exact target
     address (origin + path prefix) their key would be sent to — if there are
     no credentials, say so;
   - that they should tell you once the import is done.
   Do not try to import the package yourself — you cannot; importing is the
   user's explicit click, and that click is the trust decision that turns your
   output into an installed capability.
6. **Read the import report.** After the user says it is imported, read the
   newest JSON report in `/home/locus/capability-imports/` (one file per import
   attempt, newest first by timestamp name). `ok` true → show how to use the
   capability in a next task. `ok` false or the user cancelled → fix the listed
   diagnostics, bump the patch version, rebuild, and deliver again.
7. **Keep credentials honest.** A credential declaration is a promise about
   where the user's key may be sent. Declare the narrowest origin and prefix
   that work, and never change them on a repack without saying so — the user
   must re-confirm changed credentials.

## 5. Worked example: reference-text-analysis

**This is a worked example — do not run it as-is.** Adapt ids, names and code
to the real request. It shows the complete flow for: "帮我做一个文本分析能力：
统计字数、找出出现最多的词" — one plugin plus one skill.

**capability.json**

```json
{
  "schemaVersion": 1,
  "capability": {
    "id": "reference-text-analysis",
    "version": "1.0.0",
    "displayName": "Reference Text Analysis",
    "description": "Count words and find the most frequent terms in text with a local Python plugin.",
    "plugins": ["reference-text-tools"],
    "skills": ["text-analysis-workflow"],
    "mcps": []
  }
}
```

**locus.json**

```json
{
  "title": "reference-text-analysis",
  "author": "locus-owner",
  "purpose": "Count words and find the most frequent terms in text with a local Python plugin.",
  "changelog": [
    "1.0.0（2026-10-27）：首个版本"
  ]
}
```

**skills/text-analysis-workflow/skill.json**

```json
{
  "schemaVersion": 1,
  "skill": {
    "id": "text-analysis-workflow",
    "version": "1",
    "displayName": "Text Analysis Workflow",
    "description": "How to analyze text with the reference-text-tools plugin."
  },
  "source": "SKILL.md"
}
```

**skills/text-analysis-workflow/SKILL.md**

````markdown
# Text Analysis Workflow

Use the `reference-text-tools` plugin (import `reference_text_tools`) for word
counts and top-term extraction. It is deterministic and offline.

## Steps

1. Put the text in a Python string (read the file with `open()` when it lives
   on disk).
2. `word_count(text)` → the number of words; `top_terms(text, 5)` → the five
   most frequent terms as `(term, count)` pairs, most common first, ties
   broken alphabetically.
3. Report both results; quote the top terms with their counts.

```python
import reference_text_tools as t

sample = "Locus runs capabilities locally. Locus keeps files local."
print(t.word_count(sample))
print(t.top_terms(sample, 3))
```
````

**plugins/reference-text-tools/plugin.json**

```json
{
  "schemaVersion": 1,
  "plugin": {
    "id": "reference-text-tools",
    "version": "1.0.0",
    "displayName": "Reference Text Tools",
    "description": "Deterministic word count and top-terms extraction for plain text.",
    "runtime": "python",
    "authority": "none",
    "provides": {
      "pythonImports": ["reference_text_tools"]
    }
  },
  "artifacts": [
    {
      "path": "artifacts/reference_text_tools-1.0.0-py3-none-any.whl",
      "format": "python-wheel"
    }
  ]
}
```

**src/reference_text_tools/__init__.py**

```python
"""Reference text tools: deterministic word counting and term extraction.

Pure Python standard library; no network access, no third-party imports.
"""

import re
from collections import Counter

_WORD_RE = re.compile(r"[A-Za-z0-9']+")


def word_count(text):
    """Number of words: maximal runs of ASCII letters, digits or apostrophes."""
    if not isinstance(text, str):
        raise TypeError("word_count expects a string")
    return len(_WORD_RE.findall(text))


def top_terms(text, n=5):
    """The *n* most frequent lowercased terms as (term, count) pairs.

    Ordered by descending count, ties broken alphabetically — deterministic.
    """
    if not isinstance(text, str):
        raise TypeError("top_terms expects a string")
    if isinstance(n, bool) or not isinstance(n, int):
        raise TypeError("top_terms expects an integer n")
    if n < 0:
        raise ValueError("n must not be negative")
    counts = Counter(w.lower() for w in _WORD_RE.findall(text))
    return sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:n]
```

Test the plugin straight from `src/` — one bash call:

```bash
cd /mnt/workspace/capabilities/reference-text-analysis
python <<'PY'
import sys
sys.path.insert(0, "src")
import reference_text_tools as t
assert t.word_count("Hello world, hello Locus!") == 4
assert t.top_terms("one two one three one two", 2) == [("one", 3), ("two", 2)]
assert t.word_count("") == 0 and t.top_terms("", 5) == []
print("plugin tests passed")
PY
```

Build the wheel into the project, validate (the diagnostics list must print as
`[]`), package into `/mnt/download`, and inspect the result — one bash call:

```bash
cd /mnt/workspace/capabilities/reference-text-analysis
python <<'PY'
import json
import locus_capability_sdk as sdk

sdk.build_wheel("src", "reference_text_tools", "1.0.0",
                "plugins/reference-text-tools/artifacts",
                summary="Deterministic word count and top-terms extraction for plain text.")
diagnostics = sdk.validate(".")
assert diagnostics == [], diagnostics
result = sdk.build(".", "/mnt/download")
assert result["ok"], result["diagnostics"]
summary = sdk.inspect(result["path"])
assert summary["ok"], summary["diagnostics"]
print(json.dumps({"path": result["path"], "sha256": result["sha256"],
                  "bytes": result["bytes"], "components": summary["components"]}))
PY
```

Delivery for this example reads:

> The capability is packaged at `/mnt/download/reference-text-analysis-1.0.0.locus`.
> Open Settings → Capabilities → Import from path and paste that path. After
> import you will see the plugin "Reference Text Tools" and the skill "Text
> Analysis Workflow"; it declares no credentials, so there is nothing to
> connect. Tell me once it is imported.

If a later change requires a repack, bump the version to `1.0.1` first, rerun
the build block, and deliver the new path with the same three-part message.

## 6. Anti-patterns

- Editing Locus's own source or settings to register the capability, or
  hand-computing hashes and hand-zipping the archive — the SDK plus the user's
  import click are the only path.
- Shipping extra skills/plugins the user did not ask for, or a credential
  declared "just in case" or pointed at an `http://` or private address.
- Repacking edited content under the same version instead of bumping the patch
  part first.
