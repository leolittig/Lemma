"""Persistence layer for Lemma.

Three modules, kept free of any mlx / FastAPI imports so they can be unit-tested
in isolation and reused without pulling in the (heavy) model stack:

    database.py  Conversations and messages, stored in SQLite (chats.db).
    uploads.py   Uploaded media files, stored on disk (uploads/).
    brain.py     Isolated brain directories and markdown nodes.
"""
