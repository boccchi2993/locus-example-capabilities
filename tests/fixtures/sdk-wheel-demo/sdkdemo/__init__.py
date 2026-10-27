"""XC4 fixture package: a minimal two-module pure-Python package.

Used by tests/sdk-crosscheck.test.mjs (XC4) to build a wheel twice,
pip-install it and call into it.
"""

NAME = "sdkdemo"


def greeting(name: str) -> str:
    from .analyze import shout
    return shout("hello, " + name)
