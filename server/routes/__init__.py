"""API routes, one module per area.

    chat.py           POST /chat — generate a streamed model reply.
    models.py         Model selection (/model, /models) and downloads (/download).
    conversations.py  CRUD for the conversation history (/conversations).
    brain.py          Brain memory graph and file CRUD (/api/brain/*).
    files.py          File uploads (/upload).
    frontend.py       Serving the built frontend (GET /).

Each module exposes a `router` that main.py includes into the app. To add a
new endpoint, pick the module whose area it belongs to (or create a new module
following the same pattern and include its router in main.py).
"""
