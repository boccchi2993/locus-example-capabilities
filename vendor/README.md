# vendor/ — 第三方 wheel

官方参考能力携带的第三方 Python wheel（locus-product `docs/DECISIONS.md` D13）
集中放在本目录：同一个 wheel 只存一份（提交进 git），多个能力通过
`py-<规范化包名>` 的 plugin id 共享同一组件。能力目录本身不放 wheel，
构建时由 `scripts/build.mjs` 从本目录生成（见根 README 的「第三方 wheel」）。

## 内容

- `wheels/` — wheel 文件本体。
- `wheels.json` — wheel 清单（字段说明见根 README 的「第三方 wheel」一节）。
- `pyodide-lock-0.26.4.json` — Pyodide 0.26.4 官方 lock，是 `source` 为
  `"pyodide-lock"` 的 wheel 的 sha256 与文件名依据。

## pyodide-lock-0.26.4.json 的指纹

- 下载地址: https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide-lock.json
- sha256: `cd50b49de944c579045e122fe8628b31f9ce446379f032f36c05e273d38766e0`
- 下载时间: 2026-10-24 14:42（UTC+8）

`npm run check` 的 vendor 一致性检查会把本文件的实际 sha256 与上面这条
记录比对；更换该文件时必须同步更新这条记录。lock 的 `info` 摘要：
Pyodide 0.26.4 / CPython 3.12.1 / abi 2024_0 / emscripten_3_1_58 / wasm32，
共 310 个包。

## 当前清单的来源说明

清单共 9 项（`wheels.json`），分两类：

- **纯 Python wheel（`none-any`，`source: "pypi"`）**：openpyxl 3.1.5、
  et_xmlfile 2.0.0、typing_extensions 4.16.0、XlsxWriter 3.3.0、
  python-docx 1.2.0、python-pptx 1.0.2、pypdf 6.21.2。
  Pyodide 0.26.4 的 pyodide-lock.json 不含这些发行包，sha256 以 PyPI JSON
  API 公布的 `digests.sha256` 为准（`npm run verify-vendor` 在线核验）。
- **Pyodide 官方编译的原生 wheel（cp312 + `pyodide_2024_0_wasm32`，
  `source: "pyodide-lock"`）**：lxml 5.2.1、pillow 10.2.0。sha256 与文件名
  以本目录 lock 文件的记录为准（lock 里 `depends` 均为空）。

各 wheel 的 METADATA `License` / `License-Expression`（即 `wheels.json` 的
`license` 字段）：lxml、pypdf 为 BSD-3-Clause，XlsxWriter 为 BSD-2-Clause，
openpyxl、et_xmlfile、python-docx、python-pptx 为 MIT，pillow 为 HPND，
typing_extensions 为 PSF-2.0。

lxml 与 pillow 的下载来源是 Pyodide 官方 CDN
`https://cdn.jsdelivr.net/pyodide/v0.26.4/full/<file_name>`；pypi 类 wheel
的下载来源是 PyPI JSON API `urls[].url`（files.pythonhosted.org）。
