"""Owns the active inference engine: loading, swapping, unloading, capabilities.

The engine (MLX or llama.cpp — see server/engines/) is chosen from the model's
format and held in memory for both chat and brain management. All routes share
the single `manager` instance defined at the bottom; check `manager.is_loaded`
before generating.
"""

import asyncio
import gc
import threading
from typing import Optional

from . import config
from .engines import select_engine_for
from .model_catalog import list_downloaded_model_ids


# All inference work (chat streaming, brain routing, background brain updates,
# and model loading/unloading) must be serialized: generations run both on the
# event loop and in background threads, and concurrent backend generation can
# crash or corrupt output. Hold this lock around every stream and every
# load/unload.
generation_lock = threading.Lock()


async def acquire_generation_lock():
    """Acquire generation_lock from async code without blocking the event loop
    (a plain blocking acquire would freeze every other request while a
    background brain update generates)."""
    while not generation_lock.acquire(blocking=False):
        await asyncio.sleep(0.05)


def _save_last_model(model_ref: str):
    """Remember the model just loaded so load_initial reloads it next start."""
    try:
        config.LAST_MODEL_FILE.write_text(model_ref, encoding="utf-8")
    except Exception as e:
        print(f"Could not save last model: {e}")


def _load_last_model() -> Optional[str]:
    """The last model the user loaded, or None when nothing is remembered."""
    try:
        if config.LAST_MODEL_FILE.exists():
            return config.LAST_MODEL_FILE.read_text(encoding="utf-8").strip() or None
    except Exception as e:
        print(f"Could not read last model: {e}")
    return None


class ModelManager:
    """Holds the active engine and manages its lifecycle."""

    def __init__(self):
        self._engine = None
        self.active_mode = "active"

    @property
    def engine(self):
        return self._engine

    @property
    def is_loaded(self) -> bool:
        return self._engine is not None and self._engine.is_loaded

    @property
    def path(self) -> Optional[str]:
        return self._engine.path if self._engine else None

    def set_mode(self, mode: str):
        """Validate mode. Single-engine setup, so this is a pass-through."""
        self.active_mode = "active"

    def switch_to(self, model_ref: str):
        """Load a single model, picking its engine from the model's format.

        The current model is freed first so the new one has room to load. If
        loading fails, the previous model is restored so the app stays usable.
        """
        prev_engine = self._engine
        prev_path = self.path

        new_engine = select_engine_for(model_ref)
        try:
            if prev_engine is not None:
                prev_engine.unload()
            gc.collect()
            new_engine.load(model_ref)
            self._engine = new_engine
            _save_last_model(model_ref)
        except Exception as e:
            print(f"Error loading model {model_ref}: {e}")
            # Restore the previous model when there was one.
            self._engine = None
            if prev_engine is not None and prev_path:
                try:
                    restored = select_engine_for(prev_path)
                    restored.load(prev_path)
                    self._engine = restored
                except Exception as restore_err:
                    print(f"Could not restore previous model: {restore_err}")
            raise e

    def load_initial(self):
        """Try to load the preferred/default model initially."""
        available = list_downloaded_model_ids()
        last = _load_last_model()
        if last and last in available:
            preferred = last
        else:
            preferred = config.DEFAULT_MODEL if config.DEFAULT_MODEL in available else (
                available[-1] if available else config.DEFAULT_MODEL)

        for candidate in [preferred] + [m for m in reversed(available) if m != preferred]:
            try:
                self.switch_to(candidate)
                return
            except Exception as e:
                print(f"Failed loading initial candidate {candidate}: {e}")

        try:
            self.switch_to(config.FALLBACK_MODEL)
            return
        except Exception as e:
            print(f"Failed fallback load of {config.FALLBACK_MODEL}: {e}")

        print("WARNING: no model could be loaded — starting without one. "
              "Pick a compatible model from the UI to begin chatting.")

    def unload(self):
        """Drop the loaded model and reclaim memory."""
        print("Unloading model")
        if self._engine is not None:
            self._engine.unload()
        self._engine = None
        gc.collect()

    def supports_thinking(self) -> bool:
        return self._engine.supports_thinking() if self._engine else False

    def supports_vision(self) -> bool:
        return self._engine.supports_vision() if self._engine else False

    def supports_audio(self) -> bool:
        return self._engine.supports_audio() if self._engine else False


# The single shared instance used by every route.
manager = ModelManager()
