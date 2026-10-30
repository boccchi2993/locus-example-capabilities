# TODO

开放的维护项（完成即在 PR 里勾掉）：

- [ ] product 锁定版本升级时，重新跑 npm test 和 npm run check
- [ ] 第三方 wheel 的平台标签规则（wheelPlatformCompatible）与 runtime
      预装包清单目前写死在本仓库 scripts/wheel-util.mjs（检查 3 平台标签、
      检查 4 预装遮盖两处使用）：待 runtime PR 合并（导出 Pyodide 版本、
      ABI 与 wheelPlatformCompatible、预装包清单）、product 锁定版本升级后，
      改为引用 runtime 导出并删除本地写死清单
  - 进展 2026-10-30：runtime 已在 aca6c2f 导出 PYODIDE_VERSION / PYTHON_ABI /
    PYTHON_RUNTIME_PACKAGES / wheelPlatformCompatible / normalizeDistName，
    product 已锁定该 runtime 版本，本条现在可以执行。

## 2026-10-30 新增条目

- [ ] **CA-1.1.0（example-capabilities）：capability-authoring 1.1.0**
  - 现状：1.1.0 待做，范围为——SKILL.md 删除「没有网络」的错误说法（按 DECISIONS.md
    D14：GET 无需审批，Python 层无网络，下载用 bash curl -o）；新增第三方 wheel 流程
    （下载、按 PyPI JSON / pyodide-lock.json 核对 sha256、依赖闭包与顺序、测试方式、
    已存在官方 py-<名> 组件时逐字节复用其描述符）；导入报告读取简化为「最新一份即最终
    结果」（依据 product PR #49）；SDK 增加对应辅助函数。
  - 下一步：实现上述内容并发布 capability-authoring 1.1.0。
  - 依赖：RT-16MIB 与 SPIKE-SYNC。
  - 验收：上述内容全部落地。
- [ ] **CAP-GROUP2（example-capabilities）：第二批官方能力**
  - 现状：excel / pdf / word / pptx / image 的 vendor wheel 已就绪（PR #5），提示词未写。
  - 下一步：为五个能力编写提示词并成包。
  - 验收：待确认。
- [ ] **deepseek-web（example-capabilities）：发布状态**
  - 现状：Release 说明已写明所有者尚未在真实服务上实测；仍为 pre-release，附件为
    deflate 格式。
  - 下一步：待所有者实测后决定是否按 store 格式重新发布为正式版。
  - 验收：待确认。
- [ ] **VW2（example-capabilities）：VW2 反例测试修正**
  - 现状：VW2 反例测试会因「临时副本缺少 packages/ 导致 SDK 重建失败」而额外通过
    （不只因为预期的原因）。
  - 下一步：调整测试，让它只因预期原因失败。
  - 验收：反例测试仅在预期原因下失败，不再因「临时副本缺少 packages/ 导致 SDK 重建
    失败」而通过。
