"""Lemma backend package.

The backend is a FastAPI server that runs local language models with MLX.
Each feature lives in its own module so changes stay localized:

    config.py          All paths and tunable constants in one place.
    schemas.py         Shapes of the JSON request bodies the API accepts.
    mlx_compat.py      Workaround for checkpoints with extra tensors.
    model_catalog.py   Finds models already downloaded to the HF cache.
    model_manager.py   Holds the loaded model(s); loading, swapping, modes.
    model_downloads.py Background downloads from Hugging Face with progress.
    system_prompt.py   Persists the default system prompt for new chats.
    context_window.py  Trims long conversations to fit the token budget.
    thinking.py        Detects and strips reasoning (<think>) tags.
    brain/             The Brain Manager's instruction manual (markdown).
    storage/           SQLite persistence (database.py), uploaded files
                       (uploads.py), and brain memory files (brain.py).
    routes/            One file per API area: chat, models, conversations,
                       files, brain, frontend.
    main.py            Assembles the FastAPI app from all of the above.

The server is started from app.py in the project root (python app.py).
"""

import os

# Silence transformers' warning chatter. This must run before transformers is
# imported anywhere, which is why it lives here: Python executes a package's
# __init__ before any of its submodules.
os.environ["TRANSFORMERS_VERBOSITY"] = "error"
