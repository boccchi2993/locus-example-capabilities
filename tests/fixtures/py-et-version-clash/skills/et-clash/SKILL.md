# et_xmlfile clash skill

TEST ONLY fixture for the vendor-wheel version-conflict test.

本技能不含任何网络请求；wheel 是能力自带的占位 wheel（由 locus_capability_sdk build-wheel 从一个只含 `__version__ = "2.0.1"` 的最小 et_xmlfile 包构建，不实现任何功能），用于触发 harness 的注册冲突路径。
