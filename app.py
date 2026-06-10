import os
os.environ["TRANSFORMERS_VERBOSITY"] = "error"
import json

import uvicorn
from fastapi import FastAPI, UploadFile, File, Request
from fastapi.responses import HTMLResponse, StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from pathlib import Path
from typing import Optional, List, Dict, Any
import threading
import gc
import mlx.core as mx
import mlx.nn as _nn
from huggingface_hub import HfApi, snapshot_download

from mlx_vlm import load
from mlx_vlm.generate import stream_generate
from mlx_vlm.prompt_utils import apply_chat_template

# mlx_vlm loads mlx-format checkpoints with a *strict* weight load and (for that
# format) skips its sanitize pass, so any tensors the model class doesn't define
# abort the load — e.g. a Qwen3 MTP speculative-decoding head, or KV-sharing
# projections in Gemma 3n. Those extras aren't needed for generation, so wrap
# load_weights to retry non-strict (ignoring just the unknown tensors) instead
# of failing outright. Strict behaviour is unchanged when there are no extras.
_orig_load_weights = _nn.Module.load_weights


def _lenient_load_weights(self, file_or_weights, strict=True):
    try:
        return _orig_load_weights(self, file_or_weights, strict=strict)
    except ValueError as e:
        if strict and "not in model" in str(e):
            print(f"Note: this checkpoint has tensors the architecture doesn't use; "
                  f"loading without them.\n{e}")
            return _orig_load_weights(self, file_or_weights, strict=False)
        raise


_nn.Module.load_weights = _lenient_load_weights

import db


# Find available models in Hugging Face hub cache (fully downloaded only)
def list_cached_models():
    cache_dir = Path.home() / ".cache" / "huggingface" / "hub"
    models = []
    if cache_dir.exists():
        for path in cache_dir.glob("models--*"):
            if path.is_dir():
                # Verify snapshots directory is not empty
                snapshots_dir = path / "snapshots"
                if not snapshots_dir.exists() or not any(snapshots_dir.iterdir()):
                    continue
                # Exclude if there are any .incomplete download files
                if any(path.rglob("*.incomplete")):
                    continue
                
                parts = path.name.split("--")
                if len(parts) >= 3:
                    org = parts[1]
                    name = "--".join(parts[2:])
                    models.append(f"{org}/{name}")
    current_default = "mlx-community/gemma-4-12B-it-8bit"
    if current_default not in models:
        models.append(current_default)
    return sorted(models)

SYSTEM_PROMPT_FILE = Path("system_prompt.txt")

def save_system_prompt(sys_prompt: str):
    """Persist the system prompt to disk (or remove it when empty)."""
    if sys_prompt:
        try:
            SYSTEM_PROMPT_FILE.write_text(sys_prompt, encoding="utf-8")
        except Exception as e:
            print(f"Error saving system prompt: {e}")
    elif SYSTEM_PROMPT_FILE.exists():
        try:
            SYSTEM_PROMPT_FILE.unlink()
        except Exception as e:
            print(f"Error removing system prompt file: {e}")

def load_default_system_prompt() -> str:
    """The global default system prompt that seeds new conversations."""
    if SYSTEM_PROMPT_FILE.exists():
        try:
            return SYSTEM_PROMPT_FILE.read_text(encoding="utf-8").strip()
        except Exception as e:
            print(f"Error loading system prompt: {e}")
    return ""

# Initialize with the last available model or default
available_models = list_cached_models()
current_model_path = available_models[-1] if available_models else "mlx-community/gemma-4-e4b-it-4bit"


def _try_load(path):
    """Load (model, processor) for `path`, or (None, None) if it can't be loaded.

    A checkpoint whose architecture the installed mlx_vlm/mlx_lm doesn't match
    (e.g. extra weights for KV-sharing or MTP layers) raises on the strict
    weight load. We catch it so one bad model can't stop the server starting."""
    try:
        print(f"Loading model: {path}")
        m, p = load(path)
        if m is not None and not hasattr(m, "language_model"):
            raise ValueError(f"The model '{path}' lacks a language model wrapper (e.g., it is a speculative draft model or has an unsupported architecture). Please select a full VLM or supported model.")
        return m, p
    except Exception as e:
        print(f"Failed to load {path}: {e}")
        return None, None


# Try the preferred model, then fall back through the other cached models so an
# incompatible default doesn't crash the whole process (which would leave the
# UI with no backend at all). The server still starts even if none load.
model, processor = _try_load(current_model_path)
if model is None:
    for candidate in reversed(available_models):
        if candidate == current_model_path:
            continue
        model, processor = _try_load(candidate)
        if model is not None:
            current_model_path = candidate
            break

if model is None:
    print("WARNING: no model could be loaded — starting without one. "
          "Pick a compatible model from the UI to begin chatting.")

app = FastAPI()
db.init_db()
app.mount("/uploads", StaticFiles(directory=str(db.UPLOADS_DIR)), name="uploads")

download_status = {}

def get_repo_total_size(repo_id: str) -> int:
    try:
        api = HfApi()
        info = api.model_info(repo_id, files_metadata=True)
        total_size = sum(sibling.size for sibling in info.siblings if sibling.size is not None)
        return total_size
    except Exception as e:
        print(f"Error fetching model info for {repo_id}: {e}")
        return 0

def download_model_task(repo_id: str):
    global download_status
    try:
        total_bytes = get_repo_total_size(repo_id)
        if total_bytes == 0:
            download_status[repo_id] = {
                "status": "error",
                "progress": 0.0,
                "downloaded_bytes": 0,
                "total_bytes": 0,
                "error_message": "Repository not found on Hugging Face or is private."
            }
            return

        download_status[repo_id] = {
            "status": "downloading",
            "progress": 0.0,
            "downloaded_bytes": 0,
            "total_bytes": total_bytes,
            "error_message": ""
        }

        # Form target directory path
        parts = repo_id.split("/")
        if len(parts) == 2:
            folder_name = f"models--{parts[0]}--{parts[1]}"
        else:
            folder_name = f"models--{repo_id}"
        model_dir = Path.home() / ".cache" / "huggingface" / "hub" / folder_name

        outcome = {"success": False, "error": None}
        
        def run_download():
            try:
                snapshot_download(repo_id)
                outcome["success"] = True
            except Exception as ex:
                outcome["error"] = ex

        download_thread = threading.Thread(target=run_download)
        download_thread.start()

        import time
        while download_thread.is_alive():
            time.sleep(0.5)
            # Calculate current size of files in model_dir
            current_bytes = 0
            if model_dir.exists():
                for p in model_dir.rglob("*"):
                    if p.is_file() and not p.name.endswith(".lock"):
                        current_bytes += p.stat().st_size
            
            progress = min(99.9, (current_bytes / total_bytes) * 100.0) if total_bytes > 0 else 0.0
            download_status[repo_id] = {
                "status": "downloading",
                "progress": round(progress, 1),
                "downloaded_bytes": current_bytes,
                "total_bytes": total_bytes,
                "error_message": ""
            }

        download_thread.join()

        if outcome["success"]:
            if model_dir.exists() and not any(model_dir.rglob("*.incomplete")):
                download_status[repo_id] = {
                    "status": "completed",
                    "progress": 100.0,
                    "downloaded_bytes": total_bytes,
                    "total_bytes": total_bytes,
                    "error_message": ""
                }
            else:
                download_status[repo_id] = {
                    "status": "error",
                    "progress": 0.0,
                    "downloaded_bytes": 0,
                    "total_bytes": total_bytes,
                    "error_message": "Files downloaded but snapshot validation failed."
                }
        else:
            err_msg = str(outcome["error"]) if outcome["error"] else "Unknown error during download."
            download_status[repo_id] = {
                "status": "error",
                "progress": 0.0,
                "downloaded_bytes": 0,
                "total_bytes": total_bytes,
                "error_message": err_msg
            }

    except Exception as e:
        print(f"Error in download task for {repo_id}: {e}")
        download_status[repo_id] = {
            "status": "error",
            "progress": 0.0,
            "downloaded_bytes": 0,
            "total_bytes": 0,
            "error_message": str(e)
        }

class Msg(BaseModel):
    conversation_id: str
    text: str = ""
    # Attachments uploaded via /upload for THIS turn: [{id, kind, filename}].
    attachments: List[Dict[str, Any]] = []
    # Per-message generation params from the settings panel. Both optional so
    # older clients (and the defaults below) keep working unchanged.
    temperature: Optional[float] = None
    max_kv_size: Optional[int] = None  # context window; doubles as compression budget
    # Toggle the model's reasoning phase. None = use the model's default; True/False
    # set the chat template's `enable_thinking` (Qwen3 etc.). Ignored by models
    # whose template doesn't read it.
    enable_thinking: Optional[bool] = None
    max_tokens: Optional[int] = None  # maximum length of the model's generated response
    # Smart context window: when True (default) the over-budget conversation is
    # split into head/middle/tail bands; when False it's a plain recency cut that
    # keeps only the most recent messages that fit.
    smart_context: Optional[bool] = True

class RestartConfig(BaseModel):
    # Repurposed: persist the global default system prompt (seeds new chats).
    system_prompt: str = ""

class ModelSelect(BaseModel):
    model: str
    system_prompt: Optional[str] = None

class DownloadRequest(BaseModel):
    model: str

class ConversationCreate(BaseModel):
    title: Optional[str] = None
    model: Optional[str] = None
    system_prompt: Optional[str] = None

class ConversationPatch(BaseModel):
    title: Optional[str] = None
    system_prompt: Optional[str] = None

def check_supports_thinking(proc, model_name: str) -> bool:
    if proc is None:
        return False
    
    # Primary check: Inspect the chat template programmatically
    template = getattr(proc, "chat_template", None)
    if not template and hasattr(proc, "tokenizer"):
        template = getattr(proc.tokenizer, "chat_template", None)
        
    if isinstance(template, str):
        # Check if the template contains any indicators of reasoning/thinking support
        if "enable_thinking" in template or "<think>" in template or "<|channel>thought" in template:
            return True
            
    # Secondary check: Fallback to model name heuristics
    name = model_name.lower()
    if "gemma-4" in name or any(x in name for x in ["r1", "reasoning", "thinking", "optiq", "math"]):
        return True
        
    return False

@app.get("/model")
def get_model():
    global current_model_path, model, processor
    supports_thinking = check_supports_thinking(processor, current_model_path)
    return {"model": current_model_path, "supports_thinking": supports_thinking}

@app.post("/model")
async def select_model(sel: ModelSelect):
    global model, processor, current_model_path

    # Free the current model first so the new one has room to load (local
    # inference is memory-bound and holding two at once can OOM).
    print(f"Unloading current model: {current_model_path}")
    prev_path = current_model_path
    model = None
    processor = None
    gc.collect()
    mx.clear_cache()

    try:
        print(f"Loading new model: {sel.model}")
        m, p = load(sel.model)
        if m is not None and not hasattr(m, "language_model"):
            raise ValueError(f"The model '{sel.model}' lacks a language model wrapper (e.g., it is a speculative draft model or has an unsupported architecture). Please load a full VLM or supported model.")
        model = m
        processor = p
        current_model_path = sel.model
        # Conversation state is intentionally NOT touched here — switching models
        # keeps the active chat, which is re-templated for the new model on the
        # next /chat. Persist the global default system prompt if one was sent.
        if sel.system_prompt is not None:
            save_system_prompt(sel.system_prompt)
            
        supports_thinking = check_supports_thinking(processor, current_model_path)
        return {"status": "ok", "model": sel.model, "supports_thinking": supports_thinking}
    except Exception as e:
        print(f"Error loading model {sel.model}: {e}")
        # The new model failed — restore the previous one so the app stays usable.
        try:
            m, p = load(prev_path)
            if m is not None and not hasattr(m, "language_model"):
                raise ValueError("Restored model lacks language model attribute")
            model = m
            processor = p
            current_model_path = prev_path
            print(f"Restored previous model: {prev_path}")
        except Exception as restore_err:
            print(f"Could not restore previous model {prev_path}: {restore_err}")
            model = None
            processor = None
        return JSONResponse(status_code=400, content={"status": "error", "message": str(e)})

@app.get("/models")
def get_models():
    return {"models": list_cached_models()}

import re

def sanitize_repo_id(repo_id: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9\-._/]", "", repo_id)
    return cleaned.strip()

@app.post("/download")
def start_download(req: DownloadRequest):
    global download_status
    repo_id = sanitize_repo_id(req.model)
    if not repo_id:
        return JSONResponse(status_code=400, content={"status": "error", "message": "Model repository ID is required."})
        
    status = download_status.get(repo_id)
    if status and status["status"] == "downloading":
        return {"status": "already_downloading", "model": repo_id}
        
    thread = threading.Thread(target=download_model_task, args=(repo_id,))
    thread.daemon = True
    thread.start()
    
    return {"status": "started", "model": repo_id}

@app.get("/download/status")
def get_download_status():
    global download_status
    return {"downloads": download_status}


@app.get("/", response_class=HTMLResponse)
def index():
    if os.path.exists("dist/index.html"):
        return open("dist/index.html").read()
    return """
    <html>
        <body style="font-family: sans-serif; padding: 2rem; text-align: center; max-width: 600px; margin: 0 auto; line-height: 1.6;">
            <h2>Frontend not built yet</h2>
            <p>To run the app, you can either:</p>
            <ul style="text-align: left; display: inline-block;">
                <li>Build the production files: <code>npm run build</code>, then refresh this page.</li>
                <li>Or run the Vite development server: <code>npm run dev</code> and open the printed URL (usually <a href="http://localhost:5173">http://localhost:5173</a>).</li>
            </ul>
        </body>
    </html>
    """


# ── Context window (three bands) ──────────────────────────────────────────────
# When the prompt exceeds the budget we split it into three bands by token share
# and drop the gaps between them: the system prompt + the start of the chat, a
# slice from the middle, and the most recent messages. Each band is filled with
# whole messages up to its share; messages in the gaps fall out of context.
RESPONSE_HEADROOM = 0.75  # fraction of the window reserved for the prompt
HEAD_SHARE = 0.30         # budget share for the system prompt + start of the chat
MIDDLE_SHARE = 0.10       # budget share for a slice from the middle of the chat
TAIL_SHARE = 0.60         # budget share for the most recent messages
PER_MSG_OVERHEAD = 8      # tokens the chat template adds wrapping each message


def _token_count(text: str) -> int:
    tok = processor.tokenizer if hasattr(processor, "tokenizer") else processor
    return len(tok.encode(text))


def _strip_think(text):
    """Remove a <think>…</think> or <|channel>thought…<channel|> block from `text`, returning just the answer.
    Used as a hard fallback when the user disabled thinking but the model emits
    reasoning anyway. Handles the still-open case (no end tag yet) by dropping
    everything from the opening tag on."""
    # Qwen-style
    open_i = text.find("<think>")
    if open_i != -1:
        close_i = text.find("</think>", open_i)
        if close_i == -1:
            return text[:open_i]
        text = text[:open_i] + text[close_i + len("</think>"):]

    # Gemma4-style
    open_g = text.find("<|channel>thought")
    if open_g != -1:
        close_g = text.find("<channel|>", open_g)
        if close_g == -1:
            return text[:open_g]
        text = text[:open_g] + text[close_g + len("<channel|>"):]

    return text


def build_prompt(messages, system_prompt, num_images, num_audios, budget, enable_thinking=None, smart=True):
    """Format the conversation for the model. When it exceeds `budget` tokens and
    `smart` is True, keep three bands and drop the gaps between them:
      - HEAD_SHARE of the budget: system prompt + the earliest messages.
      - MIDDLE_SHARE: a contiguous slice grown out from the middle of the chat.
      - TAIL_SHARE: the most recent messages (the current turn is always kept).
    Each band is filled with whole messages up to its share. When `smart` is
    False it's a plain recency cut: keep only the most recent messages that fit,
    dropping the older ones. budget=None or 0 disables trimming.

    Returns (formatted_str, trimmed, out_ranges) where out_ranges is a list of
    [start, end) message-index ranges that fell out of context. `enable_thinking`
    (when not None) is forwarded to the chat template."""
    extra = {} if enable_thinking is None else {"enable_thinking": enable_thinking}

    def assemble(msgs):
        seq = []
        if system_prompt:
            seq.append({"role": "system", "content": system_prompt})
        for m in msgs:
            seq.append({"role": m["role"], "content": m["text"]})
        return seq

    def fmt(msgs):
        return apply_chat_template(
            processor, model.config, assemble(msgs),
            num_images=num_images, num_audios=num_audios,
            **extra,
        )

    formatted = fmt(messages)
    if not budget or _token_count(formatted) <= budget:
        return formatted, False, []

    n = len(messages)
    tok = processor.tokenizer if hasattr(processor, "tokenizer") else processor

    if not smart:
        # Plain recency cut: keep the largest run of most-recent whole messages
        # that fits (always at least the current turn); drop everything older.
        def fits(k):
            return _token_count(fmt(messages[n - k:] if k else [])) <= budget
        lo, hi = 1, n
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if fits(mid):
                lo = mid
            else:
                hi = mid - 1
        kept = lo  # >= 1
        out_ranges = [[0, n - kept]] if kept < n else []
        return fmt(messages[n - kept:]), bool(out_ranges), out_ranges
    msg_tok = [len(tok.encode(m["text"])) + PER_MSG_OVERHEAD for m in messages]
    sys_tok = (len(tok.encode(system_prompt)) if system_prompt else 0) + PER_MSG_OVERHEAD

    kept = [False] * n

    # Tail band: the most recent messages. The current turn (last message) is
    # always kept, even if it alone overruns the tail's share.
    left = TAIL_SHARE * budget
    kept[n - 1] = True
    left -= msg_tok[n - 1]
    tail_start = n - 1
    i = n - 2
    while i >= 0 and msg_tok[i] <= left:
        kept[i] = True
        left -= msg_tok[i]
        tail_start = i
        i -= 1

    # Head band: system prompt + the earliest messages (the system prompt counts
    # against this share). Never crosses into the tail band.
    left = HEAD_SHARE * budget - sys_tok
    head_end = 0
    i = 0
    while i < tail_start and msg_tok[i] <= left:
        kept[i] = True
        left -= msg_tok[i]
        head_end = i + 1
        i += 1

    # Middle band: a contiguous window grown outward from the chat's midpoint,
    # confined to the gap between the head and tail bands.
    if head_end < tail_start:
        left = MIDDLE_SHARE * budget
        center = min(max(n // 2, head_end), tail_start - 1)
        if msg_tok[center] <= left:
            kept[center] = True
            left -= msg_tok[center]
            lo, hi = center - 1, center + 1
            while True:
                grew = False
                if hi < tail_start and msg_tok[hi] <= left:
                    kept[hi] = True; left -= msg_tok[hi]; hi += 1; grew = True
                if lo >= head_end and msg_tok[lo] <= left:
                    kept[lo] = True; left -= msg_tok[lo]; lo -= 1; grew = True
                if not grew:
                    break

    # Maximal runs of dropped messages = the gaps between the kept bands.
    out_ranges = []
    i = 0
    while i < n:
        if kept[i]:
            i += 1
            continue
        j = i
        while j < n and not kept[j]:
            j += 1
        out_ranges.append([i, j])
        i = j

    formatted = fmt([messages[i] for i in range(n) if kept[i]])
    return formatted, True, out_ranges


@app.post("/chat")
async def chat(msg: Msg, request: Request):
    if model is None:
        return JSONResponse(status_code=503, content={"status": "error", "message": "No model is loaded. Select a compatible model first."})

    conv = db.get_conversation(msg.conversation_id)
    if conv is None:
        return JSONResponse(status_code=404, content={"status": "error", "message": "Conversation not found"})

    attachments = msg.attachments or []
    # Persist the user message immediately (with its attachment refs).
    db.add_message(msg.conversation_id, "user", msg.text, attachments)

    # Auto-title from the first user message; always record the producing model.
    updates = {"model": current_model_path}
    if not (conv.get("title") or "").strip():
        first_line = (msg.text or "").strip().splitlines()
        updates["title"] = (first_line[0][:60] if first_line else "") or "New chat"
    db.update_conversation(msg.conversation_id, **updates)

    # Full message list for generation: prior messages + this new user turn.
    history_msgs = conv["messages"] + [{"role": "user", "text": msg.text, "attachments": attachments}]
    system_prompt = conv.get("system_prompt") or ""

    # Only THIS turn's media is fed to the model — apply_chat_template places
    # media tokens in the last user message, so prior-turn media isn't re-sent.
    image_paths = [str(db.upload_path(a["id"])) for a in attachments if a.get("kind") == "image"]
    audio_paths = [str(db.upload_path(a["id"])) for a in attachments if a.get("kind") == "audio"]

    # Compression budget tied to the Context Window slider (headroom left for the
    # reply). Unlimited (no/<=0 value) disables trimming.
    budget = None
    if msg.max_kv_size and msg.max_kv_size > 0:
        budget = max(128, int(msg.max_kv_size * RESPONSE_HEADROOM))

    formatted, trimmed, out_ranges = build_prompt(
        history_msgs, system_prompt, len(image_paths), len(audio_paths), budget,
        enable_thinking=msg.enable_thinking,
        smart=msg.smart_context is not False,
    )

    max_tok = msg.max_tokens if msg.max_tokens is not None else 2048
    if max_tok <= 0:
        max_tok = 1000000  # Effectively unlimited
    gen_kwargs = {
        "max_tokens": max_tok,
        "temperature": msg.temperature if msg.temperature is not None else 1.0,
    }
    if msg.max_kv_size and msg.max_kv_size > 0:
        gen_kwargs["max_kv_size"] = msg.max_kv_size

    cid = msg.conversation_id

    # Detect whether thinking is active/open in the prompt.
    # Qwen template check
    qwen_thinking_open = formatted.rfind("<think>") > formatted.rfind("</think>")
    # Gemma4 template check
    gemma_thinking_open = formatted.rfind("<|channel>thought") > formatted.rfind("<channel|>")
    
    thinking_open = qwen_thinking_open or gemma_thinking_open
    thinking_token = "<think>" if qwen_thinking_open else "<|channel>thought"

    # Hard fallback: if the user turned thinking off but the model reasons anyway,
    # strip the <think>…</think> or <|channel>thought…<channel|> from both the stream and what we store.
    strip_thinking = msg.enable_thinking is False
    
    # Hold back trailing chars while filtering so we don't prematurely leak a split tag.
    TAG_TAIL = max(len("</think>"), len("<channel|>"))

    async def generate():
        raw = ""        # everything the model produced (plus any tag we prepend)
        emitted = 0     # chars of the *visible* text already sent to the client
        if thinking_open:
            raw += thinking_token
            yield thinking_token
            emitted = len(raw)
        for chunk in stream_generate(
            model, processor, formatted,
            image=image_paths or None,
            audio=audio_paths or None,
            **gen_kwargs,
        ):
            raw += chunk.text
            if strip_thinking:
                # Emit the cleaned answer incrementally, holding back the last few
                # chars so a tag split across chunks ("</thi" | "nk>") is never
                # leaked before it's recognised.
                visible = _strip_think(raw)
                safe_len = max(emitted, len(visible) - TAG_TAIL)
                if safe_len > emitted:
                    yield visible[emitted:safe_len]
                    emitted = safe_len
            else:
                yield chunk.text
            # If the client hit Stop (aborted the fetch), end generation now —
            # otherwise we'd keep writing to a dead socket (socket.send spam) and
            # block the event loop from serving the next message.
            if await request.is_disconnected():
                break
        # Flush any held-back tail and settle the stored text.
        if strip_thinking:
            visible = _strip_think(raw)
            if len(visible) > emitted:
                yield visible[emitted:]
            final_text = visible
        else:
            final_text = raw
        clean = final_text.replace("<end_of_utterance>", "").strip()
        db.add_message(cid, "assistant", clean, [])

    # Tell the UI which message ranges fell into the gaps between the kept bands.
    # Persist it on the conversation too, so the dim survives reloads; clear it
    # (None) when the turn fit without trimming.
    headers = {}
    if trimmed and out_ranges:
        ranges_json = json.dumps(out_ranges)
        headers["X-Context-Trimmed"] = "1"
        headers["X-Context-Out-Ranges"] = ranges_json
        db.set_context_window(cid, ranges_json)
    else:
        db.set_context_window(cid, None)
    return StreamingResponse(generate(), media_type="text/plain", headers=headers)


# ── Conversations ─────────────────────────────────────────────────────────────

@app.get("/conversations")
def get_conversations():
    return {"conversations": db.list_conversations()}


@app.post("/conversations")
def create_conversation_ep(cfg: ConversationCreate):
    sysp = cfg.system_prompt if cfg.system_prompt is not None else load_default_system_prompt()
    cid = db.create_conversation(
        title=cfg.title, model=cfg.model or current_model_path, system_prompt=sysp
    )
    return {"id": cid}


@app.get("/conversations/{cid}")
def get_conversation_ep(cid: str):
    conv = db.get_conversation(cid)
    if conv is None:
        return JSONResponse(status_code=404, content={"status": "error", "message": "Not found"})
    return conv


@app.patch("/conversations/{cid}")
def patch_conversation_ep(cid: str, patch: ConversationPatch):
    fields = {k: v for k, v in patch.model_dump(exclude_unset=True).items() if v is not None}
    db.update_conversation(cid, **fields)
    return {"status": "ok"}


@app.delete("/conversations/{cid}")
def delete_conversation_ep(cid: str):
    db.delete_conversation(cid)
    return {"status": "ok"}


@app.post("/conversations/{cid}/clear")
def clear_conversation_ep(cid: str):
    # Empty the conversation in place: drop its messages and reset the title to
    # blank so the next message re-titles it. Used to "delete" the only chat
    # without removing the tile.
    db.clear_messages(cid)
    db.update_conversation(cid, title="")
    return {"status": "ok"}


@app.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    return db.save_upload(file.file, file.filename or "", file.content_type or "")


@app.post("/restart")
def restart_chat(config: RestartConfig):
    # Persist the global default system prompt that seeds new conversations.
    save_system_prompt(config.system_prompt)
    return {"status": "ok"}


if os.path.exists("dist/assets"):
    from fastapi.staticfiles import StaticFiles
    app.mount("/assets", StaticFiles(directory="dist/assets"), name="assets")

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)

