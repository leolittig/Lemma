"""Optional debug tap.

When enabled (via POST /api/debug/toggle), every model generation — routing,
the chat reply, post-processing, and title generation — broadcasts its full
input prompt and each output token over the brain WebSocket, so a floating
debug window in the UI can show exactly what the model sees and produces in
each phase. No-op (zero overhead beyond a flag check) when disabled.
"""

import time

_enabled = False
_emit = None  # set by routes/brain to ws_manager.send_notification


def set_enabled(value: bool):
    global _enabled
    _enabled = bool(value)


def is_enabled() -> bool:
    return _enabled


def set_emitter(fn):
    """Wire the WebSocket broadcaster (called once at startup)."""
    global _emit
    _emit = fn


def emit(phase: str, kind: str, text: str = ""):
    """Broadcast one debug event. `kind` is 'input' | 'token' | 'end'.

    Safe to call from any thread; the emitter marshals onto the event loop.
    """
    if not _enabled or _emit is None:
        return
    try:
        _emit("debug", {"phase": phase, "kind": kind, "text": text, "ts": time.time()})
    except Exception:
        pass


def emit_prompt(phase: str, formatted):
    """Emit a generation's input. `formatted` may be an engine-specific prompt
    object (a string for MLX, a messages list for llama.cpp)."""
    if not _enabled:
        return
    if isinstance(formatted, str):
        text = formatted
    else:
        try:
            import json
            text = json.dumps(formatted, ensure_ascii=False, indent=2, default=str)
        except Exception:
            text = str(formatted)
    emit(phase, "input", text)
