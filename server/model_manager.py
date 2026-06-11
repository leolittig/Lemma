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

SMALL_MODEL = "mlx-community/gemma-4-e4b-it-4bit"
LARGE_MODEL = "mlx-community/gemma-4-12B-it-8bit"


class ModelManager:
    """Holds the active models and manages their lifecycle."""

    SMALL_MODEL = SMALL_MODEL
    LARGE_MODEL = LARGE_MODEL

    def __init__(self):
        self._models = {}  # keys are model paths, values are (model, processor) tuples
        self.active_mode = "everything-12b"

    @property
    def is_loaded(self) -> bool:
        return len(self._models) > 0

    def get_chat_model_path(self) -> str:
        """Helper mapping the active mode to the active chat model path."""
        if self.active_mode == "e4b-chat-12b-brain":
            return self.SMALL_MODEL
        elif self.active_mode in ("everything-12b", "12b-chat-e4b-brain"):
            return self.LARGE_MODEL
        elif self.active_mode == "custom":
            if self._models:
                return list(self._models.keys())[0]
        return None

    @property
    def path(self) -> str:
        return self.get_chat_model_path()

    @property
    def model(self):
        p = self.path
        if p and p in self._models:
            return self._models[p][0]
        return None

    @property
    def processor(self):
        p = self.path
        if p and p in self._models:
            return self._models[p][1]
        return None

    def get_model(self, path: str):
        if path in self._models:
            return self._models[path][0]
        return None

    def get_processor(self, path: str):
        if path in self._models:
            return self._models[path][1]
        return None

    def _load_model(self, path: str):
        """Loads a model if not already loaded, checking language_model wrapper."""
        if path in self._models:
            return
        print(f"Loading model: {path}")
        model, processor = load(path)
        if model is not None and not hasattr(model, "language_model"):
            raise ValueError(
                f"The model '{path}' lacks a language model wrapper (e.g., it is a "
                f"speculative draft model or has an unsupported architecture). "
                f"Please select a full VLM or supported model.")
        self._models[path] = (model, processor)

    def set_mode(self, mode: str):
        """Validate mode and load/unload required models."""
        valid_modes = {"everything-12b", "12b-chat-e4b-brain", "e4b-chat-12b-brain"}
        if mode not in valid_modes:
            raise ValueError(f"Invalid mode: {mode}")

        if mode == "everything-12b":
            required = {self.LARGE_MODEL}
        else:
            required = {self.LARGE_MODEL, self.SMALL_MODEL}

        for path in required:
            if path not in self._models:
                self._load_model(path)

        unloaded_any = False
        for path in list(self._models.keys()):
            if path not in required:
                print(f"Unloading model: {path}")
                del self._models[path]
                unloaded_any = True

        if unloaded_any:
            gc.collect()
            mx.clear_cache()

        self.active_mode = mode

    def switch_to(self, path: str):
        """Manually load a custom model path."""
        self._models.clear()
        gc.collect()
        mx.clear_cache()
        self._load_model(path)
        self.active_mode = "custom"

    def load_initial(self):
        """Try to load `everything-12b` mode initially.

        If loading fails, fallback to loading any downloaded model alphabetical-based check.
        """
        try:
            self.set_mode("everything-12b")
            return
        except Exception as e:
            print(f"Failed to load initial everything-12b mode: {e}")

        available = list_downloaded_models()
        preferred = available[-1] if available else config.FALLBACK_MODEL

        for candidate in [preferred] + [m for m in reversed(available) if m != preferred]:
            try:
                self._load_model(candidate)
                self.active_mode = "custom"
                return
            except Exception as ex:
                print(f"Failed fallback load of {candidate}: {ex}")

        print("WARNING: no model could be loaded — starting without one. "
              "Pick a compatible model from the UI to begin chatting.")

    def unload(self):
        """Drop all loaded models and reclaim memory."""
        print("Unloading all loaded models")
        self._models.clear()
        gc.collect()
        mx.clear_cache()

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
