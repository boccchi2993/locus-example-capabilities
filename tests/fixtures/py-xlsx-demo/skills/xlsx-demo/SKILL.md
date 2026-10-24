# XLSX demo skill

TEST ONLY fixture for the vendor-wheel test suite.

Python 端（Pyodide worker）可以用 vendor 提供的 openpyxl：

```python
from openpyxl import Workbook

wb = Workbook()
wb.active["A1"] = "hello"
```

本技能不含任何网络请求；wheel 由构建从 vendor/ 生成。
