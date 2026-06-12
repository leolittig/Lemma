"""Brain graph API endpoints: graph retrieval, file CRUD, mode switching.

    GET  /api/brain/graph          The full node-link graph for the active mode.
    GET  /api/brain/file           Read a file's content.
    POST /api/brain/file           Create or update a file.
    DELETE /api/brain/file         Delete a file.
    POST /api/brain/mode           Switch to a different brain mode.
"""

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from ..model_manager import manager, generation_lock, acquire_generation_lock
from ..storage import brain as storage_brain


router = APIRouter()


class BrainModeRequest(BaseModel):
    mode: str


class FileContentRequest(BaseModel):
    content: str


class RenameFileRequest(BaseModel):
    old_filename: str
    new_filename: str


class BrainInitRequest(BaseModel):
    name: str


def _resolve_mode(mode: str = None) -> str:
    """Use the provided mode or fall back to the manager's active mode."""
    return mode if mode else manager.active_mode


def _parse_tags(raw) -> list:
    """Parse a frontmatter tags value ('[a, b]' or 'a, b') into a list."""
    if isinstance(raw, list):
        return [str(t).strip() for t in raw if str(t).strip()]
    s = str(raw or "").strip().strip("[]")
    return [t.strip().strip("'\"") for t in s.split(",") if t.strip()]


@router.post("/api/brain/mode")
async def set_brain_mode(req: BrainModeRequest):
    valid_modes = {"active"}
    if req.mode not in valid_modes:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid mode: {req.mode}"
        )

    # Switching modes loads/unloads models, which must never overlap a
    # running generation.
    await acquire_generation_lock()
    try:
        manager.set_mode(req.mode)
        storage_brain.init_brains()
    except Exception as e:
        return JSONResponse(
            status_code=400,
            content={"status": "error", "message": str(e)}
        )
    finally:
        generation_lock.release()

    return {"status": "ok", "mode": req.mode, "active_models": list(manager._models.keys())}


@router.post("/api/brain/file")
async def save_file(
    req: FileContentRequest,
    mode: str = Query(default=None),
    filename: str = Query(...),
):
    resolved_mode = _resolve_mode(mode)
    try:
        storage_brain.save_markdown_node(resolved_mode, filename, req.content)
        return {"status": "ok"}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/api/brain/file")
async def get_file(
    filename: str = Query(...),
    mode: str = Query(default=None),
):
    resolved_mode = _resolve_mode(mode)
    try:
        brain_dir = storage_brain.get_brain_dir(resolved_mode).resolve()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    if "/" in filename or "\\" in filename:
        raise HTTPException(status_code=400, detail="Subdirectories are not allowed in filename.")

    if not filename.endswith(".md"):
        filename += ".md"

    target_path = (brain_dir / filename).resolve()
    if not target_path.is_relative_to(brain_dir):
        raise HTTPException(status_code=400, detail="Directory traversal attempt detected.")

    if not target_path.exists() or not target_path.is_file():
        raise HTTPException(status_code=404, detail=f"File {filename} not found.")

    try:
        content = target_path.read_text(encoding="utf-8")
        return {"content": content}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/api/brain/file")
async def delete_file(
    filename: str = Query(...),
    mode: str = Query(default=None),
):
    resolved_mode = _resolve_mode(mode)
    try:
        brain_dir = storage_brain.get_brain_dir(resolved_mode).resolve()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    if "/" in filename or "\\" in filename:
        raise HTTPException(status_code=400, detail="Subdirectories are not allowed in filename.")

    if not filename.endswith(".md"):
        filename += ".md"

    target_path = (brain_dir / filename).resolve()
    if not target_path.is_relative_to(brain_dir):
        raise HTTPException(status_code=400, detail="Directory traversal attempt detected.")

    if not target_path.exists() or not target_path.is_file():
        raise HTTPException(status_code=404, detail=f"File {filename} not found.")

    try:
        target_path.unlink()
        return {"status": "ok"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/brain/activity")
async def get_activity():
    """Live feed of the background memory update: the in-flight flag, recent
    discrete log lines, and the model's current generation text."""
    return storage_brain.get_activity()


@router.get("/api/brain/status")
async def get_status(mode: str = Query(default=None)):
    """Whether the brain has been set up (root named) and the user's name."""
    resolved_mode = _resolve_mode(mode)
    return {
        "initialized": storage_brain.is_initialized(resolved_mode),
        "user_name": storage_brain.get_user_name(resolved_mode),
    }


@router.post("/api/brain/init")
async def init_brain(req: BrainInitRequest, mode: str = Query(default=None)):
    """Create the single root node named after the user (first-boot prompt)."""
    resolved_mode = _resolve_mode(mode)
    try:
        storage_brain.init_root(resolved_mode, req.name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"status": "ok", "user_name": storage_brain.get_user_name(resolved_mode)}


@router.get("/api/brain/calendar")
async def get_calendar(mode: str = Query(default=None)):
    """The Calendar entity parsed into a chronological list of dated entries."""
    return {"events": storage_brain.parse_calendar(_resolve_mode(mode))}


@router.get("/api/brain/journal")
async def get_journal(mode: str = Query(default=None)):
    """The Journal entity parsed into day sections (newest first)."""
    return {"days": storage_brain.parse_journal(_resolve_mode(mode))}


@router.get("/api/brain/node_refs")
async def get_node_refs(filename: str = Query(...), mode: str = Query(default=None)):
    """Where the off-grid entities reference this node (via @mentions)."""
    stem = filename[:-3] if filename.endswith(".md") else filename
    if "/" in stem or "\\" in stem:
        raise HTTPException(status_code=400, detail="Invalid node name.")
    return storage_brain.node_refs(_resolve_mode(mode), stem)


@router.get("/api/brain/graph")
async def get_graph(mode: str = Query(default=None)):
    resolved_mode = _resolve_mode(mode)
    try:
        brain_dir = storage_brain.get_brain_dir(resolved_mode).resolve()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    nodes = []
    links = []
    if brain_dir.exists() and brain_dir.is_dir():
        # Off-grid entities (Assistant/Calendar/Journal) are real files but are
        # NOT graph nodes — exclude them and any edge that touches them.
        md_files = [f for f in brain_dir.glob("*.md")
                    if f.stem not in storage_brain.OFF_GRID_FILES]
        stems = {f.stem for f in md_files}

        event_counts = storage_brain.calendar_mention_counts(resolved_mode)

        nodes_data = {}
        for file_path in md_files:
            stem = file_path.stem
            try:
                parsed = storage_brain.parse_markdown_node(file_path.read_text(encoding="utf-8"))
                fm = parsed.get("frontmatter", {})
                nodes_data[stem] = {
                    "title": parsed.get("title", ""),
                    "description": parsed.get("description", ""),
                    "connections": parsed.get("connections", []),
                    "created": fm.get("created", ""),
                    "updated": fm.get("updated", ""),
                    "type": fm.get("type", "leaf"),
                    "status": fm.get("status", ""),
                    "tags": _parse_tags(fm.get("tags", "")),
                    "relationship": fm.get("relationship", ""),
                }
            except Exception:
                nodes_data[stem] = {
                    "title": "", "description": "", "connections": [],
                    "created": "", "updated": "", "type": "leaf",
                    "status": "", "tags": [], "relationship": "",
                }

        degrees = {stem: 0 for stem in stems}
        for source, data in nodes_data.items():
            for target in data["connections"]:
                if target in stems:
                    links.append({"source": source, "target": target})
                    degrees[source] += 1
                    degrees[target] += 1

        for stem in stems:
            data = nodes_data[stem]
            nodes.append({
                "id": stem,
                "label": data["title"] or stem,
                "description": data["description"],
                "val": degrees[stem],
                "type": data["type"],
                "status": data["status"],
                "tags": data["tags"],
                "relationship": data["relationship"],
                "created": data["created"],
                "updated": data["updated"],
                "event_count": event_counts.get(stem, 0),
            })

    return {"nodes": nodes, "links": links, "processing": storage_brain.is_processing()}


@router.post("/api/brain/rename")
async def rename_file(
    req: RenameFileRequest,
    mode: str = Query(default=None),
):
    resolved_mode = _resolve_mode(mode)
    try:
        storage_brain.rename_markdown_node(resolved_mode, req.old_filename, req.new_filename)
        return {"status": "ok"}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/brain/reset")
async def reset_brain(
    mode: str = Query(default=None),
):
    resolved_mode = _resolve_mode(mode)
    try:
        storage_brain.reset_brain(resolved_mode)
        return {"status": "ok"}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
