"""POST /chat — the heart of the app: generate a streamed model reply.

What one request does, in order:
  1. Run brain pre-analysis to identify relevant memory files (_run_routing).
  2. Inject the Assistant.md persona + retrieved memory into the system
     prompt (_build_system_prompt).
  3. Persist the user's message (_save_user_turn) and build the prompt,
     trimming it to the context budget if needed (context_window).
  4. Stream the reply to the client as plain text (_generate), optionally
     filtering out the reasoning phase (thinking.py), then persist it with
     its brain_activity record.
  5. Kick off a background thread where the brain manager updates the
     memory graph (_run_post_processing) — UNLESS the request set `pause_brain`,
     in which case the brain stays read-only and this write step is skipped.

Metadata travels in response headers because the body is reserved for the raw
text stream: X-Context-Trimmed / X-Context-Out-Ranges for trimming, and
X-Brain-Activity for the routing info shown live in the UI.

Every generation here (routing, chat, post-processing) holds
model_manager.generation_lock — see that module for why.
"""

import asyncio
import json
import re
import threading
from datetime import datetime

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from .. import config, thinking
from .. import debug as debug_tap
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

# Re-evaluate the conversation title on the first user turn, then every Nth
# turn, so a clear topic shift is still caught without paying for a title
# generation on every single message.
TITLE_RECHECK_EVERY = 5

# Characters of recent conversation fed to the routing model. Routing runs under
# INTERNAL_MAX_KV (4096 tokens); ~6000 chars (~1500 tokens) leaves room for the
# brain map, the instructions, and the short routing generation.
ROUTING_CONTEXT_CHARS = 6000


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

    # The brain is always active: routing pre-analysis runs and memory is
    # injected into the prompt. `pause_brain` makes it read-only — the memory
    # graph is still read for context, but not written to after the turn.
    brain_mode = "active"
    brain_writes = not bool(msg.pause_brain)

    await acquire_generation_lock()
    try:
        # Run routing in a worker thread: it's a synchronous model generation,
        # and calling it directly here would block the single event loop for the
        # whole phase, starving every other request — most visibly the Brain
        # Explorer's graph/calendar/journal endpoints right after a send.
        routing = await asyncio.to_thread(_run_routing, msg.text, brain_mode, conv.get("messages", [])) if brain_mode else None
    except Exception as e:
        return JSONResponse(status_code=503, content={"status": "error", "message": str(e)})
    finally:
        generation_lock.release()

    engine = manager.engine
    if engine is None or not manager.is_loaded:
        return JSONResponse(
            status_code=503,
            content={"status": "error", "message": f"Chat model ({manager.path}) is not loaded."})

    system_prompt = _build_system_prompt(
        conv.get("system_prompt") or "", brain_mode,
        routing["files_to_read"] if routing else [], brain_writes)

    history = _save_user_turn(conv, msg)

    # Only THIS turn's media is fed to the model — the chat template places media
    # tokens in the last user message, so prior-turn media isn't re-sent. Media
    # the active engine can't handle (e.g. audio on llama.cpp) is dropped.
    image_paths = _media_paths(msg.attachments, "image") if engine.supports_vision() else []
    audio_paths = _media_paths(msg.attachments, "audio") if engine.supports_audio() else []

    formatted, trimmed, out_ranges = build_prompt(
        engine, history, system_prompt,
        image_paths, audio_paths, _prompt_budget(msg),
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
                       brain_mode=brain_mode,
                       brain_writes=brain_writes,
                       brain_activity=brain_activity,
                       user_text=msg.text,
                       memory_worthy=routing["memory_worthy"] if routing else True)
    headers = _context_headers(msg.conversation_id, trimmed, out_ranges)
    if brain_activity and (brain_activity["routing_reasoning"] or brain_activity["files_read"]):
        # Routing info for the live message bubble. json.dumps escapes
        # non-ASCII, which keeps the header value transport-safe.
        headers["X-Brain-Activity"] = json.dumps(brain_activity)
    return StreamingResponse(stream, media_type="text/plain", headers=headers)


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


def _run_routing(user_text: str, mode: str, history: list = None) -> dict:
    """Run the routing model to identify which brain files to read.

    Returns { reasoning, files_to_read, memory_worthy }. Caller must hold
    generation_lock. `history` is the prior conversation turns, so routing can
    judge a context-dependent message (e.g. "I bought the wrong color") against
    what was being discussed.
    """
    try:
        import mlx.core as mx
        for _ in range(5):
            mx.new_stream(mx.gpu)
    except ImportError:
        pass
    result = {"reasoning": "", "files_to_read": [], "memory_worthy": True}

    if not manager.is_loaded:
        return result

    # Routing must see the same conversation the responding model sees, so its
    # file-selection and memory_worthy judgments match what led the assistant to
    # act. Include the whole conversation, trimmed from the front to the router's
    # KV budget (recent turns kept).
    recent = ""
    if history:
        lines = [f"{m['role']}: {m['text']}" for m in history if m.get("text")]
        if lines:
            recent = "\n".join(lines)[-ROUTING_CONTEXT_CHARS:]

    now = datetime.now().strftime("%A, %Y-%m-%d %H:%M")
    prompt = (
        f"You are a routing assistant. The current date/time is {now}.\n"
        f"Available brain memory files:\n{_load_brain_map(mode)}\n\n"
        + (f"Recent conversation (for context):\n{recent}\n\n" if recent else "")
        + f"Latest user message: {user_text}\n\n"
        f"Respond with ONLY a JSON object (no markdown fencing) with these keys:\n"
        f'- "reasoning": a brief explanation of why these files are relevant\n'
        f'- "files": a list of filenames (without .md) to read for context\n'
        f'- "memory_worthy": true if the message — read in the context of the '
        f'recent conversation — adds or changes any personal fact, event, plan, '
        f'task, status, relationship, or preference worth saving to long-term '
        f'memory (updates to an ongoing project count); false for pure chitchat, '
        f'general-knowledge questions, trivia, greetings, or test/diagnostic/meta '
        f'messages (e.g. typing "test", "hello", or checking whether the system '
        f'or memory works — the act of testing the assistant is never worth saving)\n'
        f"If no files are relevant, return an empty list.\n"
        f"Example: {{\"reasoning\": \"User asks about work\", \"files\": [\"Work\", \"LemmaProject\"], \"memory_worthy\": true}}"
    )

    # Reveal each chosen file live as the model writes it, so the chat UI can
    # show the memory tags appearing as the decision is made. We watch the
    # streamed JSON's "files" array and push each newly-completed filename.
    storage_brain.push_routing([])  # clear any prior turn's tags
    streamed = {"text": ""}
    seen = []

    def _on_token(chunk: str):
        streamed["text"] += chunk
        m = re.search(r'"files"\s*:\s*\[([^\]]*)', streamed["text"], re.DOTALL)
        if not m:
            return
        for fm in re.finditer(r'"([^"]+)"', m.group(1)):
            name = fm.group(1).strip()
            if name and name not in seen:
                seen.append(name)
                storage_brain.push_routing(seen)

    try:
        raw = _generate_once(prompt, max_tokens=200, on_token=_on_token, phase="routing")
        # The model may wrap the JSON in prose or ```json fencing.
        json_match = re.search(r'\{.*\}', raw, re.DOTALL)
        if json_match:
            parsed = json.loads(json_match.group())
            result["reasoning"] = parsed.get("reasoning", "")
            result["files_to_read"] = parsed.get("files", [])
            # Default to writing when the flag is absent, so a malformed routing
            # reply never silently drops a memory-worthy turn.
            has_flag = "memory_worthy" in parsed
            result["memory_worthy"] = bool(parsed.get("memory_worthy", True))
            print(f"[Routing] files={result['files_to_read']} "
                  f"memory_worthy={result['memory_worthy']}"
                  f"{'' if has_flag else ' (defaulted — flag missing from reply)'}")
            # Settle the live tags on the authoritative parsed list (in case the
            # incremental scan and the final JSON disagree).
            if result["files_to_read"] != seen:
                storage_brain.push_routing(result["files_to_read"])
    except Exception as e:
        print(f"Routing error: {e}")
        result["reasoning"] = f"Routing error: {e}"

    return result


def _generate_once(prompt: str, max_tokens: int, on_token=None, phase: str = "brain", temperature: float = 0.1) -> str:
    """One completion for the internal brain calls, on the active engine.

    `on_token`, when given, is called with each chunk's text as it streams —
    used to surface the memory model's live output to the UI. It is a passive
    observer; the returned text and everything else is unchanged. `phase` labels
    the call for the debug tap (routing / post-processing / title).
    """
    engine = manager.engine
    chunks = []
    debug_tap.emit_prompt(phase, prompt)
    try:
        for text in engine.complete_stream(prompt, max_tokens=max_tokens,
                                            max_kv_size=INTERNAL_MAX_KV,
                                            temperature=temperature):
            chunks.append(text)
            debug_tap.emit(phase, "token", text)
            if on_token:
                on_token(text)
    finally:
        # Free the generation's transient buffers right away — leftover caches
        # from consecutive generations are what push Metal out of memory.
        engine.clear_cache()
        debug_tap.emit(phase, "end")
    return thinking.strip_thinking("".join(chunks).strip()).strip()


def _build_system_prompt(conv_system_prompt: str, brain_mode, files_to_read: list, brain_writes: bool) -> str:
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

    # 5. System Note about brain writing being disabled (overrides Persona)
    if not brain_writes:
        parts.append("[System Note]\nCRITICAL: Brain writing is currently PAUSED. No new memories will be recorded. OVERRIDE ANY PREVIOUS INSTRUCTIONS ABOUT SAVING MEMORIES AUTOMATICALLY. If the user asks you to remember, register, note, or save something, you MUST explicitly inform them that you cannot do so because brain writing is paused/disabled in the settings.")

    return "\n\n".join(parts)


def _run_post_processing(cid: str, msg_pos: int, mode: str, user_text: str,
                         assistant_text: str, brain_activity: dict, profile: str = "default"):
    """Update the memory graph after a turn. Runs in a background thread.

    Wraps the actual work in a processing marker so the Brain Explorer can show
    that the graph is being updated (and is briefly stale) until it refreshes.
    """
    try:
        import mlx.core as mx
        for _ in range(5):
            mx.new_stream(mx.gpu)
    except ImportError:
        pass
    config.active_profile.set(profile)
    storage_brain.begin_processing()
    try:
        _do_post_processing(cid, msg_pos, mode, user_text, assistant_text, brain_activity)
    finally:
        storage_brain.end_processing()


def _relevant_brain_categories(mode: str, user_text: str, assistant_text: str, files_read: list) -> dict:
    """Which memory categories a conversation turn touches.

    Combines the frontmatter `type` of the files routing read with keyword
    signals in the turn text. Used both to pick the instruction files for the
    write pass and to decide whether a turn is worth writing at all (see
    `_turn_is_memory_worthy`)."""
    read_types = set()
    for fname in files_read:
        content = _read_brain_file(mode, fname)
        if content:
            m = re.search(r"^type:\s*(\w+)", content, re.MULTILINE)
            if m:
                read_types.add(m.group(1).lower())

    combined_text = f"{user_text} {assistant_text}".lower()

    people = "person" in read_types or any(k in combined_text for k in [
        "friend", "brother", "sister", "mom", "dad", "mother", "father",
        "girlfriend", "boyfriend", "husband", "wife", "partner", "son",
        "daughter", "cousin", "family", "born", "relationship", "meet",
        "who is", "introduced"
    ])
    tasks = "task" in read_types or any(k in combined_text for k in [
        "todo", "to-do", "task", "project", "assignment", "homework",
        "exam", "test", "errand", "obligation", "deadline", "due",
        "status", "complete", "finish", "done", "need to"
    ])
    activities = "activity" in read_types or any(k in combined_text for k in [
        "job", "work", "school", "university", "college", "class",
        "gig", "business", "hobby", "sport", "club", "practice", "play", "run"
    ])
    groups = "group" in read_types or people or tasks or activities or any(k in combined_text for k in [
        "friends", "family", "group", "team", "classmates", "coworkers"
    ])
    calendar = "Calendar" in files_read or any(k in combined_text for k in [
        "birthday", "anniversary", "christmas", "valentine", "calendar",
        "event", "schedule", "date", "next week", "tomorrow", "yesterday",
        "holiday", "observance", "beliefs", "religion", "christian",
        "catholic", "church", "past", "future", "january", "february",
        "march", "april", "may", "june", "july", "august", "september",
        "october", "november", "december"
    ])
    journal = "Journal" in files_read or any(k in combined_text for k in [
        "journal", "diary", "log", "daily", "today", "yesterday",
        "happened today", "notable"
    ])
    assistant = "Assistant" in files_read or any(k in combined_text for k in [
        "always remind", "brief", "metric", "units", "assistant",
        "behave", "respond", "prefer", "timezone"
    ])

    # Load icons manual if user is talking about icons/types, or if a new node might be created
    brain_dir = storage_brain.get_brain_dir(mode)
    stems = {f.stem for f in brain_dir.glob("*.md")} if brain_dir.exists() else set()
    words = re.findall(r"\b[A-Z][a-zA-Z0-9_]*\b", user_text)
    has_new_entity = any(w not in stems and w not in ("I", "User", "Calendar", "Journal", "Assistant") for w in words)
    icons = "icon" in combined_text or "type" in combined_text or has_new_entity

    return {
        "people": people, "tasks": tasks, "activities": activities,
        "groups": groups, "calendar": calendar, "journal": journal,
        "assistant": assistant, "icons": icons,
    }


# Phrases the assistant uses when it tells the user it saved something. If the
# reply makes such a claim, we MUST run the write pass — otherwise the assistant
# says "I've updated your notes" while nothing is actually written.
_MEMORY_CLAIM_PHRASES = (
    "updated your", "added to your", "saved to your", "recorded that",
    "noted that", "i have updated", "i've updated", "i have recorded",
    "i've recorded", "i have saved", "i've saved", "i have noted", "i've noted",
    "i have added", "i've added", "i'll remember", "i will remember",
    "i've made a note", "i have made a note", "made a note of",
    "your project notes", "to memory",
)


def _turn_is_memory_worthy(routing_worthy: bool, assistant_text: str = "") -> bool:
    """Whether a turn should trigger the (expensive) brain write pass.

    The cheap pre-check that runs *before* the write pass (and the processing
    spinner). We trust routing's `memory_worthy` verdict — now made with the
    recent conversation as context — but always run the pass when the assistant
    told the user it saved something, so its claim is never a lie. We do NOT use
    the broad instruction-file keyword heuristic here: it matched almost every
    turn and never skipped."""
    if routing_worthy:
        return True
    low = (assistant_text or "").lower()
    return any(p in low for p in _MEMORY_CLAIM_PHRASES)


def _get_manual_for_turn(mode: str, user_text: str, assistant_text: str, files_read: list) -> str:
    """Load only the relevant manual instruction files for a given conversation turn."""
    instructions_dir = config.PROJECT_ROOT / "server" / "brain" / "instructions"
    
    manual_content = []
    loaded_files = []

    def _load(fname):
        fpath = instructions_dir / fname
        try:
            if fpath.exists():
                manual_content.append(fpath.read_text(encoding="utf-8"))
                loaded_files.append(fname)
        except Exception as e:
            print(f"Error reading {fname}: {e}")

    # Always load the general rules and the journal: the model can append to the
    # journal on any turn, so it must always know to use the JOURNAL command.
    _load("general.md")
    _load("journal.md")

    # Node-type and Calendar instructions are loaded only when the turn touches them.
    flags = _relevant_brain_categories(mode, user_text, assistant_text, files_read)
    for fname, should_include in [
        ("calendar.md", flags["calendar"]),
        ("people.md", flags["people"]),
        ("tasks.md", flags["tasks"]),
        ("activities.md", flags["activities"]),
        ("groups.md", flags["groups"]),
        ("assistant.md", flags["assistant"]),
        ("icons.md", flags["icons"]),
    ]:
        if should_include:
            _load(fname)

    print(f"[Brain Manager] Loaded instruction files for turn: {', '.join(loaded_files)}")
    return "\n\n---\n\n".join(manual_content)


def _read_filtered_calendar(mode: str, files_read: list) -> str:
    path = storage_brain.get_brain_dir(mode) / "Calendar.md"
    if not path.exists():
        return ""
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    header = []
    entries = []
    in_entries = False
    for line in lines:
        if "## Entries" in line:
            in_entries = True
            header.append(line)
            continue
        if not in_entries:
            header.append(line)
        else:
            if line.strip().startswith("-"):
                entries.append(line.strip())
                
    filtered = []
    for entry in entries:
        if "Calendar" in files_read:
            filtered.append(entry)
            continue
        mentions = re.findall(r'@(\w+)', entry)
        if any(m == "User" or m in files_read for m in mentions):
            filtered.append(entry)
            
    return "\n".join(header) + "\n" + "\n".join(filtered)


def _salvage_calendar_update(mode: str, model_content: str, files_read: list) -> str:
    path = storage_brain.get_brain_dir(mode) / "Calendar.md"
    if not path.exists():
        return model_content
    disk_text = path.read_text(encoding="utf-8")
    
    disk_entries = []
    in_entries = False
    for line in disk_text.splitlines():
        if "## Entries" in line:
            in_entries = True
            continue
        if in_entries and line.strip().startswith("-"):
            disk_entries.append(line.strip())
            
    shown = set()
    for entry in disk_entries:
        if "Calendar" in files_read:
            shown.add(entry)
            continue
        mentions = re.findall(r'@(\w+)', entry)
        if any(m == "User" or m in files_read for m in mentions):
            shown.add(entry)
            
    model_entries = []
    in_entries = False
    for line in model_content.splitlines():
        if "## Entries" in line:
            in_entries = True
            continue
        if in_entries and line.strip().startswith("-"):
            model_entries.append(line.strip())
            
    merged = []
    for entry in disk_entries:
        if entry not in shown:
            merged.append(entry)
            
    for entry in model_entries:
        if entry not in merged:
            merged.append(entry)
            
    lines = disk_text.splitlines()
    header = []
    for line in lines:
        header.append(line)
        if "## Entries" in line:
            break
            
    return "\n".join(header) + "\n" + "\n".join(merged)


def _do_post_processing(cid: str, msg_pos: int, mode: str, user_text: str,
                        assistant_text: str, brain_activity: dict):
    """The body of the memory-graph update.

    The brain manager model gets only the relevant instruction files, the brain map, the
    contents of the files routing deemed relevant (so updates don't lose
    existing entries), and the conversation turn; it answers with CRUD
    commands (=== CREATE/UPDATE/DELETE file.md ===) that are executed on the
    active brain folder.
    """
    if not manager.is_loaded:
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
    files_read = list(brain_activity.get("files_read", []))
    for fname in files_read + ["User", "Calendar"]:
        if fname in seen_files:
            continue
        seen_files.add(fname)
        if fname == "Calendar":
            content = _read_filtered_calendar(mode, files_read)
        else:
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
                prompt, max_tokens=3000,
                on_token=storage_brain.append_stream, phase="post-processing")
    except Exception as e:
        print(f"Post-processing generation error: {e}")
        storage_brain.log_activity("error", f"Memory update failed: {e}")
        return

    files_written, files_deleted = _execute_brain_commands(mode, response_text, files_read)
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


def _norm_journal_text(s: str) -> str:
    """Normalize a journal line for dedup: drop markdown, timestamps, case."""
    s = re.sub(r"[*_`#\[\]]", "", s or "")
    s = re.sub(r"\d{1,4}[-:]\d{2}[-:\d ]*", "", s)  # strip dates/times
    return re.sub(r"\s+", " ", s).strip().lower()


def _salvage_journal_write(mode: str, content: str) -> int:
    """The model sometimes writes the journal as a node (CREATE/UPDATE
    Journal.md) instead of using the JOURNAL command. Rather than drop it,
    append any genuinely new log lines through the proper journal path, so they
    land under today's date in the format the UI reads. Returns count appended.
    """
    jpath = storage_brain.get_brain_dir(mode) / "Journal.md"
    existing_norm = _norm_journal_text(jpath.read_text(encoding="utf-8")) if jpath.exists() else ""
    appended = 0
    for line in content.splitlines():
        m = re.match(r"^\s*[-*+]\s+(.*)$", line)  # bullet list lines only
        if not m:
            continue
        text = re.sub(r"^\s*\[[^\]]*\]\s*", "", m.group(1)).strip()  # drop a leading [timestamp]
        norm = _norm_journal_text(text)
        if len(norm) < 4 or norm in existing_norm:  # boilerplate or already recorded
            continue
        storage_brain.append_journal(mode, text)
        existing_norm += " " + norm  # also dedup repeats within this same write
        appended += 1
    return appended


def _execute_brain_commands(mode: str, response_text: str, files_read: list = None):
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
                stem_arg = _stem(arg)
                # The Journal is append-only via the JOURNAL command — never let a
                # direct overwrite clobber its history. If the model mistakenly
                # writes it as a node, salvage the new lines as proper appends.
                if stem_arg == "Journal":
                    n = _salvage_journal_write(mode, content)
                    if n:
                        if "Journal" not in files_written:
                            files_written.append("Journal")
                        storage_brain.log_activity(
                            "journal", f"Added {n} journal entr{'y' if n == 1 else 'ies'}")
                    else:
                        storage_brain.log_activity("status", "Journal already up to date.")
                    continue
                # The Calendar is filtered in the prompt, so a full overwrite would
                # delete unseen entries. Merge model updates with hidden entries.
                if stem_arg == "Calendar" and action == "UPDATE":
                    content = _salvage_calendar_update(mode, content, files_read or [])
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
        import mlx.core as mx
        for _ in range(5):
            mx.new_stream(mx.gpu)
    except ImportError:
        pass
    try:
        conv = database.get_conversation(cid)
        if not conv:
            return

        messages = conv.get("messages", [])
        if not messages:
            return

        if not manager.is_loaded:
            return

        # A title generation is a full model generation; don't pay for it every
        # turn. Run it on the first user turn (to replace the raw first-message
        # placeholder title) and then every Nth turn, where the should_rename
        # check below only renames on a clear topic shift.
        user_msg_count = sum(1 for m in messages if m.get("role") == "user")
        if user_msg_count != 1 and user_msg_count % TITLE_RECHECK_EVERY != 0:
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
            response_text = _generate_once(prompt, max_tokens=150, phase="title")

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
                    gen_kwargs, strip_thinking,
                    brain_mode, brain_writes, brain_activity, user_text,
                    memory_worthy):
    """Stream the model's reply, persist it, then start the brain update.

    When the chat template left a thinking block open, the model's first
    tokens are reasoning, so the stream is prefixed with the opening tag for
    the frontend to parse. `strip_thinking` is the hard fallback for when the
    user turned thinking off but the model reasons anyway: the reasoning is
    removed from both the stream and what's stored.
    """
    engine = manager.engine
    thinking_open, thinking_tag = engine.prompt_open_thinking(formatted)

    # Debug tap: show exactly what the chat model is fed (system prompt,
    # history, media markers) and every raw token it produces (thinking + answer).
    debug_tap.emit_prompt("chat", formatted)

    raw = ""        # everything the model produced (plus any tag we prepend)
    emitted = 0     # chars of the *visible* text already sent to the client
    if thinking_open:
        raw = thinking_tag
        yield thinking_tag
        emitted = len(raw)
        debug_tap.emit("chat", "token", thinking_tag)

    await acquire_generation_lock()
    try:
        for text in engine.stream(
            formatted, image_paths or None, audio_paths or None, **gen_kwargs,
        ):
            raw += text
            debug_tap.emit("chat", "token", text)
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
                yield text
            # If the client hit Stop (aborted the fetch), end generation now —
            # otherwise we'd keep writing to a dead socket and block the event
            # loop from serving the next message.
            if await request.is_disconnected():
                break
    finally:
        # Free this generation's transient buffers before the next one (see
        # _generate_once for why this matters when memory is tight).
        engine.clear_cache()
        generation_lock.release()
        debug_tap.emit("chat", "end")

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
    # generation through generation_lock. Skipped when the brain is paused
    # (read-only mode), so memory is never mutated, and when routing judged the
    # turn not worth remembering — that avoids a full write generation (and the
    # brain processing spinner) on casual turns.
    if brain_mode and brain_writes and _turn_is_memory_worthy(memory_worthy, clean):
        profile = config.active_profile.get()
        threading.Thread(
            target=_run_post_processing,
            args=(cid, msg_pos, brain_mode, user_text, clean, brain_activity, profile),
            daemon=True,
        ).start()
    elif brain_mode and brain_writes:
        # Surface the skip so the UI/logs show closure without spinning up the
        # write pass.
        print("[Brain] Skipping write pass — routing judged turn not memory-worthy.")
        storage_brain.log_activity("status", "Nothing worth remembering from this turn.")

    # Update the conversation title if needed in a background thread so the response isn't held open
    try:
        threading.Thread(
            target=_run_title_generation,
            args=(cid,),
            daemon=True,
        ).start()
    except Exception as e:
        print(f"Error starting title generation thread: {e}")
