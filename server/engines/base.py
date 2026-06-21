"""The inference-engine interface.

Lemma supports more than one local inference backend (MLX on Apple Silicon,
llama.cpp everywhere). Everything backend-specific — loading weights, applying
the chat template, counting tokens, streaming a reply — lives behind this
`Engine` interface so the rest of the server (model_manager, routes/chat,
context_window) never imports mlx or llama_cpp directly.

A "prompt" returned by `format_chat` is deliberately opaque: the MLX engine
produces a formatted string, the llama.cpp engine a messages list. It is only
ever passed back to the same engine's `stream` / `count_prompt_tokens` /
`prompt_open_thinking`, so callers never inspect it.
"""

from __future__ import annotations

from typing import Iterator, List, Optional


class Engine:
    """Abstract base. Concrete engines override every method below."""

    # Short identifier ("mlx" | "llama"), used in catalog/compat reporting.
    name: str = "base"

    # ---- lifecycle ----------------------------------------------------------

    def load(self, model_ref: str) -> None:
        """Load a model into memory. `model_ref` is a HF repo dir (MLX) or a
        path to a .gguf file (llama.cpp). Raises on failure."""
        raise NotImplementedError

    def unload(self) -> None:
        """Drop the loaded model and reclaim memory."""
        raise NotImplementedError

    @property
    def is_loaded(self) -> bool:
        raise NotImplementedError

    @property
    def path(self) -> Optional[str]:
        """The model_ref currently loaded, or None."""
        raise NotImplementedError

    # ---- capabilities -------------------------------------------------------

    def supports_thinking(self) -> bool:
        """Whether the model emits a reasoning phase (<think> / channel tags)."""
        return False

    def supports_vision(self) -> bool:
        """Whether the model can take image input."""
        return False

    def supports_audio(self) -> bool:
        """Whether the model can take audio input."""
        return False

    # ---- prompting / tokens -------------------------------------------------

    def format_chat(self, messages: List[dict], system_prompt: str,
                    image_paths: List[str] = None, audio_paths: List[str] = None,
                    enable_thinking: Optional[bool] = None):
        """Render the conversation into this engine's opaque prompt object.

        `messages` is [{"role", "text"}], current turn last. Media applies only
        to the last user turn (the chat template / engine places it there)."""
        raise NotImplementedError

    def count_tokens(self, text: str) -> int:
        """Token count of a plain string (used for per-message trimming costs)."""
        raise NotImplementedError

    def count_prompt_tokens(self, prompt) -> int:
        """Token count of a formatted prompt object from `format_chat`."""
        raise NotImplementedError

    def prompt_open_thinking(self, prompt):
        """Whether the formatted prompt ended inside a thinking block, so the
        stream should be prefixed with the opening tag. Returns (is_open, tag).
        Only MLX (string templates) can leave one open; others return (False, "")."""
        return (False, "")

    # ---- generation ---------------------------------------------------------

    def stream(self, prompt, image_paths: List[str] = None,
               audio_paths: List[str] = None, *, max_tokens: int,
               temperature: float = 1.0, max_kv_size: Optional[int] = None
               ) -> Iterator[str]:
        """Stream the reply for a formatted prompt, yielding text chunks."""
        raise NotImplementedError

    def complete_stream(self, prompt_text: str, *, max_tokens: int,
                        max_kv_size: Optional[int] = None,
                        temperature: float = 1.0) -> Iterator[str]:
        """Stream a single-turn completion of a plain user prompt — the internal
        brain calls (routing, post-processing, title). Default wraps `stream`."""
        prompt = self.format_chat([{"role": "user", "text": prompt_text}], "", enable_thinking=False)
        yield from self.stream(prompt, max_tokens=max_tokens, max_kv_size=max_kv_size, temperature=temperature)

    def active_stream(self):
        """Return the device stream used by the engine, or None."""
        return None

    def clear_cache(self) -> None:
        """Free a generation's transient GPU/CPU buffers. No-op where unneeded."""
