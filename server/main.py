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

from . import config
from .mlx_compat import install_lenient_weight_loading
from .model_manager import manager
from .routes import chat, conversations, files, frontend, models, brain
from .storage import database, uploads
from .storage import brain as storage_brain

install_lenient_weight_loading()
manager.load_initial()

app = FastAPI(title="Lemma")

database.init_db()
uploads.ensure_uploads_dir()
storage_brain.init_brains()

# Uploaded attachments are served straight from disk: /uploads/<id>.
app.mount("/uploads", StaticFiles(directory=str(config.UPLOADS_DIR)), name="uploads")

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
