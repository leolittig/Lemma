"""Uploaded media files (images and audio), stored on disk.

Files live in the uploads/ directory, named "<uuid><ext>". An attachment's
`id` IS that filename, so a file's path is simply uploads/<id>, and the
frontend can display it at the URL /uploads/<id> (a static mount in main.py).
"""

import mimetypes
import shutil
import uuid
from pathlib import Path

from .. import config


def ensure_uploads_dir():
    config.UPLOADS_DIR.mkdir(exist_ok=True)


def save_upload(fileobj, filename: str = "", content_type: str = "") -> dict:
    """Persist an uploaded file and return its attachment record.

    The returned dict is what gets stored on messages and echoed to the
    frontend: {"id", "kind", "filename"}. `kind` is image | audio | file,
    inferred from the content type — the chat route uses it to decide which
    files to feed to the model as vision/audio input.
    """
    ensure_uploads_dir()
    ext = Path(filename or "").suffix or mimetypes.guess_extension(content_type or "") or ""
    if (content_type or "").startswith("image/"):
        kind = "image"
    elif (content_type or "").startswith("audio/"):
        kind = "audio"
    else:
        kind = "file"
    uid = uuid.uuid4().hex + ext
    dest = config.UPLOADS_DIR / uid
    with dest.open("wb") as out:
        shutil.copyfileobj(fileobj, out)
    return {"id": uid, "kind": kind, "filename": filename or uid}


def upload_path(uid: str) -> Path:
    """Absolute path of a stored upload."""
    return config.UPLOADS_DIR / uid


def delete_upload(uid):
    """Remove a stored upload; missing files and empty ids are ignored."""
    if not uid:
        return
    try:
        p = config.UPLOADS_DIR / uid
        if p.exists():
            p.unlink()
    except Exception as e:
        print(f"Error deleting upload {uid}: {e}")
