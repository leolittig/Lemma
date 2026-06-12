"""Shapes of the JSON request bodies the API accepts (Pydantic models).

Field names here are the API contract with the frontend (src/api/client.js),
so renaming a field means changing both sides.
"""

from typing import Optional, List, Dict, Any

from pydantic import BaseModel


class ChatRequest(BaseModel):
    """Body of POST /chat — one user turn plus its generation settings."""

    conversation_id: str
    text: str = ""
    # Attachments uploaded via /upload for THIS turn: [{id, kind, filename}].
    attachments: List[Dict[str, Any]] = []
    # Per-message generation params from the settings panel. All optional so
    # older clients (and the server-side defaults) keep working unchanged.
    temperature: Optional[float] = None
    # Context window in tokens; also caps the KV cache during generation.
    max_kv_size: Optional[int] = None
    # Toggle the model's reasoning phase. None = use the model's default;
    # True/False set the chat template's `enable_thinking` (Qwen3 etc.).
    # Ignored by models whose template doesn't read it.
    enable_thinking: Optional[bool] = None
    # Maximum length of the model's generated response (0 or less = unlimited).
    max_tokens: Optional[int] = None
    # Smart context window: when True (default) an over-budget conversation is
    # split into head/middle/tail bands; when False it's a plain recency cut
    # that keeps only the most recent messages that fit.
    smart_context: Optional[bool] = True
    enable_brain: Optional[bool] = True


class ModelSelectRequest(BaseModel):
    """Body of POST /model — switch to (or reload) a model."""

    model: str
    # When sent, also persisted as the global default system prompt.
    system_prompt: Optional[str] = None


class DownloadRequest(BaseModel):
    """Body of POST /download — a Hugging Face repo id to fetch."""

    model: str


class ConversationCreateRequest(BaseModel):
    """Body of POST /conversations. Unset fields fall back to server defaults."""

    title: Optional[str] = None
    model: Optional[str] = None
    system_prompt: Optional[str] = None


class ConversationPatchRequest(BaseModel):
    """Body of PATCH /conversations/{id} — only the provided fields change."""

    title: Optional[str] = None
    system_prompt: Optional[str] = None
