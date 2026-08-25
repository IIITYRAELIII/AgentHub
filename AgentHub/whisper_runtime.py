from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Callable


_DLL_DIRECTORY_HANDLES: list[object] = []


def nvidia_runtime_directories(
    prefix: Path | str | None = None,
    *,
    platform: str | None = None,
    is_directory: Callable[[Path], bool] = Path.is_dir,
) -> tuple[Path, ...]:
    if (platform or sys.platform) != "win32":
        return ()
    root = Path(prefix or sys.prefix) / "Lib" / "site-packages" / "nvidia"
    candidates = (root / "cublas" / "bin", root / "cudnn" / "bin")
    return tuple(directory for directory in candidates if is_directory(directory))


def configure_nvidia_runtime(prefix: Path | str | None = None) -> tuple[Path, ...]:
    directories = nvidia_runtime_directories(prefix)
    if not directories:
        return directories
    existing = os.environ.get("PATH", "")
    os.environ["PATH"] = os.pathsep.join([
        *(str(directory) for directory in directories),
        *([existing] if existing else []),
    ])
    if hasattr(os, "add_dll_directory"):
        for directory in directories:
            _DLL_DIRECTORY_HANDLES.append(os.add_dll_directory(str(directory)))
    return directories
