"""Owns the loaded MLX model: loading, swapping, unloading, capabilities.

The active selected model is held in memory and used for both chat and brain management (with separate contexts).

All routes share the single `manager` instance defined at the bottom; check
`manager.is_loaded` before generating.
"""

import asyncio
import gc
import threading

import mlx.core as mx
from mlx_vlm import load

from . import config
from .model_catalog import list_downloaded_models


# All MLX work (chat streaming, brain routing, background brain updates, and
# model loading/unloading) must be serialized: generations run both on the
# event loop and in background threads, and concurrent Metal generation can
# crash or corrupt output. Hold this lock around every stream_generate call
# and every load/unload.
generation_lock = threading.Lock()


async def acquire_generation_lock():
    """Acquire generation_lock from async code without blocking the event loop
    (a plain blocking acquire would freeze every other request while a
    background brain update generates)."""
    while not generation_lock.acquire(blocking=False):
        await asyncio.sleep(0.05)


class ModelManager:
    """Holds the active model and manages its lifecycle."""

    def __init__(self):
        self._models = {}  # keys are model paths, values are (model, processor) tuples
        self.active_mode = "active"

    @property
    def is_loaded(self) -> bool:
        return len(self._models) > 0

    @property
    def path(self) -> str:
        if self._models:
            return list(self._models.keys())[0]
        return None

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
        return self.model

    def get_processor(self, path: str):
        if path in self._models:
            return self._models[path][1]
        return self.processor

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
        """Validate mode. Since we run single model setups, set_mode is a simple pass-through."""
        self.active_mode = "active"

    def switch_to(self, path: str):
        """Manually load a single model.

        The current model is freed first so the new one has room to load.
        If loading fails, the previous configuration is restored so the app
        stays usable.
        """
        prev_paths = list(self._models.keys())
        self._models.clear()
        gc.collect()
        mx.clear_cache()
        try:
            self._load_model(path)
        except Exception as e:
            print(f"Error loading model {path}: {e}")
            if prev_paths:
                try:
                    self._load_model(prev_paths[0])
                except Exception as restore_err:
                    print(f"Could not restore previous model: {restore_err}")
            raise e

    def load_initial(self):
        """Try to load the preferred/default model initially."""
        available = list_downloaded_models()
        preferred = config.DEFAULT_MODEL if config.DEFAULT_MODEL in available else (available[-1] if available else config.DEFAULT_MODEL)

        for candidate in [preferred] + [m for m in reversed(available) if m != preferred]:
            try:
                self.switch_to(candidate)
                return
            except Exception as e:
                print(f"Failed loading initial candidate {candidate}: {e}")

        # Fallback to config fallback model
        try:
            self.switch_to(config.FALLBACK_MODEL)
            return
        except Exception as e:
            print(f"Failed fallback load of {config.FALLBACK_MODEL}: {e}")

        print("WARNING: no model could be loaded — starting without one. "
              "Pick a compatible model from the UI to begin chatting.")

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
