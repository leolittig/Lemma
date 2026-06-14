"""Assembles the FastAPI application.

Everything happens in a fixed order:
  1. Install the MLX weight-loading workaround (must precede any model load).
  2. Load the initial model. This blocks until the model is in memory, so the
     server never answers requests in a half-ready state. (If no cached model
     loads, the server still starts and the UI prompts for a model.)
  3. Create the app, initialise storage, and wire up every route module.

To add a new API area: create a module in routes/ exposing a `router`, then
include it below.
"""

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager

from . import config
from .mlx_compat import install_lenient_weight_loading
from .model_manager import manager
from .routes import chat, conversations, files, frontend, models, brain
from .storage import database, uploads
from .storage import brain as storage_brain

import re
from fastapi import Request, HTTPException
from fastapi.responses import FileResponse

install_lenient_weight_loading()

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Load initial model on server startup
    manager.load_initial()
    yield
    # Unload model on shutdown
    manager.unload()

app = FastAPI(title="Lemma", lifespan=lifespan)

database.init_db()
uploads.ensure_uploads_dir()
storage_brain.init_brains()

# Keep track of initialized profiles to avoid double initialization checks
_initialized_profiles = {"default"}

@app.middleware("http")
async def active_profile_middleware(request: Request, call_next):
    profile = request.headers.get("X-Profile", "default")
    profile = re.sub(r"[^a-zA-Z0-9_\-]", "", profile)
    if not profile:
        profile = "default"

    token = config.active_profile.set(profile)

    if profile not in _initialized_profiles:
        # Bootstrap folders/db dynamically on first request to this profile
        db_file = config.get_db_file()
        db_file.parent.mkdir(parents=True, exist_ok=True)
        database.init_db()
        uploads.ensure_uploads_dir()
        storage_brain.init_brains()
        _initialized_profiles.add(profile)

    try:
        response = await call_next(request)
        return response
    finally:
        config.active_profile.reset(token)

# Serve uploaded attachments dynamically from the active profile's uploads directory
@app.get("/uploads/{uid}")
async def serve_upload(uid: str):
    p = config.UPLOADS_DIR / uid
    if not p.exists() or not p.is_file():
        raise HTTPException(status_code=404, detail="Upload not found")
    return FileResponse(p)

app.include_router(chat.router)
app.include_router(models.router)
app.include_router(conversations.router)
app.include_router(files.router)
app.include_router(frontend.router)
app.include_router(brain.router)

# In production mode (after npm run build) the compiled frontend assets are
# served by this server; in development Vite serves them instead.
_dist_assets = config.PROJECT_ROOT / "dist" / "assets"
if _dist_assets.exists():
    app.mount("/assets", StaticFiles(directory=str(_dist_assets)), name="assets")
