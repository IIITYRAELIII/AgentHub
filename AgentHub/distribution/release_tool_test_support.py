"""Test adapter for the separately versioned package builder and public recipient."""
import os
from pathlib import Path
import sys

_recipient = Path(__file__).resolve().parent
_tool = Path(os.environ["AGENT_HUB_RELEASE_TOOLS_ROOT"])
sys.path.insert(0, str(_tool / "python"))
sys.path.insert(0, str(_tool / "tests"))
from build_package import build_package as _build_package


def build_package(prepared, license_file, notices_file, source_commit, output):
    return _build_package(prepared, license_file, notices_file, source_commit, output, _recipient)
