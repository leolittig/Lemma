"""MLX inference engine (Apple Silicon).

Wraps mlx-vlm: the same loading, chat-templating, token-counting and streaming
the server used before engines existed. Vision and audio are both supported
(mlx-vlm is a VLM runtime). Imported only when an MLX model is selected, so a
machine without mlx installed never touches this module.
"""

from __future__ import annotations

from typing import Iterator, List, Optional

import mlx.core as mx
from mlx_vlm import load
from mlx_vlm.generate import stream_generate
from mlx_vlm.prompt_utils import apply_chat_template

from .. import config, thinking
from ..mlx_compat import install_lenient_weight_loading
from .base import Engine


class MlxEngine(Engine):
    name = "mlx"

    def __init__(self):
        install_lenient_weight_loading()
        self._model = None
        self._processor = None
        self._path = None

    # ---- lifecycle ----------------------------------------------------------

    def load(self, model_ref: str) -> None:
        model, processor = load(model_ref)
        if model is not None and not hasattr(model, "language_model"):
            raise ValueError(
                f"The model '{model_ref}' lacks a language model wrapper (e.g., it is a "
                f"speculative draft model or has an unsupported architecture). "
                f"Please select a full VLM or supported model.")
        self._model = model
        self._processor = processor
        self._path = model_ref
        self._stream = mx.default_stream(mx.default_device())

        # Warm up the model to compile and initialize stream bindings on the main thread
        try:
            print(f"[MLX Engine] Warming up model '{model_ref}' on main thread...")
            prompt = apply_chat_template(processor, model.config, [{"role": "user", "content": "warmup"}])
            for _ in stream_generate(model, processor, prompt, max_tokens=1):
                pass
            print("[MLX Engine] Model warm-up complete.")
        except Exception as e:
            print(f"[MLX Engine] Warm-up failed: {e}")

    def unload(self) -> None:
        self._model = None
        self._processor = None
        self._path = None
        mx.clear_cache()

    @property
    def is_loaded(self) -> bool:
        return self._model is not None

    @property
    def path(self) -> Optional[str]:
        return self._path

    # ---- capabilities -------------------------------------------------------

    def supports_thinking(self) -> bool:
        if self._processor is None:
            return False
        template = getattr(self._processor, "chat_template", None)
        if not template and hasattr(self._processor, "tokenizer"):
            template = getattr(self._processor.tokenizer, "chat_template", None)
        if isinstance(template, str) and any(
                marker in template for marker in ("enable_thinking", "<think>", "<|channel>thought")):
            return True
        name = (self._path or "").lower()
        return "gemma-4" in name or any(
            x in name for x in ("r1", "reasoning", "thinking", "optiq", "math"))

    def supports_vision(self) -> bool:
        # mlx-vlm models are vision-language models.
        return True

    def supports_audio(self) -> bool:
        return True

    # ---- prompting / tokens -------------------------------------------------

    def _tokenizer(self):
        p = self._processor
        return p.tokenizer if hasattr(p, "tokenizer") else p

    def format_chat(self, messages: List[dict], system_prompt: str,
                    image_paths: List[str] = None, audio_paths: List[str] = None,
                    enable_thinking: Optional[bool] = None):
        extra = {} if enable_thinking is None else {"enable_thinking": enable_thinking}
        seq = [{"role": "system", "content": system_prompt}] if system_prompt else []
        # Identity priming: a short assistant turn that makes the model
        # "remember" it already accepted the Lemma persona.  This beats
        # the strong built-in identity prior of some base models (e.g. Gemma).
        if system_prompt and "Lemma" in system_prompt:
            seq.append({"role": "user", "content": "Understood. Who are you?"})
            seq.append({"role": "assistant", "content": "I'm Lemma, your personal assistant. How can I help you?"})
        seq += [{"role": m["role"], "content": m["text"]} for m in messages]
        return apply_chat_template(
            self._processor, self._model.config, seq,
            num_images=len(image_paths or []), num_audios=len(audio_paths or []), **extra)

    def count_tokens(self, text: str) -> int:
        return len(self._tokenizer().encode(text))

    def count_prompt_tokens(self, prompt) -> int:
        return len(self._tokenizer().encode(prompt))

    def prompt_open_thinking(self, prompt):
        return thinking.find_open_thinking(prompt)

    # ---- generation ---------------------------------------------------------

    def stream(self, prompt, image_paths: List[str] = None,
               audio_paths: List[str] = None, *, max_tokens: int,
               temperature: float = 1.0, max_kv_size: Optional[int] = None
               ) -> Iterator[str]:
        kwargs = {"max_tokens": max_tokens, "temperature": temperature}
        if max_kv_size:
            kwargs["max_kv_size"] = max_kv_size
        for chunk in stream_generate(
                self._model, self._processor, prompt,
                image=image_paths or None, audio=audio_paths or None, **kwargs):
            yield chunk.text

    def active_stream(self):
        return getattr(self, "_stream", None)

    def clear_cache(self) -> None:
        mx.clear_cache()
