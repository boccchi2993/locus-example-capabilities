# locus_capability_sdk

Locus 能力创作 SDK——纯 Python 3.12 标准库实现，用于校验、构建与查看
Capability 项目与 `.locus` 包。与 locus-product 的 JS 打包管线
（本仓库锁定的提交）**逐字节一致**，由仓库 CI 的交叉校验
（`tests/sdk-crosscheck.test.mjs` XC1–XC6）保证：

- XC1：SDK 与 `scripts/build.mjs` 构建的 `.locus` 逐字节相同；
- XC2：validate 的结论与诊断码集合和 JS（build + check）一致；
- XC3：inspect 的摘要与 product 的导入检查一致；
- XC4/XC6：wheel 可安装、RECORD 正确、从源码重建逐字节相同；
- XC5：只导入标准库。

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
```

## 命令行

```sh
python -m locus_capability_sdk validate  <project_dir>
python -m locus_capability_sdk build     <project_dir> <out_dir>
python -m locus_capability_sdk build-wheel <src_dir> <dist> <version> <out_dir> [--summary S]
python -m locus_capability_sdk inspect   <path.pkg.locus>
```

每个子命令在 stdout 打一个 JSON 文档；退出码 0 = 成功（validate 无
诊断 / build 出文件 / inspect ok），1 = 干净失败（诊断在 JSON 里），
2 = 用法或致命错误。

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
