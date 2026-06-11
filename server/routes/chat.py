"""POST /chat — the heart of the app: generate a streamed model reply.

What one request does, in order:
  1. Persist the user's message to the conversation (_save_user_turn).
  2. Build the prompt from the full history, trimming it to the context
     budget if needed (context_window.build_prompt).
  3. Stream the model's reply to the client as plain text (_generate),
     optionally filtering out the reasoning phase (thinking.py).
  4. Persist the finished reply.

Trimming metadata travels in response headers (X-Context-Trimmed and
X-Context-Out-Ranges) because the body is reserved for the raw text stream.
"""

import json

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse
from mlx_vlm.generate import stream_generate

from .. import config, thinking
from ..context_window import build_prompt
from ..model_manager import manager
from ..schemas import ChatRequest
from ..storage import database, uploads

router = APIRouter()


@router.post("/chat")
async def chat(msg: ChatRequest, request: Request):
    if not manager.is_loaded:
        return JSONResponse(
            status_code=503,
            content={"status": "error", "message": "No model is loaded. Select a compatible model first."})

    conv = database.get_conversation(msg.conversation_id)
    if conv is None:
        return JSONResponse(
            status_code=404,
            content={"status": "error", "message": "Conversation not found"})

    history = _save_user_turn(conv, msg)

    # Only THIS turn's media is fed to the model — apply_chat_template places
    # media tokens in the last user message, so prior-turn media isn't re-sent.
    image_paths = _media_paths(msg.attachments, "image")
    audio_paths = _media_paths(msg.attachments, "audio")

    formatted, trimmed, out_ranges = build_prompt(
        manager.model, manager.processor,
        history, conv.get("system_prompt") or "",
        len(image_paths), len(audio_paths), _prompt_budget(msg),
        enable_thinking=msg.enable_thinking,
        smart=msg.smart_context is not False,
    )

    stream = _generate(request, msg.conversation_id, formatted,
                       image_paths, audio_paths, _generation_kwargs(msg),
                       strip_thinking=msg.enable_thinking is False)
    headers = _context_headers(msg.conversation_id, trimmed, out_ranges)
    return StreamingResponse(stream, media_type="text/plain", headers=headers)


def _save_user_turn(conv, msg: ChatRequest):
    """Persist the user message; auto-title the chat from its first message and
    record the producing model. Returns the full history for generation."""
    database.add_message(msg.conversation_id, "user", msg.text, msg.attachments)

    updates = {"model": manager.path}
    if not (conv.get("title") or "").strip():
        first_line = (msg.text or "").strip().splitlines()
        updates["title"] = (first_line[0][:60] if first_line else "") or "New chat"
    database.update_conversation(msg.conversation_id, **updates)

    return conv["messages"] + [{"role": "user", "text": msg.text}]


def _media_paths(attachments, kind):
    return [str(uploads.upload_path(a["id"])) for a in attachments or [] if a.get("kind") == kind]


def _prompt_budget(msg: ChatRequest):
    """Prompt-token budget tied to the Context Window slider, with headroom
    left for the reply. Unlimited (no value, or <= 0) disables trimming."""
    if msg.max_kv_size and msg.max_kv_size > 0:
        return max(128, int(msg.max_kv_size * config.RESPONSE_HEADROOM))
    return None


def _generation_kwargs(msg: ChatRequest):
    max_tok = msg.max_tokens if msg.max_tokens is not None else config.DEFAULT_MAX_TOKENS
    kwargs = {
        "max_tokens": max_tok if max_tok > 0 else 1000000,  # <= 0 means unlimited
        "temperature": msg.temperature if msg.temperature is not None else config.DEFAULT_TEMPERATURE,
    }
    if msg.max_kv_size and msg.max_kv_size > 0:
        kwargs["max_kv_size"] = msg.max_kv_size
    return kwargs


def _context_headers(cid, trimmed, out_ranges):
    """Report which message ranges fell out of context. Persisted on the
    conversation too, so the UI dim survives reloads; cleared when everything fit."""
    if trimmed and out_ranges:
        ranges_json = json.dumps(out_ranges)
        database.set_context_window(cid, ranges_json)
        return {"X-Context-Trimmed": "1", "X-Context-Out-Ranges": ranges_json}
    database.set_context_window(cid, None)
    return {}


async def _generate(request, cid, formatted, image_paths, audio_paths,
                    gen_kwargs, strip_thinking):
    """Stream the model's reply, then persist the finished text.

    When the chat template left a thinking block open, the model's first
    tokens are reasoning, so the stream is prefixed with the opening tag for
    the frontend to parse. `strip_thinking` is the hard fallback for when the
    user turned thinking off but the model reasons anyway: the reasoning is
    removed from both the stream and what's stored.
    """
    thinking_open, thinking_tag = thinking.find_open_thinking(formatted)

    raw = ""        # everything the model produced (plus any tag we prepend)
    emitted = 0     # chars of the *visible* text already sent to the client
    if thinking_open:
        raw = thinking_tag
        yield thinking_tag
        emitted = len(raw)

    for chunk in stream_generate(
        manager.model, manager.processor, formatted,
        image=image_paths or None,
        audio=audio_paths or None,
        **gen_kwargs,
    ):
        raw += chunk.text
        if strip_thinking:
            # Emit the cleaned answer incrementally, holding back the last few
            # chars so a tag split across chunks ("</thi" | "nk>") is never
            # leaked before it's recognised.
            visible = thinking.strip_thinking(raw)
            safe_len = max(emitted, len(visible) - thinking.TAG_HOLDBACK)
            if safe_len > emitted:
                yield visible[emitted:safe_len]
                emitted = safe_len
        else:
            yield chunk.text
        # If the client hit Stop (aborted the fetch), end generation now —
        # otherwise we'd keep writing to a dead socket and block the event
        # loop from serving the next message.
        if await request.is_disconnected():
            break

    # Flush any held-back tail and settle the stored text.
    if strip_thinking:
        visible = thinking.strip_thinking(raw)
        if len(visible) > emitted:
            yield visible[emitted:]
        final_text = visible
    else:
        final_text = raw
    clean = final_text.replace("<end_of_utterance>", "").strip()
    database.add_message(cid, "assistant", clean, [])
