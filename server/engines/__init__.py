"""Engine selection.

Which engine runs a model is decided by the model's *format*:
    - a path ending in .gguf            -> llama.cpp  (LlamaEngine)
    - anything else (an mlx HF repo)    -> MLX         (MlxEngine)

The *platform* only decides the default offered to a fresh setup: MLX on
Apple Silicon macOS, llama.cpp everywhere else. Engine modules are imported
lazily so a machine missing one backend (e.g. no mlx on Windows) never imports
it — selecting an unsupported model raises a clear error instead.
"""

from __future__ import annotations

import importlib
import importlib.util
import platform

from .base import Engine

# format -> (engine module, class name, probe package, pip package)
_ENGINES = {
    "mlx": (".mlx_engine", "MlxEngine", "mlx_vlm", "mlx-vlm"),
    "llama": (".llama_engine", "LlamaEngine", "llama_cpp", "llama-cpp-python"),
}


def engine_for_format(fmt: str):
    """The engine class for a format ("mlx" | "llama"), imported on demand.
    Raises RuntimeError with an install hint when its package isn't available."""
    module_name, class_name, _, package = _ENGINES[fmt]
    try:
        module = importlib.import_module(module_name, __name__)
    except ImportError as e:
        raise RuntimeError(
            f"This model needs the {fmt} engine, but '{package}' is not installed "
            f"on this system ({e}). Install it, or pick a compatible model.") from e
    return getattr(module, class_name)


def format_of(model_ref: str) -> str:
    """The engine format implied by a model reference."""
    return "llama" if str(model_ref).lower().endswith(".gguf") else "mlx"


def select_engine_for(model_ref: str) -> Engine:
    """Instantiate the right engine for a model reference (not yet loaded)."""
    return engine_for_format(format_of(model_ref))()


def default_format() -> str:
    """The engine format to default to on this platform."""
    return "mlx" if platform.system() == "Darwin" else "llama"


def is_format_available(fmt: str) -> bool:
    """Whether the engine package for a format is installed here. Used to flag
    model compatibility in the catalog cheaply, without importing the backend."""
    probe = _ENGINES[fmt][2]
    try:
        return importlib.util.find_spec(probe) is not None
    except (ImportError, ValueError):
        return False
