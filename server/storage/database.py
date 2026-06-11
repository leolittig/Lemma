"""Conversations and messages, stored in SQLite (chats.db).

Schema:
    conversations  one row per chat: title, model, system prompt, timestamps,
                   and display metadata about context trimming.
    messages       one row per message, ordered by `position` within its
                   conversation. Attachment references are stored as JSON.

Deleting a conversation cascades to its messages, and both deletion paths also
remove the attachment files those messages referenced (via storage.uploads).
"""

import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone

from .. import config
from . import uploads


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def _connect():
    """Short-lived connection; commits on clean exit, always closes."""
    conn = sqlite3.connect(config.DB_FILE, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    """Create the tables if they don't exist yet. Called once at startup."""
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS conversations (
                id            TEXT PRIMARY KEY,
                title         TEXT,
                model         TEXT,
                system_prompt TEXT,
                created_at    TEXT,
                updated_at    TEXT,
                -- JSON list of [start, end) message-index ranges that fell into the
                -- gaps between the kept context bands on the last turn, so the UI can
                -- persist the dim across reloads. NULL when the turn fit untrimmed.
                context_out_ranges TEXT
            )
            """
        )
        # Backfill the context column for databases created before it existed.
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(conversations)").fetchall()}
        if "context_out_ranges" not in cols:
            conn.execute("ALTER TABLE conversations ADD COLUMN context_out_ranges TEXT")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS messages (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id TEXT,
                role            TEXT,
                text            TEXT,
                attachments     TEXT,   -- JSON: [{id, kind, filename}]
                position        INTEGER,
                created_at      TEXT,
                FOREIGN KEY (conversation_id)
                    REFERENCES conversations (id) ON DELETE CASCADE
            )
            """
        )


def create_conversation(title=None, model=None, system_prompt="") -> str:
    """Insert a new conversation and return its id."""
    cid = uuid.uuid4().hex
    now = _now()
    with _connect() as conn:
        conn.execute(
            "INSERT INTO conversations (id, title, model, system_prompt, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (cid, title, model, system_prompt or "", now, now),
        )
    return cid


def list_conversations() -> list:
    """All conversations (without messages), most recently updated first."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, title, model, updated_at FROM conversations ORDER BY updated_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def get_conversation(cid: str):
    """Full conversation incl. ordered messages, or None if it doesn't exist."""
    with _connect() as conn:
        conv = conn.execute("SELECT * FROM conversations WHERE id = ?", (cid,)).fetchone()
        if conv is None:
            return None
        msgs = conn.execute(
            "SELECT role, text, attachments FROM messages"
            " WHERE conversation_id = ? ORDER BY position ASC",
            (cid,),
        ).fetchall()
    result = dict(conv)
    result["messages"] = [
        {
            "role": m["role"],
            "text": m["text"],
            "attachments": json.loads(m["attachments"] or "[]"),
        }
        for m in msgs
    ]
    return result


def update_conversation(cid: str, **fields):
    """Update title/system_prompt/model; bumps updated_at."""
    fields = {k: v for k, v in fields.items() if k in ("title", "system_prompt", "model")}
    if not fields:
        return
    cols = ", ".join(f"{k} = ?" for k in fields)
    vals = list(fields.values()) + [_now(), cid]
    with _connect() as conn:
        conn.execute(f"UPDATE conversations SET {cols}, updated_at = ? WHERE id = ?", vals)


def set_context_window(cid: str, out_ranges_json):
    """Persist the JSON list of out-of-context message ranges from the last turn,
    or None when nothing fell out. Pure display metadata — deliberately does not
    bump updated_at, so it never reorders the conversation list."""
    with _connect() as conn:
        conn.execute(
            "UPDATE conversations SET context_out_ranges = ? WHERE id = ?",
            (out_ranges_json, cid),
        )


def delete_conversation(cid: str):
    """Delete the conversation (cascades to messages) and its uploaded files."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT attachments FROM messages WHERE conversation_id = ?", (cid,)
        ).fetchall()
        for r in rows:
            for att in json.loads(r["attachments"] or "[]"):
                uploads.delete_upload(att.get("id"))
        conn.execute("DELETE FROM conversations WHERE id = ?", (cid,))


def add_message(cid: str, role: str, text: str, attachments=None) -> int:
    """Append a message; returns its 0-based position. Bumps conversation.updated_at."""
    now = _now()
    with _connect() as conn:
        pos = conn.execute(
            "SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM messages WHERE conversation_id = ?",
            (cid,),
        ).fetchone()["pos"]
        conn.execute(
            "INSERT INTO messages (conversation_id, role, text, attachments, position, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (cid, role, text, json.dumps(attachments or []), pos, now),
        )
        conn.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (now, cid))
    return pos


def clear_messages(cid: str):
    """Delete every message in the conversation, plus their uploaded files."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT attachments FROM messages WHERE conversation_id = ?", (cid,)
        ).fetchall()
        for r in rows:
            for att in json.loads(r["attachments"] or "[]"):
                uploads.delete_upload(att.get("id"))
        conn.execute("DELETE FROM messages WHERE conversation_id = ?", (cid,))
