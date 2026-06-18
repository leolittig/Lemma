"""Model management endpoints: which model is active, switching, downloading.

    GET  /model              The active model and its capabilities.
    POST /model              Switch to (or reload) a model.
    GET  /models             All models available locally (with compatibility).
    GET  /models/repo_files  The downloadable files in a Hugging Face repo.
    POST /download           Start downloading a model (or one GGUF variant).
    GET  /download/status    Progress of all downloads (polled by the UI).
"""

import re

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from .. import model_downloads
from ..model_catalog import list_downloaded_models
from ..model_manager import manager, generation_lock, acquire_generation_lock
from ..schemas import DownloadActionRequest, DownloadRequest, ModelSelectRequest
from ..system_prompt import save_default_system_prompt

router = APIRouter()


def _model_payload():
    return {
        "model": manager.path,
        "supports_thinking": manager.supports_thinking(),
        "supports_vision": manager.supports_vision(),
        "supports_audio": manager.supports_audio(),
    }


@router.get("/model")
def get_active_model():
    return _model_payload()


@router.post("/model")
async def select_model(sel: ModelSelectRequest):
    if not sel.model or not sel.model.strip() or sel.model == "none":
        await acquire_generation_lock()
        try:
            manager.unload()
        finally:
            generation_lock.release()
        return _model_payload()

    # GGUF refs are absolute filesystem paths, which can be long — allow for it.
    if len(sel.model) > 1024:
        return JSONResponse(status_code=400, content={"status": "error", "message": "Model path is too long."})

    # Loading/unloading models must never overlap a running generation. The load
    # runs on the event loop (blocking briefly): MLX is thread-pinned — a model
    # loaded on one thread can only be generated from on that same thread, and
    # chat generation runs on the event loop — so the load must happen there too.
    await acquire_generation_lock()
    try:
        manager.switch_to(sel.model)
    except Exception as e:
        # switch_to already restored the previous configuration (when possible).
        return JSONResponse(status_code=400, content={"status": "error", "message": str(e)})
    finally:
        generation_lock.release()

    # Conversation state is intentionally NOT touched here — switching models
    # keeps the active chat, which is re-templated for the new model on the
    # next /chat. Persist the global default system prompt if one was sent.
    if sel.system_prompt is not None:
        save_default_system_prompt(sel.system_prompt)

    return {"status": "ok", **_model_payload()}


@router.get("/models")
def get_models():
    return {"models": list_downloaded_models()}


@router.get("/models/repo_files")
def get_repo_files(repo: str):
    """List the selectable files in a HF repo (GGUF quant variants + whether
    it's an MLX repo), for the Add Model variant picker."""
    repo_id = model_downloads.sanitize_repo_id(repo)
    if not repo_id:
        return JSONResponse(status_code=400, content={"status": "error", "message": "Repository ID is required."})
    try:
        return model_downloads.list_repo_files(repo_id)
    except Exception as e:
        return JSONResponse(status_code=404, content={"status": "error", "message": str(e)})


@router.post("/download")
def start_download(req: DownloadRequest):
    repo_id = model_downloads.sanitize_repo_id(req.model)
    if not repo_id:
        return JSONResponse(
            status_code=400,
            content={"status": "error", "message": "Model repository ID is required."})

    filename = None
    if req.filename:
        # Confine to a plain filename within the repo (no path traversal).
        filename = re.sub(r"[^a-zA-Z0-9\-._/]", "", req.filename).strip()
        if ".." in filename:
            filename = None

    status = model_downloads.start_download(repo_id, filename)
    return {"status": status, "model": repo_id, "filename": filename}


@router.get("/download/status")
def get_download_status():
    return {"downloads": model_downloads.get_statuses()}


@router.post("/download/cancel")
def cancel_download(req: DownloadActionRequest):
    """Stop a download and delete its incomplete cache directory."""
    model_downloads.cancel_download(req.key)
    return {"status": "ok"}


@router.post("/download/restart")
def restart_download(req: DownloadActionRequest):
    """Delete everything for a download and start it over from scratch."""
    return {"status": model_downloads.restart_download(req.key)}


@router.delete("/model")
async def delete_model(req: ModelSelectRequest):
    if not req.model or not req.model.strip():
        return JSONResponse(status_code=400, content={"status": "error", "message": "Model path is required."})

    await acquire_generation_lock()
    try:
        # Unload the model if it's currently active (or if it's a GGUF variant from the same repo)
        from ..model_catalog import delete_model_from_cache
        if manager.path and (req.model == manager.path or (req.model in manager.path) or (manager.path in req.model)):
            manager.unload()
            
        success = delete_model_from_cache(req.model)
        if not success:
            return JSONResponse(status_code=404, content={"status": "error", "message": "Model cache directory not found."})
            
        return {"status": "ok"}
    finally:
        generation_lock.release()
