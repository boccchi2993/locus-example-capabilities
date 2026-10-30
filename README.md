# locus-example-capabilities

Locus 的官方示例能力包（.locus）仓库（见 locus-product DECISIONS D11）——每个能力一个
目录，构建为确定性的 `.locus` 包，可直接在 Locus 中导入安装。

## 能力列表

- **deepseek-web** — 用 DeepSeek Search / Fetch API 搜索网页、抓取页面正文（需要 DeepSeek API key）。
- **charts** — 用 Python 标准库把表格和数字画成干净的 SVG 图表（折线、柱状、饼图、散点）。
- **capability-authoring** — 让 Locus 从一句话需求设计、测试并打包新能力（.locus），内置 locus_capability_sdk 插件。

## 构建与检查

需要 Node 24；`npm run check` 与 `npm run verify-vendor` 还需要
CPython >= 3.12 在 PATH 上（SDK wheel 的本地重建核验；CI 两者都有）。

```sh
npm ci                # 按 lockfile 安装依赖（打包代码来自锁定的 locus-product 提交）
npm test              # 测试套件
npm run build         # 构建 dist/<id>-<version>.locus（capabilities/ 下全部）
npm run check         # inspect + 确定性 + skill 规范 + vendor 四组检查
npm run verify-vendor # 只跑 vendor 的一致性与来源核验（在线）
```

`npm run build -- <id> ...` 可以只构建部分能力。没有能力时 build 与 check 打印
"no capabilities" 并正常退出（vendor 检查仍然执行）。

能力目录约定（含不进包的 `locus.json` 元文件）见 [AGENTS.md](AGENTS.md)；
发布（tag `<id>@<version>` 与 Release）只在所有者明确要求时进行。

## SDK（locus_capability_sdk）

[packages/locus_capability_sdk/](packages/locus_capability_sdk/README.md) 是纯
Python 3.12 标准库的能力创作 SDK：校验能力项目（`validate`）、打确定性
wheel（`build_wheel`）、构建 `.locus`（`build`）、导入式摘要（`inspect`），
以及 D14 第三方 wheel 工具（完全离线）：`wheel_info`（wheel 要点）、
`verify_wheel`（与 PyPI JSON / pyodide-lock 元数据离线比对 sha256）、
`plugin_from_wheel`（从 wheel 生成规范描述符 plugins/py-<名>/plugin.json，
同一 wheel 逐字节相同）、`test_site`（解压到非挂载点目录做打包前的
import 测试）。命令行提供
`python -m locus_capability_sdk validate|build|build-wheel|inspect|wheel-info|verify-wheel|plugin-from-wheel`
——人和模型在普通 CPython 下都能用，不依赖 Locus 或 Node。

SDK 与 JS 打包管线（`scripts/*.mjs` + 锁定的 locus-product）**逐字节一致**，
由 CI 的交叉校验强制（`tests/sdk-crosscheck.test.mjs` XC1–XC8）；SDK 自己的
wheel 提交在 [vendor/wheels/](vendor/README.md)（`source: "local"`），检查脚本
会从源码重建并要求逐字节相同。`.locus` 自 2026-10-28 起为 **store-only**
（zip 条目不压缩，product PR #45 的所有者决定）：包字节只取决于输入，
在 Node、浏览器与 CPython 上构建结果完全相同。

从 2026-10-28 起构建的包为 store 格式：与 2026-10-23 发布的
deepseek-web@1.0.0 Release 附件（deflate 版）**字节不同、内容与 manifest
digest 相同**（`tests/store-only.test.mjs` 持续验证），旧附件无需重新发布，
导入不受影响（product 读取端兼容两种格式）。

## 第三方 wheel（D13）

能力包可以携带第三方 Python wheel（locus-product `docs/DECISIONS.md` D13）。
wheel 不放在能力目录里，统一收在 [vendor/](vendor/README.md)：

- `vendor/wheels/` — wheel 文件本体（提交进 git，同一个 wheel 只存一份）。
- `vendor/wheels.json` — wheel 清单，每项：
  `{ id, dist, version, filename, sha256, source, license, imports, displayName, description }`；
  其中 `id`、`version`、`imports`、`displayName`、`description` 必须等于从
  wheel 字节推导的结果（id = `py-` + 规范化 METADATA Name；version =
  METADATA Version；displayName = METADATA Name 原样；description =
  METADATA Summary 去首尾空白，空则 `<Name> <Version>`；imports = RECORD
  推导的顶层名）——wheel 字节是唯一事实来源，清单字段是可读记录，
  一致性检查强制逐字段相等；
  `source` 为 `"local"` 的项（本仓库源码构建的 wheel）额外带
  `path`（源码目录），不参与外部来源核验，改为**从源码重建逐字节比对**。
- `vendor/pyodide-lock-0.26.4.json` — Pyodide 0.26.4 官方 lock，`source` 为
  `"pyodide-lock"` 的 wheel 的 sha256 依据（其 sha256 与下载时间记录在
  [vendor/README.md](vendor/README.md)）。

**plugin id 规则**：同一个 Python 发行包统一使用 plugin id
`py-<规范化包名>`（PEP 503：小写、连续 `-_.` 折叠为 `-`；如 `py-openpyxl`、
`py-et-xmlfile`），以便多个能力共享同一组件。

**能力里怎么用**：在 capability.json 的 `plugins` 里按依赖顺序列出
`py-` id，能力目录下不放 `plugins/<id>/`。构建时 `scripts/build.mjs`
从 vendor 生成 plugin.json（runtime python、authority none、恰好一个
python-wheel artifact）并把 wheel 复制进内存工作区——不写回源码目录。
能力自己写了 `plugins/<id>/` 的照原样使用（自研 plugin 优先）。模型
自做的能力引用 vendor 之外的第三方 wheel 时，用 SDK 的
`plugin_from_wheel` 从 wheel 生成同一形状的规范描述符（同一 wheel
逐字节相同，D14 第 5 条）。

**规则**（`npm run check` 全部强制执行，`scripts/wheel-checks.mjs` /
`scripts/vendor.mjs` / `scripts/wheel-util.mjs`）：

1. vendor 一致性：清单与文件一一对应、sha256 一致、pyodide-lock 与
   README 记录一致；清单的 id / version / displayName / description /
   imports 与从 wheel 字节推导的描述符逐字段相等（D14 第 5 条的
   单一事实来源——同一 wheel 在任何能力里生成逐字节相同的
   plugin.json）；
2. 来源核验：纯 Python wheel 的 sha256 必须等于 PyPI JSON API 公布值
   （在线查询，网络不可用时报错退出）；Pyodide 原生 wheel 必须等于
   Pyodide 0.26.4 官方 pyodide-lock.json 里的记录，且文件名一致；
   `source: "local"` 的 wheel（需要 CPython >= 3.12）从源码重建，
   必须与提交的文件逐字节相同；
3. 平台标签：必须是纯 Python（`*-none-any`）或 cp312 +
   `pyodide_2024_0_wasm32`；
4. 预装遮盖：不得携带 runtime 已预装的包（micropip、numpy、packaging、
   pandas、python-dateutil、pytz、six）；
5. 依赖顺序：每个 wheel 的 `Requires-Dist`（无 extra 条件、环境标记对
   Python 3.12 / `sys_platform=emscripten` 成立）要么是 runtime 预装包，
   要么由 `plugins` 列表里位置更靠前的 `py-` plugin 提供；缺依赖或顺序
   错误都报错；
6. 体积上限（D14）：插件 wheel 超过 16 MiB（16777216 字节，runtime
   Python 镜像单文件上限，runtime PR #12）报 `wheel-too-large`——超过
   的文件在 Locus 内 Python 看不见，无法在 Locus 内打包。

**怎样添加新 wheel**：把 wheel 文件放进 `vendor/wheels/`，在
`vendor/wheels.json` 里按上述字段登记（id 用 `py-` + 规范化包名），
`displayName` / `description` / `imports`（连同 `id` / `version`）填
从 wheel 字节推导的值——一致性检查会逐字段核对；在
`vendor/README.md` 补充来源说明；如果是 Pyodide 原生 wheel，
`source` 填 `"pyodide-lock"` 并确认 sha256 与 lock 文件一致。改完跑
`npm run verify-vendor` 与 `npm test`。

平台标签规则与预装包清单目前写死在本仓库（`scripts/wheel-util.mjs`），
待 runtime 导出（Pyodide 版本 / ABI / 预装包清单）后改为引用，见
[TODO.md](TODO.md)。
