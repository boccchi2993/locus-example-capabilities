# locus-example-capabilities

Locus 的官方示例能力包（.locus）仓库（见 locus-product DECISIONS D11）——每个能力一个
目录，构建为确定性的 `.locus` 包，可直接在 Locus 中导入安装。

## 能力列表

- **deepseek-web** — 用 DeepSeek Search / Fetch API 搜索网页、抓取页面正文（需要 DeepSeek API key）。

## 构建与检查

需要 Node 24。

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

## 第三方 wheel（D13）

能力包可以携带第三方 Python wheel（locus-product `docs/DECISIONS.md` D13）。
wheel 不放在能力目录里，统一收在 [vendor/](vendor/README.md)：

- `vendor/wheels/` — wheel 文件本体（提交进 git，同一个 wheel 只存一份）。
- `vendor/wheels.json` — wheel 清单，每项：
  `{ id, dist, version, filename, sha256, source, license, imports, displayName, description }`
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
能力自己写了 `plugins/<id>/` 的照原样使用（自研 plugin 优先）。

**规则**（`npm run check` 全部强制执行，`scripts/wheel-checks.mjs` /
`scripts/vendor.mjs` / `scripts/wheel-util.mjs`）：

1. vendor 一致性：清单与文件一一对应、sha256 一致、pyodide-lock 与
   README 记录一致；
2. 来源核验：纯 Python wheel 的 sha256 必须等于 PyPI JSON API 公布值
   （在线查询，网络不可用时报错退出）；Pyodide 原生 wheel 必须等于
   Pyodide 0.26.4 官方 pyodide-lock.json 里的记录，且文件名一致；
3. 平台标签：必须是纯 Python（`*-none-any`）或 cp312 +
   `pyodide_2024_0_wasm32`；
4. 预装遮盖：不得携带 runtime 已预装的包（micropip、numpy、packaging、
   pandas、python-dateutil、pytz、six）；
5. 依赖顺序：每个 wheel 的 `Requires-Dist`（无 extra 条件、环境标记对
   Python 3.12 / `sys_platform=emscripten` 成立）要么是 runtime 预装包，
   要么由 `plugins` 列表里位置更靠前的 `py-` plugin 提供；缺依赖或顺序
   错误都报错。

**怎样添加新 wheel**：把 wheel 文件放进 `vendor/wheels/`，在
`vendor/wheels.json` 里按上述字段登记（id 用 `py-` + 规范化包名），
在 `vendor/README.md` 补充来源说明；如果是 Pyodide 原生 wheel，
`source` 填 `"pyodide-lock"` 并确认 sha256 与 lock 文件一致。改完跑
`npm run verify-vendor` 与 `npm test`。

平台标签规则与预装包清单目前写死在本仓库（`scripts/wheel-util.mjs`），
待 runtime 导出（Pyodide 版本 / ABI / 预装包清单）后改为引用，见
[TODO.md](TODO.md)。
