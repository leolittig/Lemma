"""Conversation history endpoints (the sidebar's data).

    GET    /conversations            List all conversations (newest first).
    POST   /conversations            Create a conversation.
    GET    /conversations/{id}       One conversation with all its messages.
    PATCH  /conversations/{id}       Rename / edit its system prompt.
    DELETE /conversations/{id}       Delete it (messages and uploads included).
    POST   /conversations/{id}/clear Empty it in place, keeping the tile.
"""

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ..model_manager import manager
from ..schemas import ConversationCreateRequest, ConversationPatchRequest
from ..storage import database
from ..system_prompt import load_default_system_prompt

router = APIRouter()


@router.get("/conversations")
def list_conversations():
    return {"conversations": database.list_conversations()}


@router.post("/conversations")
def create_conversation(cfg: ConversationCreateRequest):
    # Check if there is an existing empty conversation first
    empty_cid = database.get_empty_conversation()
    sysp = cfg.system_prompt if cfg.system_prompt is not None else load_default_system_prompt()
    model_path = cfg.model or manager.path

    if empty_cid:
        database.update_conversation(
            empty_cid,
            title=cfg.title,
            model=model_path,
            system_prompt=sysp
        )
        return {"id": empty_cid}

    # Otherwise, create a new one
    cid = database.create_conversation(
        title=cfg.title, model=model_path, system_prompt=sysp
    )
    return {"id": cid}


@router.get("/conversations/{cid}")
def get_conversation(cid: str):
    conv = database.get_conversation(cid)
    if conv is None:
        return JSONResponse(status_code=404, content={"status": "error", "message": "Not found"})
    return conv


@router.patch("/conversations/{cid}")
def patch_conversation(cid: str, patch: ConversationPatchRequest):
    fields = {k: v for k, v in patch.model_dump(exclude_unset=True).items() if v is not None}
    database.update_conversation(cid, **fields)
    return {"status": "ok"}


@router.delete("/conversations/{cid}")
def delete_conversation(cid: str):
    database.delete_conversation(cid)
    return {"status": "ok"}


@router.post("/conversations/{cid}/clear")
def clear_conversation(cid: str):
    # Empty the conversation in place: drop its messages and reset the title to
    # blank so the next message re-titles it. Used to "delete" the only chat
    # without removing the tile.
    database.clear_messages(cid)
    database.update_conversation(cid, title="")
    return {"status": "ok"}
