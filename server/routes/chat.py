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

import asyncio
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


def _generate_once(model, processor, prompt: str, max_tokens: int, on_token=None) -> str:
    """One completion for the internal brain calls.

    `on_token`, when given, is called with each chunk's text as it streams —
    used to surface the memory model's live output to the UI. It is a passive
    observer; the returned text and everything else is unchanged.
    """
    seq = [{"role": "user", "content": prompt}]
    formatted = apply_chat_template(processor, model.config, seq)
    try:
        chunks = []
        for chunk in stream_generate(
                model, processor, formatted,
                max_tokens=max_tokens, max_kv_size=INTERNAL_MAX_KV):
            chunks.append(chunk.text)
            if on_token:
                on_token(chunk.text)
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

    # 2. Today's journal, so the assistant recalls the day's interactions.
    today_journal = storage_brain.get_today_journal_text(brain_mode)
    if today_journal:
        parts.append(f"[Today's Journal]\n{today_journal}")

    # 3. Retrieved memory context.
    for fname in files_to_read:
        content = _read_brain_file(brain_mode, fname)
        if content:
            parts.append(f"[Memory: {fname}]\n{content.strip()}")

    # 4. Original conversation system prompt.
    if conv_system_prompt:
        parts.append(conv_system_prompt)

    return "\n\n".join(parts)


def _run_post_processing(cid: str, msg_pos: int, mode: str, user_text: str,
                         assistant_text: str, brain_activity: dict, profile: str = "default"):
    """Update the memory graph after a turn. Runs in a background thread.

    Wraps the actual work in a processing marker so the Brain Explorer can show
    that the graph is being updated (and is briefly stale) until it refreshes.
    """
    config.active_profile.set(profile)
    storage_brain.begin_processing()
    try:
        _do_post_processing(cid, msg_pos, mode, user_text, assistant_text, brain_activity)
    finally:
        storage_brain.end_processing()


def _get_manual_for_turn(mode: str, user_text: str, assistant_text: str, files_read: list) -> str:
    """Load only the relevant manual instruction files for a given conversation turn."""
    instructions_dir = config.PROJECT_ROOT / "server" / "brain" / "instructions"
    
    # Always load general.md
    general_path = instructions_dir / "general.md"
    manual_content = []
    loaded_files = []
    try:
        if general_path.exists():
            manual_content.append(general_path.read_text(encoding="utf-8"))
            loaded_files.append("general.md")
    except Exception as e:
        print(f"Error reading general manual: {e}")

    # Check frontmatter types of read files
    read_types = set()
    for fname in files_read:
        content = _read_brain_file(mode, fname)
        if content:
            m = re.search(r"^type:\s*(\w+)", content, re.MULTILINE)
            if m:
                read_types.add(m.group(1).lower())

    combined_text = f"{user_text} {assistant_text}".lower()

    include_people = "person" in read_types or any(k in combined_text for k in [
        "friend", "brother", "sister", "mom", "dad", "mother", "father", 
        "girlfriend", "boyfriend", "husband", "wife", "partner", "son", 
        "daughter", "cousin", "family", "born", "relationship", "meet", 
        "who is", "introduced"
    ])
    include_tasks = "task" in read_types or any(k in combined_text for k in [
        "todo", "to-do", "task", "project", "assignment", "homework", 
        "exam", "test", "errand", "obligation", "deadline", "due", 
        "status", "complete", "finish", "done", "need to"
    ])
    include_activities = "activity" in read_types or any(k in combined_text for k in [
        "job", "work", "school", "university", "college", "class", 
        "gig", "business", "hobby", "sport", "club", "practice", "play", "run"
    ])
    include_groups = "group" in read_types or include_people or include_tasks or include_activities or any(k in combined_text for k in [
        "friends", "family", "group", "team", "classmates", "coworkers"
    ])

    file_mappings = [
        ("people.md", include_people),
        ("tasks.md", include_tasks),
        ("activities.md", include_activities),
        ("groups.md", include_groups),
        ("calendar.md", "Calendar" in files_read or any(k in combined_text for k in [
            "birthday", "anniversary", "christmas", "valentine", "calendar", 
            "event", "schedule", "date", "next week", "tomorrow", "yesterday", 
            "holiday", "observance", "beliefs", "religion", "christian", 
            "catholic", "church", "past", "future", "january", "february", 
            "march", "april", "may", "june", "july", "august", "september", 
            "october", "november", "december"
        ])),
        ("journal.md", "Journal" in files_read or any(k in combined_text for k in [
            "journal", "diary", "log", "daily", "today", "yesterday", 
            "happened today", "notable"
        ])),
        ("assistant.md", "Assistant" in files_read or any(k in combined_text for k in [
            "always remind", "brief", "metric", "units", "assistant", 
            "behave", "respond", "prefer", "timezone"
        ])),
    ]

    for fname, should_include in file_mappings:
        if should_include:
            fpath = instructions_dir / fname
            try:
                if fpath.exists():
                    manual_content.append(fpath.read_text(encoding="utf-8"))
                    loaded_files.append(fname)
            except Exception as e:
                print(f"Error reading {fname}: {e}")

    print(f"[Brain Manager] Loaded instruction files for turn: {', '.join(loaded_files)}")
    return "\n\n---\n\n".join(manual_content)


def _do_post_processing(cid: str, msg_pos: int, mode: str, user_text: str,
                        assistant_text: str, brain_activity: dict):
    """The body of the memory-graph update.

    The brain manager model gets only the relevant instruction files, the brain map, the
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

    manual = _get_manual_for_turn(
        mode, user_text, assistant_text,
        list(brain_activity.get("files_read", []))
    )

    # Current contents of the relevant files, so a full-file UPDATE preserves
    # existing entries. Always include the root (User) and Calendar so the model
    # sees the current structure and never clobbers the date table on an edit.
    file_sections = []
    remaining = POST_PROCESSING_CONTEXT_CHARS
    seen_files = set()
    for fname in list(brain_activity.get("files_read", [])) + ["User", "Calendar"]:
        if fname in seen_files:
            continue
        seen_files.add(fname)
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

    storage_brain.log_activity("status", "Deciding what to write to memory…")
    try:
        with generation_lock:
            response_text = _generate_once(
                model, processor, prompt, max_tokens=3000,
                on_token=storage_brain.append_stream)
    except Exception as e:
        print(f"Post-processing generation error: {e}")
        storage_brain.log_activity("error", f"Memory update failed: {e}")
        return

    files_written, files_deleted = _execute_brain_commands(mode, response_text)
    if files_written or files_deleted:
        storage_brain.log_activity("status", "Memory updated.")
    else:
        storage_brain.log_activity("status", "No changes needed.")

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
    # CREATE/UPDATE/DELETE <file>, plus the Journal-only commands: JOURNAL
    # (append today) and JOURNAL_EDIT <YYYY-MM-DD> (rewrite one past day).
    cmd_pattern = re.compile(r'===\s*(CREATE|UPDATE|DELETE|JOURNAL_EDIT|JOURNAL|CALENDAR)\s*([^\s=]*)\s*===')
    matches = list(cmd_pattern.finditer(response_text))

    for i, match in enumerate(matches):
        action, arg = match.group(1), match.group(2)
        start_idx = match.end()
        end_idx = matches[i + 1].start() if i + 1 < len(matches) else len(response_text)
        content = response_text[start_idx:end_idx].strip()

        try:
            if action == "CALENDAR":
                storage_brain.append_calendar(mode, content)
                if "Calendar" not in files_written:
                    files_written.append("Calendar")
                storage_brain.log_activity("calendar", "Added a calendar entry")
            elif action == "JOURNAL":
                storage_brain.append_journal(mode, content)
                if "Journal" not in files_written:
                    files_written.append("Journal")
                storage_brain.log_activity("journal", "Added a journal entry")
            elif action == "JOURNAL_EDIT":
                storage_brain.edit_journal_day(mode, arg, content)
                if "Journal" not in files_written:
                    files_written.append("Journal")
                storage_brain.log_activity("journal", f"Edited journal entry for {arg}")
            elif action in ("CREATE", "UPDATE"):
                # The Journal is append-only via the JOURNAL commands — never
                # let a direct overwrite clobber its history.
                if _stem(arg) == "Journal":
                    storage_brain.log_activity("error", "Ignored a direct write to Journal (use JOURNAL).")
                    continue
                storage_brain.save_markdown_node(mode, arg, content)
                files_written.append(arg)
                verb = "Created" if action == "CREATE" else "Updated"
                storage_brain.log_activity("write", f"{verb} {arg}")
            elif action == "DELETE":
                filename = arg if arg.endswith(".md") else arg + ".md"
                brain_dir = storage_brain.get_brain_dir(mode).resolve()
                target = (brain_dir / filename).resolve()
                if target.is_relative_to(brain_dir) and target.exists():
                    target.unlink()
                    files_deleted.append(filename)
                    storage_brain.log_activity("delete", f"Deleted {filename}")
        except Exception as e:
            print(f"Post-processing command error ({action} {arg}): {e}")
            storage_brain.log_activity("error", f"Could not {action.lower()} {arg}: {e}")

    return files_written, files_deleted


def _stem(filename: str) -> str:
    return filename[:-3] if filename.endswith(".md") else filename


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


def parse_json_from_response(text: str):
    # Strip markdown code blocks if any
    clean_text = re.sub(r"```(?:json)?\s*(.*?)\s*```", r"\1", text, flags=re.DOTALL).strip()
    match = re.search(r"\{.*\}", clean_text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(0))
        except Exception:
            pass
    # Try parsing clean_text directly
    try:
        return json.loads(clean_text)
    except Exception:
        pass
    return None


def _run_title_generation(cid: str):
    """Generates a title for the conversation and renames it if it deviates too much from the current title."""
    try:
        conv = database.get_conversation(cid)
        if not conv:
            return

        messages = conv.get("messages", [])
        if not messages:
            return

        model_path = manager.path
        model = manager.get_model(model_path)
        processor = manager.get_processor(model_path)
        if not model or not processor:
            return

        # Format conversation history
        history_lines = []
        for msg in messages:
            role = msg["role"].capitalize()
            text = msg["text"] or ""
            history_lines.append(f"{role}: {text}")
        history_text = "\n".join(history_lines)

        # Keep history within limits (e.g. last 6000 chars)
        if len(history_text) > 6000:
            history_text = "..." + history_text[-6000:]

        current_title = (conv.get("title") or "").strip()
        if not current_title or current_title == "New chat":
            current_title_arg = "None"
        else:
            current_title_arg = current_title

        prompt = (
            "Analyze the following chat conversation history. Propose a very small, extremely concise, and descriptive title (strictly 2 to 3 words) for it. "
            "Also decide if the conversation topic has deviated/shifted so much from the current title that the chat should be renamed. "
            "If the current title is empty, 'New chat', or no longer represents the main topic of the conversation, set should_rename to true.\n"
            "Keep the proposed_title very brief and focused, avoiding extra fluff words.\n\n"
            f"Current Title: {current_title_arg}\n\n"
            "Conversation:\n"
            f"{history_text}\n\n"
            "You MUST respond ONLY with a JSON object in this format:\n"
            "{\n"
            "  \"proposed_title\": \"Write the new title here\",\n"
            "  \"should_rename\": true or false\n"
            "}\n"
        )

        with generation_lock:
            response_text = _generate_once(model, processor, prompt, max_tokens=150)

        data = parse_json_from_response(response_text)
        if data and isinstance(data, dict):
            proposed_title = (data.get("proposed_title") or "").strip()
            should_rename = data.get("should_rename")
            if isinstance(should_rename, str):
                should_rename = should_rename.lower() in ("true", "yes", "1")
            if proposed_title:
                if not current_title or current_title == "New chat" or should_rename is True:
                    # Limit title length to 60 characters
                    proposed_title = proposed_title[:60]
                    database.update_conversation(cid, title=proposed_title)
                    print(f"[Title Gen] Chat {cid} renamed from '{current_title}' to '{proposed_title}'")
    except Exception as e:
        print(f"Error generating chat title: {e}")


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
        profile = config.active_profile.get()
        threading.Thread(
            target=_run_post_processing,
            args=(cid, msg_pos, brain_mode, user_text, clean, brain_activity, profile),
            daemon=True,
        ).start()

    # Update the conversation title if needed
    try:
        await asyncio.to_thread(_run_title_generation, cid)
    except Exception as e:
        print(f"Error calling title generation thread: {e}")
