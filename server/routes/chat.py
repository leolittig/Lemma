"""POST /chat — the heart of the app: generate a streamed model reply.

What one request does, in order:
  1. Persist the user's message to the conversation (_save_user_turn).
  2. Run brain pre-analysis to identify relevant memory files.
  3. Inject persona from Assistant.md + retrieved memory context.
  4. Build the prompt from the full history, trimming it to the context
     budget if needed (context_window.build_prompt).
  5. Stream the model's reply to the client as plain text (_generate),
     optionally filtering out the reasoning phase (thinking.py).
  6. Persist the finished reply with brain_activity metadata.
  7. Run async post-processing to update the brain graph.

Trimming metadata travels in response headers (X-Context-Trimmed and
X-Context-Out-Ranges) because the body is reserved for the raw text stream.
"""

import json
import re
import threading
from datetime import datetime

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse
from mlx_vlm.generate import stream_generate
from mlx_vlm.prompt_utils import apply_chat_template

from .. import config, thinking
from ..context_window import build_prompt
from ..model_manager import manager
from ..schemas import ChatRequest
from ..storage import database, uploads
from ..storage import brain as storage_brain

router = APIRouter()


# ---------------------------------------------------------------------------
# Helpers: model selection per mode
# ---------------------------------------------------------------------------

def _routing_model_path(mode: str) -> str:
    """Which model does pre-analysis and post-processing for a given mode."""
    if mode == "12b-chat-e4b-brain":
        return manager.SMALL_MODEL
    return manager.LARGE_MODEL  # everything-12b and e4b-chat-12b-brain


def _chat_model_path(mode: str) -> str:
    """Which model streams the chat reply for a given mode."""
    if mode == "e4b-chat-12b-brain":
        return manager.SMALL_MODEL
    return manager.LARGE_MODEL  # everything-12b and 12b-chat-e4b-brain


# ---------------------------------------------------------------------------
# Pre-analysis: route the user message through the brain
# ---------------------------------------------------------------------------

def _run_routing(user_text: str, mode: str) -> dict:
    """Run the routing model to identify which brain files to read.

    Returns { reasoning, files_to_read }.
    """
    result = {"reasoning": "", "files_to_read": []}

    model_path = _routing_model_path(mode)
    model = manager.get_model(model_path)
    processor = manager.get_processor(model_path)
    if not model or not processor:
        return result

    # Load the compact brain map so the model knows what files exist.
    brain_dir = storage_brain.get_brain_dir(mode)
    map_path = brain_dir / "map.json"
    if map_path.exists():
        try:
            brain_map = map_path.read_text(encoding="utf-8")
        except Exception:
            brain_map = "{}"
    else:
        # Build one on the fly from file stems
        files = [f.stem for f in brain_dir.glob("*.md")]
        brain_map = json.dumps({f: "" for f in files})

    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    prompt = (
        f"You are a routing assistant. The current date/time is {now}.\n"
        f"Available brain memory files:\n{brain_map}\n\n"
        f"User message: {user_text}\n\n"
        f"Respond with ONLY a JSON object (no markdown fencing) with two keys:\n"
        f'- "reasoning": a brief explanation of why these files are relevant\n'
        f'- "files": a list of filenames (without .md) to read for context\n'
        f"If no files are relevant, return an empty list.\n"
        f"Example: {{\"reasoning\": \"User asks about work\", \"files\": [\"Work\", \"LemmaProject\"]}}"
    )

    try:
        seq = [{"role": "user", "content": prompt}]
        formatted = apply_chat_template(processor, model.config, seq)
        chunks = []
        for chunk in stream_generate(model, processor, formatted, max_tokens=200):
            chunks.append(chunk.text)
        raw = "".join(chunks).strip()

        # Strip thinking tags if the model emitted them.
        raw = thinking.strip_thinking(raw)

        # Try to parse JSON from the response.
        # Handle cases where the model wraps in ```json ... ```
        json_match = re.search(r'\{.*\}', raw, re.DOTALL)
        if json_match:
            parsed = json.loads(json_match.group())
            result["reasoning"] = parsed.get("reasoning", "")
            result["files_to_read"] = parsed.get("files", [])
    except Exception as e:
        print(f"Routing error: {e}")
        result["reasoning"] = f"Routing error: {e}"

    return result


# ---------------------------------------------------------------------------
# Persona + memory injection
# ---------------------------------------------------------------------------

def _build_system_prompt(conv_system_prompt: str, mode: str, files_to_read: list) -> str:
    """Combine the conversation system prompt with Assistant.md persona and
    any retrieved memory file contents."""
    parts = []

    brain_dir = storage_brain.get_brain_dir(mode)

    # 1. Persona injection from Assistant.md
    assistant_file = brain_dir / "Assistant.md"
    if assistant_file.exists():
        try:
            persona = assistant_file.read_text(encoding="utf-8")
            # Strip frontmatter for cleaner injection
            fm_match = re.match(r'^---\s*\n.*?\n---\s*\n', persona, re.DOTALL)
            if fm_match:
                persona = persona[fm_match.end():]
            parts.append(f"[Assistant Persona]\n{persona.strip()}")
        except Exception:
            pass

    # 2. Retrieved memory context
    for fname in files_to_read:
        safe_name = fname.replace("/", "").replace("\\", "")
        if not safe_name.endswith(".md"):
            safe_name += ".md"
        fpath = brain_dir / safe_name
        if fpath.exists() and fpath.is_relative_to(brain_dir):
            try:
                content = fpath.read_text(encoding="utf-8")
                parts.append(f"[Memory: {fname}]\n{content.strip()}")
            except Exception:
                pass

    # 3. Original conversation system prompt
    if conv_system_prompt:
        parts.append(conv_system_prompt)

    return "\n\n".join(parts) if parts else ""


# ---------------------------------------------------------------------------
# Post-processing: update the brain graph asynchronously
# ---------------------------------------------------------------------------

def _run_post_processing(cid: str, msg_pos: int, mode: str, user_text: str,
                         assistant_text: str, brain_activity: dict):
    """Run in a background thread after the stream finishes.
    The brain model analyses the conversation turn and emits CRUD commands."""

    model_path = _routing_model_path(mode)
    model = manager.get_model(model_path)
    processor = manager.get_processor(model_path)
    if not model or not processor:
        return

    # Load the instruction manual
    manual_path = config.PROJECT_ROOT / "server" / "brain" / "instruction_manual.md"
    try:
        manual = manual_path.read_text(encoding="utf-8")
    except Exception:
        manual = ""

    # Load current brain map
    brain_dir = storage_brain.get_brain_dir(mode)
    map_path = brain_dir / "map.json"
    brain_map = "{}"
    if map_path.exists():
        try:
            brain_map = map_path.read_text(encoding="utf-8")
        except Exception:
            pass

    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    prompt = (
        f"{manual}\n\n"
        f"Current date/time: {now}\n"
        f"Current brain files: {brain_map}\n\n"
        f"Analyze the following conversation turn and output any necessary "
        f"memory update commands (CREATE, UPDATE, DELETE).\n"
        f"If no updates are needed, output nothing.\n\n"
        f"User: {user_text}\n"
        f"Assistant: {assistant_text}\n\n"
        f"Output your update commands now:"
    )

    try:
        seq = [{"role": "user", "content": prompt}]
        formatted = apply_chat_template(processor, model.config, seq)
        chunks = []
        for chunk in stream_generate(model, processor, formatted, max_tokens=1500):
            chunks.append(chunk.text)
        response_text = "".join(chunks).strip()
        response_text = thinking.strip_thinking(response_text)
    except Exception as e:
        print(f"Post-processing generation error: {e}")
        return

    # Parse and execute commands
    files_written = []
    files_deleted = []
    cmd_pattern = re.compile(r'===\s*(CREATE|UPDATE|DELETE)\s+(\S+)\s*===')
    matches = list(cmd_pattern.finditer(response_text))

    for i, match in enumerate(matches):
        action = match.group(1)
        filename = match.group(2)
        start_idx = match.end()
        end_idx = matches[i + 1].start() if i + 1 < len(matches) else len(response_text)
        content = response_text[start_idx:end_idx].strip()

        try:
            if action in ("CREATE", "UPDATE"):
                storage_brain.save_markdown_node(mode, filename, content)
                files_written.append(filename)
            elif action == "DELETE":
                brain_dir_resolved = storage_brain.get_brain_dir(mode).resolve()
                if not filename.endswith(".md"):
                    filename += ".md"
                target = (brain_dir_resolved / filename).resolve()
                if target.is_relative_to(brain_dir_resolved) and target.exists():
                    target.unlink()
                    files_deleted.append(filename)
        except Exception as e:
            print(f"Post-processing command error ({action} {filename}): {e}")

    # Update the brain_activity record on the message
    if files_written or files_deleted:
        brain_activity["files_written"] = list(set(
            brain_activity.get("files_written", []) + files_written))
        brain_activity["files_deleted"] = list(set(
            brain_activity.get("files_deleted", []) + files_deleted))
        database.update_message_brain_activity(cid, msg_pos, brain_activity)

    # Rebuild the brain map
    _rebuild_brain_map(mode)


def _rebuild_brain_map(mode: str):
    """Rebuild brain/map.json from the current .md files."""
    brain_dir = storage_brain.get_brain_dir(mode)
    brain_map = {}
    for fpath in brain_dir.glob("*.md"):
        try:
            content = fpath.read_text(encoding="utf-8")
            parsed = storage_brain.parse_markdown_node(content)
            brain_map[fpath.stem] = parsed.get("description", "")[:100]
        except Exception:
            brain_map[fpath.stem] = ""
    map_path = brain_dir / "map.json"
    map_path.write_text(json.dumps(brain_map, indent=2), encoding="utf-8")


# ---------------------------------------------------------------------------
# Main endpoint
# ---------------------------------------------------------------------------

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

    active_mode = msg.brain_mode or manager.active_mode

    # 1. Pre-Analysis: identify memory files to read
    routing = _run_routing(msg.text, active_mode)

    # 2. Build enriched system prompt with persona + memory context
    system_prompt = _build_system_prompt(
        conv.get("system_prompt") or "", active_mode, routing["files_to_read"])

    history = _save_user_turn(conv, msg)

    # Only THIS turn's media is fed to the model — apply_chat_template places
    # media tokens in the last user message, so prior-turn media isn't re-sent.
    image_paths = _media_paths(msg.attachments, "image")
    audio_paths = _media_paths(msg.attachments, "audio")

    # Select the correct chat model for this mode
    chat_path = _chat_model_path(active_mode)
    chat_model = manager.get_model(chat_path)
    chat_processor = manager.get_processor(chat_path)

    if not chat_model or not chat_processor:
        return JSONResponse(
            status_code=503,
            content={"status": "error", "message": f"Chat model ({chat_path}) is not loaded."})

    formatted, trimmed, out_ranges = build_prompt(
        chat_model, chat_processor,
        history, system_prompt,
        len(image_paths), len(audio_paths), _prompt_budget(msg),
        enable_thinking=msg.enable_thinking,
        smart=msg.smart_context is not False,
    )

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
                       active_mode=active_mode,
                       brain_activity=brain_activity,
                       user_text=msg.text)
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
                    gen_kwargs, strip_thinking, chat_model, chat_processor,
                    active_mode, brain_activity, user_text):
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
        chat_model, chat_processor, formatted,
        image=image_paths or None,
        audio=audio_paths or None,
        **gen_kwargs,
    ):
        raw += chunk.text
        if strip_thinking:
            visible = thinking.strip_thinking(raw)
            safe_len = max(emitted, len(visible) - thinking.TAG_HOLDBACK)
            if safe_len > emitted:
                yield visible[emitted:safe_len]
                emitted = safe_len
        else:
            yield chunk.text
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

    # Persist the assistant message with brain activity
    msg_pos = database.add_message(cid, "assistant", clean, [],
                                   brain_activity=brain_activity)

    # Run post-processing in a background thread so we don't block the
    # response. (We can't use FastAPI's BackgroundTasks inside a streaming
    # generator — it only fires after the response is fully sent, but the
    # generator IS the response.)
    thread = threading.Thread(
        target=_run_post_processing,
        args=(cid, msg_pos, active_mode, user_text, clean, brain_activity),
        daemon=True,
    )
    thread.start()
