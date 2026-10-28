> AGENTS.md 与 CLAUDE.md 是同一份规则的两个副本，内容必须完全一致。
> 修改其中任何一份时，必须在同一个提交里对另一份做相同的修改。CI 会比对两份文件，不一致即失败。

## 仓库职责

本仓库是 Locus 的官方示例能力包（.locus）仓库（见 locus-product/docs/DECISIONS.md D11）。
每个能力一个目录 `capabilities/<id>/`，构建产物是确定性的 `dist/<id>-<version>.locus`；
按能力打 tag `<id>@<version>`，每个 tag 对应一个 Release，附件为该构建产物。
本仓库通过锁定 locus-product 的提交来引用打包代码（`src/capability-package.js`、
`src/locus-archive.js`、`src/capability-packages.js` 的 inspect），不复制打包算法。

四个仓库：

- [locus-product](https://github.com/boccchi2993/locus-product) — 面向用户的应用；能力打包代码在本仓库锁定引用
- [locus-runtime](https://github.com/boccchi2993/locus-runtime) — 浏览器本地 Unix 式执行基座
- [locus-harness](https://github.com/boccchi2993/locus-harness) — 会话核心与扩展（能力/插件/技能）模型
- 本仓库 [locus-example-capabilities](https://github.com/boccchi2993/locus-example-capabilities) — 官方示例能力包

涉及架构的改动之前，必须先阅读 [locus-product/docs/DECISIONS.md](https://github.com/boccchi2993/locus-product/blob/main/docs/DECISIONS.md)。
与其中某条决定冲突的改动，必须先由所有者批准，不能自行决定。

## 工作规则

- 在分支上工作，通过 PR 提交；不直接推送 main，不自行合并。
- PR 合并前 CI 必须全部通过。
- 不放宽断言、不跳过测试、不靠重跑让红灯变绿。
- 保留第一次失败的记录，证据必须与实际一致。
- 开放的维护项见本仓库的 [TODO.md](TODO.md)。

## 新能力的目录约定

每个能力一个目录 `capabilities/<id>/`，`<id>` 与 capability.json 里的 `capability.id` 的
组件 id 规则一致（小写字母数字与 `._-`）。目录下两部分：

- 包内容：`capability.json`、`skills/`、`plugins/`、`mcp/` 等（进包的内容以打包核心的
  closed set 为准，额外文件不会进入 .locus）。
- 一个不进包的元文件 `locus.json`，构建脚本用它生成 LOCUS.md 正文与 manifest：

  ```json
  {
    "title": "能力显示名",
    "author": "boccchi2993",
    "purpose": "这个能力是做什么的（进 manifest，≤2000 字符）",
    "changelog": ["1.0.0（2026-10-23）：首个版本"]
  }
  ```

新能力在 PR 里加目录并更新 README.md 的能力列表；构建产物 dist/ 不提交。

## 发布

只有仓库所有者明确要求发布时才打 tag、发 Release，agent 不得自行发布。

- tag 格式 `<id>@<version>`，每个 tag 对应一个 Release。
- Release 附件为 `npm run build` 的产物 `dist/<id>-<version>.locus`。

## 常用命令

以 [package.json](package.json) 的 scripts 为准：

- `npm ci` — 按 lockfile 干净安装依赖（依赖以 github 提交锁定 locus-product）
- `npm run build` — 构建 `dist/<id>-<version>.locus`；不带参数构建 capabilities/ 全部，
  也可 `npm run build -- <id> ...` 只构建部分
- `npm run check` — 对每个构建产物做三项检查：locus-product 的 inspect（ok / kind=new /
  mismatched 空）、确定性（再构建一次字节相同）、skill 规范（无字面 sk- 密钥；curl 里的
  `$VAR` 必须是 capability.json 声明过的凭据，且目标 URL 在该凭据 origin+pathPrefix 内；
  capability.version 必须是三段数字版本号）
- `npm test` — 测试套件（Node 24）

本地完整验证顺序：`npm ci && npm test && npm run build && npm run check`。
没有真实能力时 build 与 check 打印 "no capabilities" 并正常退出。
