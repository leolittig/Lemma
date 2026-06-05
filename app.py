import os
os.environ["TRANSFORMERS_VERBOSITY"] = "error"

import uvicorn
from fastapi import FastAPI
from fastapi.responses import HTMLResponse, StreamingResponse, JSONResponse
from pydantic import BaseModel
from pathlib import Path
from typing import Optional
import threading
import gc
import mlx.core as mx
from huggingface_hub import HfApi, snapshot_download

from mlx_vlm import load
from mlx_vlm.generate import stream_generate
from mlx_vlm.prompt_utils import apply_chat_template


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

def get_initial_history():
    if SYSTEM_PROMPT_FILE.exists():
        try:
            sys_prompt = SYSTEM_PROMPT_FILE.read_text(encoding="utf-8").strip()
            if sys_prompt:
                return [{"role": "system", "content": sys_prompt}]
        except Exception as e:
            print(f"Error loading system prompt: {e}")
    return []

# Initialize with the last available model or default
available_models = list_cached_models()
current_model_path = available_models[-1] if available_models else "mlx-community/gemma-4-e4b-it-4bit"

print(f"Loading initial model: {current_model_path}")
model, processor = load(current_model_path)
history = get_initial_history()
app = FastAPI()

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
    text: str

class RestartConfig(BaseModel):
    system_prompt: str = ""

class ModelSelect(BaseModel):
    model: str
    system_prompt: Optional[str] = None

class DownloadRequest(BaseModel):
    model: str

@app.get("/model")
def get_model():
    global current_model_path
    return {"model": current_model_path}

@app.post("/model")
async def select_model(sel: ModelSelect):
    global model, processor, current_model_path, history
    try:
        print(f"Unloading current model: {current_model_path}")
        model = None
        processor = None
        gc.collect()
        mx.clear_cache()

        print(f"Loading new model: {sel.model}")
        model, processor = load(sel.model)
        current_model_path = sel.model
        # Apply the system prompt from settings (if the client sent one) so the
        # new model always receives it; then reset chat history with it applied.
        if sel.system_prompt is not None:
            save_system_prompt(sel.system_prompt)
        history = get_initial_history()
        return {"status": "ok", "model": sel.model}
    except Exception as e:
        print(f"Error loading model {sel.model}: {e}")
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


@app.post("/chat")
async def chat(msg: Msg):
    history.append({"role": "user", "content": [{"type": "text", "text": msg.text}]})
    formatted = apply_chat_template(processor, model.config, history, num_images=0)

    async def generate():
        reply = ""
        for chunk in stream_generate(model, processor, formatted, image=None, max_tokens=2048, temperature=1.0):
            reply += chunk.text
            yield chunk.text
        history.append({"role": "assistant", "content": [{"type": "text", "text": reply.replace("<end_of_utterance>", "").strip()}]})

    return StreamingResponse(generate(), media_type="text/plain")

@app.post("/restart")
def restart_chat(config: RestartConfig):
    global history
    save_system_prompt(config.system_prompt)
    history = get_initial_history()
    return {"status": "ok"}


if os.path.exists("dist/assets"):
    from fastapi.staticfiles import StaticFiles
    app.mount("/assets", StaticFiles(directory="dist/assets"), name="assets")

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)

