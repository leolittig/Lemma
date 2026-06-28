"""llama.cpp inference engine (cross-platform: Windows, Linux, macOS).

Wraps llama-cpp-python, running GGUF models. Text is always supported; image
input works for GGUF models shipped with an `mmproj` companion (a CLIP/LLaVA
projector), which the downloader places alongside the main .gguf — load()
auto-detects it and wires up a vision chat handler. Audio is not supported.

Imported only when a GGUF model is selected, so a machine without
llama-cpp-python installed never touches this module.
"""

from __future__ import annotations

import base64
import mimetypes
from pathlib import Path
from typing import Iterator, List, Optional

from llama_cpp import Llama

from .. import config
from .base import Engine

# Thinking markers shared with the MLX engine's template inspection.
_THINK_MARKERS = ("enable_thinking", "<think>", "<|channel>thought")


class LlamaEngine(Engine):
    name = "llama"

    def __init__(self):
        self._llama = None
        self._path = None
        self._has_vision = False

    # ---- lifecycle ----------------------------------------------------------

    def _find_mmproj(self, gguf_path: Path) -> Optional[Path]:
        """A sibling multimodal projector file, if the download paired one."""
        for f in gguf_path.parent.glob("*.gguf"):
            if "mmproj" in f.name.lower() or "mproj" in f.name.lower():
                return f
        return None

    def load(self, model_ref: str) -> None:
        gguf = Path(model_ref)
        chat_handler = None
        self._has_vision = False
        mmproj = self._find_mmproj(gguf)
        if mmproj is not None:
            # Multimodal projector. Use the modern mtmd handler, not the legacy
            # Llava15ChatHandler: Llava15 hardcodes a LLaVA-1.5 "USER:/ASSISTANT:"
            # prompt and a default system message, discarding the GGUF's own chat
            # template — which breaks current vision GGUFs (Gemma 3/4, Qwen-VL),
            # leaking the system prompt into the reply and producing gibberish.
            # MTMDChatHandler applies the model's embedded chat template, so both
            # text and image turns format correctly.
            from llama_cpp.llama_chat_format import MTMDChatHandler
            chat_handler = MTMDChatHandler(clip_model_path=str(mmproj), verbose=False)
            self._has_vision = True

        self._llama = Llama(
            model_path=str(gguf),
            n_ctx=config.LLAMA_N_CTX,
            n_gpu_layers=-1,            # offload all layers where a GPU build exists
            flash_attn=True,            # avoids padding the V cache (Gemma's per-layer
                                        # V dims differ) and is faster on Metal
            chat_handler=chat_handler,
            verbose=False,
        )
        self._path = model_ref

    def unload(self) -> None:
        self._llama = None
        self._path = None
        self._has_vision = False

    @property
    def is_loaded(self) -> bool:
        return self._llama is not None

    @property
    def path(self) -> Optional[str]:
        return self._path

    # ---- capabilities -------------------------------------------------------

    def _chat_template(self) -> str:
        try:
            return self._llama.metadata.get("tokenizer.chat_template", "") or ""
        except Exception:
            return ""

    def supports_thinking(self) -> bool:
        if any(m in self._chat_template() for m in _THINK_MARKERS):
            return True
        name = (self._path or "").lower()
        return any(x in name for x in ("r1", "reasoning", "thinking", "qwq", "math"))

    def supports_vision(self) -> bool:
        return self._has_vision

    def supports_audio(self) -> bool:
        return False

    # ---- prompting / tokens -------------------------------------------------

    @staticmethod
    def _image_data_uri(path: str) -> str:
        mime = mimetypes.guess_type(path)[0] or "image/png"
        data = base64.b64encode(Path(path).read_bytes()).decode("ascii")
        return f"data:{mime};base64,{data}"

    def format_chat(self, messages: List[dict], system_prompt: str,
                    image_paths: List[str] = None, audio_paths: List[str] = None,
                    enable_thinking: Optional[bool] = None):
        """Return a messages list for create_chat_completion. Images are embedded
        as data URIs on the last user turn (llama.cpp applies the GGUF's own
        chat template internally)."""
        seq = [{"role": "system", "content": system_prompt}] if system_prompt else []
        # Identity priming: see mlx_engine.py for rationale.
        if system_prompt and "Lemma" in system_prompt:
            seq.append({"role": "user", "content": "Understood. Who are you?"})
            seq.append({"role": "assistant", "content": "I'm Lemma, your personal assistant. How can I help you?"})
        for m in messages:
            seq.append({"role": m["role"], "content": m["text"] or ""})

        if image_paths and self._has_vision and seq:
            # Attach images to the final user message as a content-part list.
            last = seq[-1]
            parts = [{"type": "text", "text": last["content"]}]
            for p in image_paths:
                try:
                    parts.append({"type": "image_url",
                                  "image_url": {"url": self._image_data_uri(p)}})
                except Exception:
                    pass
            last["content"] = parts
        return seq

    def count_tokens(self, text: str) -> int:
        if not text:
            return 0
        try:
            return len(self._llama.tokenize(text.encode("utf-8"), add_bos=False))
        except Exception:
            # Conservative fallback: ~4 chars/token.
            return max(1, len(text) // 4)

    def count_prompt_tokens(self, prompt) -> int:
        total = 0
        for m in prompt:
            content = m.get("content")
            if isinstance(content, str):
                total += self.count_tokens(content) + 8
            elif isinstance(content, list):
                for part in content:
                    if part.get("type") == "text":
                        total += self.count_tokens(part.get("text", ""))
                total += 8
        return total

    # ---- generation ---------------------------------------------------------

    def stream(self, prompt, image_paths: List[str] = None,
               audio_paths: List[str] = None, *, max_tokens: int,
               temperature: float = 1.0, max_kv_size: Optional[int] = None
               ) -> Iterator[str]:
        # n_ctx is fixed at load, so max_kv_size is intentionally ignored here;
        # prompt trimming (context_window) keeps the prompt within n_ctx.
        for chunk in self._llama.create_chat_completion(
                messages=prompt, stream=True,
                max_tokens=max_tokens if max_tokens and max_tokens > 0 else None,
                temperature=temperature):
            delta = chunk["choices"][0].get("delta", {})
            text = delta.get("content")
            if text:
                yield text
