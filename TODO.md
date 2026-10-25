# TODO

开放的维护项（完成即在 PR 里勾掉）：

- [ ] product 锁定版本升级时，重新跑 npm test 和 npm run check
- [ ] 第三方 wheel 的平台标签规则（wheelPlatformCompatible）与 runtime
      预装包清单目前写死在本仓库 scripts/wheel-util.mjs（检查 3 平台标签、
      检查 4 预装遮盖两处使用）：待 runtime PR 合并（导出 Pyodide 版本、
      ABI 与 wheelPlatformCompatible、预装包清单）、product 锁定版本升级后，
      改为引用 runtime 导出并删除本地写死清单
