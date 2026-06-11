"""POST /chat — the heart of the app: generate a streamed model reply.

What one request does, in order:
  1. Check if the memory brain is enabled in the request (`enable_brain`).
  2. Run brain pre-analysis to identify relevant memory files (_run_routing).
  3. Inject the Assistant.md persona + retrieved memory into the system
     prompt (_build_system_prompt).
  4. Persist the user's message (_save_user_turn) and build the prompt,
     trimming it to the context budget if needed (context_window).
  5. Stream the reply to the client as plain text (_generate), optionally
     filtering out the reasoning phase (thinking.py), then persist it with
     its brain_activity record.
  6. Kick off a background thread where the brain manager updates the
     memory graph (_run_post_processing).

Metadata travels in response headers because the body is reserved for the raw
text stream: X-Context-Trimmed / X-Context-Out-Ranges for trimming, and
X-Brain-Activity for the routing info shown live in the UI.

Every MLX generation here (routing, chat, post-processing) holds
model_manager.generation_lock — see that module for why.
"""

import json
import re
import threading
from datetime import datetime

import mlx.core as mx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse
from mlx_vlm.generate import stream_generate
from mlx_vlm.prompt_utils import apply_chat_template

from .. import config, thinking
from ..context_window import build_prompt
from ..model_manager import manager, generation_lock, acquire_generation_lock
from ..schemas import ChatRequest
from ..storage import database, uploads
from ..storage import brain as storage_brain

router = APIRouter()

# Total characters of memory-file contents fed to the brain manager during
# post-processing (it must see current contents to update files losslessly).
POST_PROCESSING_CONTEXT_CHARS = 8000

# KV-cache cap for the internal brain generations (routing, post-processing).
# In the dual-model modes both models are resident (~17 GB), so an unbounded
# cache during a background generation can push Metal past its memory limit
# and hard-crash the process.
INTERNAL_MAX_KV = 4096


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

    # Resolve if the brain is enabled. If enabled, run routing pre-analysis.
    # Both touch MLX, so they hold the generation lock.
    brain_enabled = msg.enable_brain if msg.enable_brain is not None else True
    brain_mode = "active" if brain_enabled else None

    await acquire_generation_lock()
    try:
        routing = _run_routing(msg.text, brain_mode) if brain_mode else None
    except Exception as e:
        return JSONResponse(status_code=503, content={"status": "error", "message": str(e)})
    finally:
        generation_lock.release()

    chat_model = manager.model
    chat_processor = manager.processor
    chat_path = manager.path

    if not chat_model or not chat_processor:
        return JSONResponse(
            status_code=503,
            content={"status": "error", "message": f"Chat model ({chat_path}) is not loaded."})

    system_prompt = _build_system_prompt(
        conv.get("system_prompt") or "", brain_mode,
        routing["files_to_read"] if routing else [])

    history = _save_user_turn(conv, msg)

    # Only THIS turn's media is fed to the model — apply_chat_template places
    # media tokens in the last user message, so prior-turn media isn't re-sent.
    image_paths = _media_paths(msg.attachments, "image")
    audio_paths = _media_paths(msg.attachments, "audio")

    formatted, trimmed, out_ranges = build_prompt(
        chat_model, chat_processor,
        history, system_prompt,
        len(image_paths), len(audio_paths), _prompt_budget(msg),
        enable_thinking=msg.enable_thinking,
        smart=msg.smart_context is not False,
    )

    brain_activity = None
    if routing:
        brain_activity = {
            "routing_reasoning": routing["reasoning"],
            "files_read": routing["files_to_read"],
            "files_written": [],
            "files_deleted": [],
        }

    stream = _generate(request, msg.conversation_id, formatted,
                       image_paths, audio_paths, _generation_kwargs(msg),
                       strip_thinking=msg.enable_thinking is False,
                       chat_model=chat_model, chat_processor=chat_processor,
                       brain_mode=brain_mode,
                       brain_activity=brain_activity,
                       user_text=msg.text)
    headers = _context_headers(msg.conversation_id, trimmed, out_ranges)
    if brain_activity and (brain_activity["routing_reasoning"] or brain_activity["files_read"]):
        # Routing info for the live message bubble. json.dumps escapes
        # non-ASCII, which keeps the header value transport-safe.
        headers["X-Brain-Activity"] = json.dumps(brain_activity)
    return StreamingResponse(stream, media_type="text/plain", headers=headers)


def _routing_model_path(mode: str) -> str:
    """Which model does pre-analysis and post-processing. With single model setups this is always manager.path."""
    return manager.path


def _chat_model_path(mode: str) -> str:
    """Which model streams the chat reply. With single model setups this is always manager.path."""
    return manager.path


def _load_brain_map(mode: str) -> str:
    """The compact map.json index for a mode (or one built from file stems)."""
    brain_dir = storage_brain.get_brain_dir(mode)
    map_path = brain_dir / "map.json"
    if map_path.exists():
        try:
            return map_path.read_text(encoding="utf-8")
        except Exception:
            return "{}"
    return json.dumps({f.stem: "" for f in brain_dir.glob("*.md")})


def _read_brain_file(mode: str, fname: str):
    """A brain file's content by name (with or without .md), or None.
    Filenames come from model output, so they're sanitized and confined to
    the brain directory."""
    safe_name = fname.replace("/", "").replace("\\", "")
    if not safe_name.endswith(".md"):
        safe_name += ".md"
    brain_dir = storage_brain.get_brain_dir(mode).resolve()
    fpath = (brain_dir / safe_name).resolve()
    if fpath.is_relative_to(brain_dir) and fpath.exists():
        try:
            return fpath.read_text(encoding="utf-8")
        except Exception:
            return None
    return None


def _run_routing(user_text: str, mode: str) -> dict:
    """Run the routing model to identify which brain files to read.

    Returns { reasoning, files_to_read }. Caller must hold generation_lock.
    """
    result = {"reasoning": "", "files_to_read": []}

    model_path = _routing_model_path(mode)
    model = manager.get_model(model_path)
    processor = manager.get_processor(model_path)
    if not model or not processor:
        return result

    now = datetime.now().strftime("%A, %Y-%m-%d %H:%M")
    prompt = (
        f"You are a routing assistant. The current date/time is {now}.\n"
        f"Available brain memory files:\n{_load_brain_map(mode)}\n\n"
        f"User message: {user_text}\n\n"
        f"Respond with ONLY a JSON object (no markdown fencing) with two keys:\n"
        f'- "reasoning": a brief explanation of why these files are relevant\n'
        f'- "files": a list of filenames (without .md) to read for context\n'
        f"If no files are relevant, return an empty list.\n"
        f"Example: {{\"reasoning\": \"User asks about work\", \"files\": [\"Work\", \"LemmaProject\"]}}"
    )

    try:
        raw = _generate_once(model, processor, prompt, max_tokens=200)
        # The model may wrap the JSON in prose or ```json fencing.
        json_match = re.search(r'\{.*\}', raw, re.DOTALL)
        if json_match:
            parsed = json.loads(json_match.group())
            result["reasoning"] = parsed.get("reasoning", "")
            result["files_to_read"] = parsed.get("files", [])
    except Exception as e:
        print(f"Routing error: {e}")
        result["reasoning"] = f"Routing error: {e}"

    return result


def _generate_once(model, processor, prompt: str, max_tokens: int) -> str:
    """One non-streamed completion for the internal brain calls."""
    seq = [{"role": "user", "content": prompt}]
    formatted = apply_chat_template(processor, model.config, seq)
    try:
        chunks = [chunk.text for chunk in stream_generate(
            model, processor, formatted,
            max_tokens=max_tokens, max_kv_size=INTERNAL_MAX_KV)]
    finally:
        # Free the generation's GPU buffers right away — with two models
        # resident, leftover caches from consecutive generations are what
        # pushes Metal out of memory.
        mx.clear_cache()
    return thinking.strip_thinking("".join(chunks).strip()).strip()


def _build_system_prompt(conv_system_prompt: str, brain_mode, files_to_read: list) -> str:
    """Combine the conversation system prompt with the Assistant.md persona
    and any retrieved memory file contents. Prepend current date/time (including day of week)."""
    now_dt = datetime.now()
    # E.g. "Thursday, 2026-06-11 02:44"
    now_str = now_dt.strftime("%A, %Y-%m-%d %H:%M")
    time_prefix = f"[Current Date & Time]\n{now_str}"

    if not brain_mode:
        if conv_system_prompt:
            return f"{time_prefix}\n\n{conv_system_prompt}"
        return time_prefix

    parts = [time_prefix]

    # 1. Persona injection from Assistant.md (frontmatter stripped).
    persona = _read_brain_file(brain_mode, "Assistant")
    if persona:
        persona = re.sub(r'^---\s*\n.*?\n---\s*\n', '', persona, flags=re.DOTALL)
        parts.append(f"[Assistant Persona]\n{persona.strip()}")

    # 2. Retrieved memory context.
    for fname in files_to_read:
        content = _read_brain_file(brain_mode, fname)
        if content:
            parts.append(f"[Memory: {fname}]\n{content.strip()}")

    # 3. Original conversation system prompt.
    if conv_system_prompt:
        parts.append(conv_system_prompt)

    return "\n\n".join(parts)


def _run_post_processing(cid: str, msg_pos: int, mode: str, user_text: str,
                         assistant_text: str, brain_activity: dict):
    """Update the memory graph after a turn. Runs in a background thread.

    The brain manager model gets the instruction manual, the brain map, the
    contents of the files routing deemed relevant (so updates don't lose
    existing entries), and the conversation turn; it answers with CRUD
    commands (=== CREATE/UPDATE/DELETE file.md ===) that are executed on the
    active brain folder.
    """
    model_path = _routing_model_path(mode)
    model = manager.get_model(model_path)
    processor = manager.get_processor(model_path)
    if not model or not processor:
        return

    manual_path = config.PROJECT_ROOT / "server" / "brain" / "instruction_manual.md"
    try:
        manual = manual_path.read_text(encoding="utf-8")
    except Exception:
        manual = ""

    # Current contents of the relevant files, so UPDATE (a full overwrite)
    # can preserve their existing entries.
    file_sections = []
    remaining = POST_PROCESSING_CONTEXT_CHARS
    for fname in brain_activity.get("files_read", []):
        content = _read_brain_file(mode, fname)
        if content and remaining > 0:
            content = content[:remaining]
            remaining -= len(content)
            file_sections.append(f"--- Current content of {fname}.md ---\n{content}")
    files_context = "\n\n".join(file_sections)

    now = datetime.now().strftime("%A, %Y-%m-%d %H:%M")
    prompt = (
        f"{manual}\n\n"
        f"Current date/time: {now}\n"
        f"Current brain files: {_load_brain_map(mode)}\n\n"
        f"{files_context}\n\n"
        f"Analyze the following conversation turn and output any necessary "
        f"memory update commands (CREATE, UPDATE, DELETE).\n"
        f"If no updates are needed, output nothing.\n\n"
        f"User: {user_text}\n"
        f"Assistant: {assistant_text}\n\n"
        f"REMINDER: You must strictly follow the CRITICAL Verbal Dates Rule. "
        f"For any dates, deadlines, or scheduled events recorded inside the log entry text, "
        f"ALWAYS write the date using English month names (e.g., 'June 18th', 'June 22nd', 'July 5th') "
        f"and NEVER write purely numeric dates (e.g., NEVER '2026-06-18' or '06-18') in the text.\n\n"
        f"Output your update commands now:"
    )

    try:
        with generation_lock:
            response_text = _generate_once(model, processor, prompt, max_tokens=1500)
    except Exception as e:
        print(f"Post-processing generation error: {e}")
        return

    files_written, files_deleted = _execute_brain_commands(mode, response_text)

    # Fold the writes into the message's brain_activity record.
    if files_written or files_deleted:
        brain_activity["files_written"] = sorted(set(
            brain_activity.get("files_written", []) + files_written))
        brain_activity["files_deleted"] = sorted(set(
            brain_activity.get("files_deleted", []) + files_deleted))
        database.update_message_brain_activity(cid, msg_pos, brain_activity)

    storage_brain.rebuild_map(storage_brain.get_brain_dir(mode))


def _execute_brain_commands(mode: str, response_text: str):
    """Parse and execute the brain manager's CRUD commands.

    Returns (files_written, files_deleted). Invalid content (failing the
    markdown node standard) and escape attempts are rejected per command.
    """
    files_written = []
    files_deleted = []
    cmd_pattern = re.compile(r'===\s*(CREATE|UPDATE|DELETE)\s+(\S+)\s*===')
    matches = list(cmd_pattern.finditer(response_text))

    for i, match in enumerate(matches):
        action, filename = match.group(1), match.group(2)
        start_idx = match.end()
        end_idx = matches[i + 1].start() if i + 1 < len(matches) else len(response_text)
        content = response_text[start_idx:end_idx].strip()

        try:
            if action in ("CREATE", "UPDATE"):
                storage_brain.save_markdown_node(mode, filename, content)
                files_written.append(filename)
            elif action == "DELETE":
                brain_dir = storage_brain.get_brain_dir(mode).resolve()
                if not filename.endswith(".md"):
                    filename += ".md"
                target = (brain_dir / filename).resolve()
                if target.is_relative_to(brain_dir) and target.exists():
                    target.unlink()
                    files_deleted.append(filename)
        except Exception as e:
            print(f"Post-processing command error ({action} {filename}): {e}")

    return files_written, files_deleted


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
                    gen_kwargs, strip_thinking, chat_model, chat_processor,
                    brain_mode, brain_activity, user_text):
    """Stream the model's reply, persist it, then start the brain update.

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

    await acquire_generation_lock()
    try:
        for chunk in stream_generate(
            chat_model, chat_processor, formatted,
            image=image_paths or None,
            audio=audio_paths or None,
            **gen_kwargs,
        ):
            raw += chunk.text
            if strip_thinking:
                # Emit the cleaned answer incrementally, holding back the last
                # few chars so a tag split across chunks ("</thi" | "nk>") is
                # never leaked before it's recognised.
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
    finally:
        # Free this generation's GPU buffers before the next one (see
        # _generate_once for why this matters in dual-model modes).
        mx.clear_cache()
        generation_lock.release()

    # Flush any held-back tail and settle the stored text.
    if strip_thinking:
        visible = thinking.strip_thinking(raw)
        if len(visible) > emitted:
            yield visible[emitted:]
        final_text = visible
    else:
        final_text = raw
    clean = final_text.replace("<end_of_utterance>", "").strip()

    msg_pos = database.add_message(cid, "assistant", clean, [],
                                   brain_activity=brain_activity)

    # Update the memory graph in a background thread so the response isn't
    # held open. (FastAPI's BackgroundTasks can't be used inside a streaming
    # generator — the generator IS the response.) The thread serializes its
    # generation through generation_lock.
    if brain_mode:
        threading.Thread(
            target=_run_post_processing,
            args=(cid, msg_pos, brain_mode, user_text, clean, brain_activity),
            daemon=True,
        ).start()
