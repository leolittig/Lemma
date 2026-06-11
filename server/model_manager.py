"""Owns the loaded MLX model: loading, swapping, unloading, capabilities.

Local inference is memory-bound, so only one model is ever held in memory.
All routes share the single `manager` instance defined at the bottom; check
`manager.is_loaded` before generating and read `manager.model` /
`manager.processor` / `manager.path` for the active model.
"""

import gc

import mlx.core as mx
from mlx_vlm import load

from . import config
from .model_catalog import list_downloaded_models


class ModelManager:
    """Holds the active model/processor pair and the path it was loaded from."""

    def __init__(self):
        self.model = None
        self.processor = None
        self.path = None

    @property
    def is_loaded(self) -> bool:
        return self.model is not None

    def _load(self, path: str):
        """Load `path` into self; raises when the checkpoint can't generate chat."""
        print(f"Loading model: {path}")
        model, processor = load(path)
        if model is not None and not hasattr(model, "language_model"):
            raise ValueError(
                f"The model '{path}' lacks a language model wrapper (e.g., it is a "
                f"speculative draft model or has an unsupported architecture). "
                f"Please select a full VLM or supported model.")
        self.model, self.processor, self.path = model, processor, path

    def _try_load(self, path: str) -> bool:
        """Like _load, but logs failures and leaves self unloaded instead of raising."""
        try:
            self._load(path)
            return True
        except Exception as e:
            print(f"Failed to load {path}: {e}")
            self.model = None
            self.processor = None
            return False

    def load_initial(self):
        """Load a model at server startup.

        Tries the preferred model (the last cached one alphabetically), then
        falls back through the other cached models so one incompatible
        checkpoint can't crash the whole process. The server still starts even
        if none load.
        """
        available = list_downloaded_models()
        preferred = available[-1] if available else config.FALLBACK_MODEL

        for candidate in [preferred] + [m for m in reversed(available) if m != preferred]:
            if self._try_load(candidate):
                return

        print("WARNING: no model could be loaded — starting without one. "
              "Pick a compatible model from the UI to begin chatting.")
        self.path = preferred

    def unload(self):
        """Drop the current model and reclaim its memory."""
        print(f"Unloading current model: {self.path}")
        self.model = None
        self.processor = None
        gc.collect()
        mx.clear_cache()

    def switch_to(self, path: str):
        """Swap to a different model.

        The current model is freed first so the new one has room to load
        (holding two at once can run out of memory). If the new model fails to
        load, the previous one is restored so the app stays usable; the
        original error is re-raised for the route to report to the client.
        """
        previous_path = self.path
        self.unload()
        try:
            self._load(path)
        except Exception as e:
            print(f"Error loading model {path}: {e}")
            if not self._try_load(previous_path):
                print(f"Could not restore previous model {previous_path}")
            raise e

    def supports_thinking(self) -> bool:
        """Whether the active model has a reasoning ("thinking") phase.

        Primary check: inspect the chat template for thinking markers.
        Fallback: well-known model-name patterns.
        """
        if self.processor is None:
            return False

        template = getattr(self.processor, "chat_template", None)
        if not template and hasattr(self.processor, "tokenizer"):
            template = getattr(self.processor.tokenizer, "chat_template", None)
        if isinstance(template, str) and any(
                marker in template for marker in ("enable_thinking", "<think>", "<|channel>thought")):
            return True

        name = (self.path or "").lower()
        return "gemma-4" in name or any(
            x in name for x in ("r1", "reasoning", "thinking", "optiq", "math"))


# The single shared instance used by every route.
manager = ModelManager()
