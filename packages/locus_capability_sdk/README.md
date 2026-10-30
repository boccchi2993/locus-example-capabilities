# locus_capability_sdk

Locus 能力创作 SDK——纯 Python 3.12 标准库实现，用于校验、构建与查看
Capability 项目与 `.locus` 包。与 locus-product 的 JS 打包管线
（本仓库锁定的提交）**逐字节一致**，由仓库 CI 的交叉校验
（`tests/sdk-crosscheck.test.mjs` XC1–XC8）保证：

- XC1：SDK 与 `scripts/build.mjs` 构建的 `.locus` 逐字节相同；
- XC2：validate 的结论与诊断码集合和 JS（build + check）一致；
- XC3：inspect 的摘要与 product 的导入检查一致；
- XC4/XC6：wheel 可安装、RECORD 正确、从源码重建逐字节相同；
- XC5：只导入标准库；
- XC7：`plugin_from_wheel` 的规范描述符与 JS `vendorPluginManifest`
  （从 wheel 字节推导）逐字节一致；
- XC8：16 MiB wheel 上限规则（`wheel-too-large`）两边同样触发。

`.locus` 为 **store-only**（zip method 0，2026-10-28 所有者决定）：
条目不压缩，包字节只取决于输入内容，在任何引擎（Node、浏览器、
CPython）上构建结果都相同。

## API

```python
import locus_capability_sdk as sdk

sdk.validate(project_dir)
# -> [{ "code", "path", "message" }]，空列表 = 通过。
# 覆盖 product 项目校验（package_* 诊断码）、D13 wheel 规则
# （wheel-* 诊断码）与 skill 规范（literal-key / undeclared-variable /
# url-outside-prefix，与 scripts/skill-spec.mjs 的规则名一致）。
# 与 JS 构建管线相同：项目里不属于包的文件（src/、tests/、README.md、
# locus.json 等）被静默忽略；py- plugin 缺本地实现时从 vendor/wheels.json
# 材料化（在仓库内时）。

sdk.build_wheel(src_dir, dist, version, out_dir, summary="")
# -> wheel 路径。把 src_dir 下的一个顶层包（含 __init__.py 的目录）
# 或模块（*.py）打成 {dist}-{version}-py3-none-any.whl。
# 确定性：条目按文件名排序、时间戳固定 1980-01-01、权限 0o644、
# STORED 压缩；METADATA（Metadata-Version 2.1）、WHEEL、RECORD
# （sha256=<urlsafe base64 无填充>, 大小；RECORD 自身一行留空）。
# dist 按 PEP 427 转义。

sdk.build(project_dir, out_dir)
# -> { ok, path, sha256, bytes }；校验不通过时 { ok: False, diagnostics }
# 且不产出文件。闸门是 validate 的全部规则（项目规则、D13 wheel 规则、
# skill 规范）——JS 的 scripts/build.mjs 把 skill 规范留给 check.mjs，
# SDK 在打包前就拦截。locus.json（author/title/purpose/changelog）缺失
# 或字段不合法时抛 SdkError——与 scripts/build.mjs 的约定相同。

sdk.inspect(locus_path)
# -> 与 product 导入检查同含义的摘要：
#    { ok, diagnostics, id, version, author, purpose, body, digest,
#      mismatched, components: {plugins, skills, mcps},
#      credentials, fileCount, totalBytes }

# ---- 以下为 D14 第三方 wheel 工具（完全离线，只用标准库）----

sdk.wheel_info(path)
# -> { filename, name, normalized, version, summary,
#      tags: {python, abi, platform}, pure, platform_ok,
#      requires, imports, bytes, sha256 }。
# name/summary 来自 METADATA；tags 来自 wheel 文件名；imports 由 RECORD
# 推导（顶层包目录 + 顶层 .py 模块，排序去重）；requires 是原始
# Requires-Dist 列表；platform_ok 沿用 D13 平台规则。

sdk.verify_wheel(wheel_path, metadata_path)
# -> { ok, source: "pypi"|"pyodide-lock"|None, filename, expected,
#      actual, diagnostics: [{code, message}] }。
# metadata_path 是 curl 下载的发布方元数据：PyPI 版本 JSON 在 urls[] 里
# 按 filename 找条目比对 digests.sha256；pyodide-lock.json 在 packages
# 里按 file_name 找条目比对 sha256，并核对 info.version 为 0.26.4。
# 诊断码：unknown-format / entry-not-found / missing-digest /
# sha256-mismatch / lock-version-unsupported。不联网。

sdk.plugin_from_wheel(project_dir, wheel_path)
# -> { id, path, descriptor }。生成规范描述符
#    plugins/py-<规范化发行名>/plugin.json（displayName = METADATA Name
#    原样；description = Summary 去首尾空白，空则 "<Name> <Version>"；
#    provides.pythonImports 由 RECORD 推导；runtime python、authority
#    none、恰好一个 artifacts/<wheel 文件名>、format python-wheel）并把
#    wheel 复制到 plugins/<id>/artifacts/。幂等：同一 wheel 重复调用
#    字节不变；同 id 的 artifacts/ 下已有不同文件（不同字节或不同
#    文件名）时拒绝（D14 第 5 条）。

sdk.test_site(wheel_paths, site="/opt/locus-site")
# -> { site, installed, skipped }。把各 wheel 解压进 site 并插到
#    sys.path 最前，用于打包前的可导入性测试。site 先规范化（折叠
#    开头斜杠 + posixpath.normpath）再检查：必须不在任何数据挂载点下
#    （/tmp、/home/locus、/mnt/... 连同 /opt/../tmp/x、//tmp/x 这类
#    规范化后同形的写法直接报错）；返回的 site 与插入 sys.path 的值
#    都是规范化后的形式，/opt/locus-site/ 与 /opt/locus-site 是同一个
#    site；worker 重启后需重新调用；已解压过相同 sha256 的跳过
#    （.locus-installed/<sha256> 标记）。只影响测试，不影响打包结果。
```

validate 还会强制 **`wheel-too-large`**（D14）：插件 wheel 超过 16 MiB
（16777216 字节，runtime Python 镜像单文件上限）时报错——超过的文件
在 Locus 内 Python 看不见，无法在 Locus 内打包。

## 命令行

```sh
python -m locus_capability_sdk validate  <project_dir>
python -m locus_capability_sdk build     <project_dir> <out_dir>
python -m locus_capability_sdk build-wheel <src_dir> <dist> <version> <out_dir> [--summary S]
python -m locus_capability_sdk inspect   <path.pkg.locus>
python -m locus_capability_sdk wheel-info <whl>
python -m locus_capability_sdk verify-wheel <whl> <metadata.json>
python -m locus_capability_sdk plugin-from-wheel <project_dir> <whl>
```

每个子命令在 stdout 打一个 JSON 文档；退出码 0 = 成功（validate 无
诊断 / build 出文件 / inspect ok / verify-wheel 核对通过），1 = 干净
失败（诊断在 JSON 里，verify-wheel 的 ok:false 也走这一档），2 = 用法
或致命错误。

## 在普通 CPython 下使用（不用 Locus）

```sh
# 仓库内直接用源码：
PYTHONPATH=packages python -m locus_capability_sdk validate capabilities/charts

# 或安装 wheel（vendor/wheels/ 里有构建好的）：
python -m pip install vendor/wheels/locus_capability_sdk-<版本>-py3-none-any.whl
```

要求 CPython >= 3.12，无第三方依赖。能力项目的目录约定（capability.json、
skills/、plugins/、locus.json、src/、tests/）见仓库根 AGENTS.md 与
`docs/C4-CAPABILITY-AUTHORING.md` §2.2。

## 能力项目构建流程（C4 §4 流程的 4/5 步）

```sh
python -m locus_capability_sdk build-wheel  src <dist> <version> artifacts-out/
python -m locus_capability_sdk validate     <project_dir>
python -m locus_capability_sdk build        <project_dir> /mnt/download
python -m locus_capability_sdk inspect      /mnt/download/<id>-<version>.locus
```
