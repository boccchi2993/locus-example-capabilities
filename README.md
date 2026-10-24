# locus-example-capabilities

Locus 的官方示例能力包（.locus）仓库（见 locus-product DECISIONS D11）——每个能力一个
目录，构建为确定性的 `.locus` 包，可直接在 Locus 中导入安装。

## 能力列表

- **deepseek-web** — 用 DeepSeek Search / Fetch API 搜索网页、抓取页面正文（需要 DeepSeek API key）。
- **charts** — 用 Python 标准库把表格和数字画成干净的 SVG 图表（折线、柱状、饼图、散点）。

## 构建与检查

需要 Node 24。

```sh
npm ci                # 按 lockfile 安装依赖（打包代码来自锁定的 locus-product 提交）
npm test              # 测试套件
npm run build         # 构建 dist/<id>-<version>.locus（capabilities/ 下全部）
npm run check         # inspect + 确定性 + skill 规范三项检查
```

`npm run build -- <id> ...` 可以只构建部分能力。没有能力时 build 与 check 打印
"no capabilities" 并正常退出。

能力目录约定（含不进包的 `locus.json` 元文件）见 [AGENTS.md](AGENTS.md)；
发布（tag `<id>@<version>` 与 Release）只在所有者明确要求时进行。
