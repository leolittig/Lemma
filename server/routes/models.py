"""Model management endpoints: which model is active, switching, downloading.

    GET  /model            The active model and whether it supports thinking.
    POST /model            Switch to (or reload) a model.
    GET  /models           All models available locally.
    POST /download         Start downloading a model from Hugging Face.
    GET  /download/status  Progress of all downloads (polled by the UI).
"""

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from .. import model_downloads
from ..model_catalog import list_downloaded_models
from ..model_manager import manager
from ..schemas import DownloadRequest, ModelSelectRequest
from ..system_prompt import save_default_system_prompt

router = APIRouter()


@router.get("/model")
def get_active_model():
    return {"model": manager.path, "supports_thinking": manager.supports_thinking()}


@router.post("/model")
async def select_model(sel: ModelSelectRequest):
    if not sel.model or not sel.model.strip():
        return JSONResponse(status_code=400, content={"status": "error", "message": "Model path cannot be empty."})

    if len(sel.model) > 255:
        return JSONResponse(status_code=400, content={"status": "error", "message": "Model path is too long."})

    try:
        manager.switch_to(sel.model)
    except Exception as e:
        # switch_to already restored the previous model (when possible).
        return JSONResponse(status_code=400, content={"status": "error", "message": str(e)})

    # Conversation state is intentionally NOT touched here — switching models
    # keeps the active chat, which is re-templated for the new model on the
    # next /chat. Persist the global default system prompt if one was sent.
    if sel.system_prompt is not None:
        save_default_system_prompt(sel.system_prompt)

    return {"status": "ok", "model": sel.model, "supports_thinking": manager.supports_thinking()}


@router.get("/models")
def get_models():
    return {"models": list_downloaded_models()}


@router.post("/download")
def start_download(req: DownloadRequest):
    repo_id = model_downloads.sanitize_repo_id(req.model)
    if not repo_id:
        return JSONResponse(
            status_code=400,
            content={"status": "error", "message": "Model repository ID is required."})

    status = model_downloads.start_download(repo_id)
    return {"status": status, "model": repo_id}


@router.get("/download/status")
def get_download_status():
    return {"downloads": model_downloads.get_statuses()}
