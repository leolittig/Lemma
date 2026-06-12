"""POST /upload — receive an attachment for the message being composed.

The file is stored by storage.uploads and the returned record ({id, kind,
filename}) is what the frontend later includes in its /chat request. The
stored files themselves are served back at /uploads/<id> via a static mount
in main.py.
"""

from fastapi import APIRouter, File, UploadFile

from ..storage import uploads

router = APIRouter()


@router.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    return uploads.save_upload(file.file, file.filename or "", file.content_type or "")
