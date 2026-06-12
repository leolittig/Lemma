"""Entry point for the Lemma backend.

Run with:  python app.py   (or via `npm run dev`, which starts this together
with the Vite frontend dev server).

All the actual logic lives in the server/ package — see server/__init__.py
for a map of its modules. This file only starts the web server.
"""

import uvicorn

from server import config
from server.main import app

if __name__ == "__main__":
    uvicorn.run(app, host=config.SERVER_HOST, port=config.SERVER_PORT)
