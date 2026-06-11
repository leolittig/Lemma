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

from ..model_manager import manager
from ..storage import brain as storage_brain


router = APIRouter()


class BrainModeRequest(BaseModel):
    mode: str


class FileContentRequest(BaseModel):
    content: str


def _resolve_mode(mode: str = None) -> str:
    """Use the provided mode or fall back to the manager's active mode."""
    return mode if mode else manager.active_mode


@router.post("/api/brain/mode")
async def set_brain_mode(req: BrainModeRequest):
    valid_modes = {"everything-12b", "12b-chat-e4b-brain", "e4b-chat-12b-brain"}
    if req.mode not in valid_modes:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid mode: {req.mode}"
        )

    try:
        manager.set_mode(req.mode)
        storage_brain.init_brains()
    except Exception as e:
        return JSONResponse(
            status_code=400,
            content={"status": "error", "message": str(e)}
        )

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
        md_files = list(brain_dir.glob("*.md"))
        stems = {f.stem for f in md_files}

        nodes_data = {}
        for file_path in md_files:
            stem = file_path.stem
            try:
                content = file_path.read_text(encoding="utf-8")
                parsed = storage_brain.parse_markdown_node(content)
                nodes_data[stem] = {
                    "title": parsed.get("title", ""),
                    "description": parsed.get("description", ""),
                    "connections": parsed.get("connections", []),
                    "created": parsed.get("frontmatter", {}).get("created", ""),
                    "updated": parsed.get("frontmatter", {}).get("updated", ""),
                }
            except Exception:
                nodes_data[stem] = {
                    "title": "", "description": "", "connections": [],
                    "created": "", "updated": "",
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
            label = data["title"] if data["title"] else stem
            # Auto-detect hubs: nodes with high degree or well-known names
            is_hub = stem in ("User", "Assistant") or degrees.get(stem, 0) >= 3
            nodes.append({
                "id": stem,
                "label": label,
                "description": data["description"],
                "val": degrees[stem],
                "category": "hub" if is_hub else "leaf",
                "created": data["created"],
                "updated": data["updated"],
            })

    return {"nodes": nodes, "links": links}
