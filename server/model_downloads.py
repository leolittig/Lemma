"""Background model downloads from Hugging Face, with progress tracking.

Each download runs in a daemon thread so the API stays responsive. Progress
isn't tracked continuously: get_statuses() measures the bytes on disk at the
moment the frontend polls GET /download/status, and compares them with the
repository's total size. A status entry looks like:

    {"status": "downloading" | "completed" | "error",
     "progress": 0.0–100.0,
     "downloaded_bytes": int, "total_bytes": int, "error_message": str}
"""

import re
import threading

from huggingface_hub import HfApi, snapshot_download

from . import config

# One entry per repo id. For "downloading" entries the byte counts are filled
# in at read time by get_statuses().
_statuses = {}


def sanitize_repo_id(repo_id: str) -> str:
    """Keep only characters that can appear in a Hugging Face repo id."""
    return re.sub(r"[^a-zA-Z0-9\-._/]", "", repo_id).strip()


def start_download(repo_id: str) -> str:
    """Kick off a background download. Returns "started" or "already_downloading"."""
    current = _statuses.get(repo_id)
    if current and current["status"] == "downloading":
        return "already_downloading"

    threading.Thread(target=_download, args=(repo_id,), daemon=True).start()
    return "started"


def get_statuses() -> dict:
    """All download statuses, with live progress measured from disk."""
    result = {}
    for repo_id, status in _statuses.items():
        if status["status"] == "downloading":
            downloaded = _bytes_on_disk(repo_id)
            total = status["total_bytes"]
            progress = min(99.9, downloaded / total * 100.0) if total else 0.0
            status = {**status, "progress": round(progress, 1), "downloaded_bytes": downloaded}
        result[repo_id] = status
    return result


def _status(state: str, progress: float, total: int, error: str = ""):
    downloaded = total if state == "completed" else 0
    return {
        "status": state,
        "progress": progress,
        "downloaded_bytes": downloaded,
        "total_bytes": total,
        "error_message": error,
    }


def _repo_total_size(repo_id: str) -> int:
    """Total size in bytes of all files in the repo, or 0 if it can't be read."""
    try:
        info = HfApi().model_info(repo_id, files_metadata=True)
        return sum(s.size for s in info.siblings if s.size is not None)
    except Exception as e:
        print(f"Error fetching model info for {repo_id}: {e}")
        return 0


def _cache_dir(repo_id: str):
    """The directory the HF cache uses for this repo."""
    return config.HF_CACHE_DIR / f"models--{repo_id.replace('/', '--')}"


def _bytes_on_disk(repo_id: str) -> int:
    """Bytes currently downloaded for this repo (lock files excluded)."""
    model_dir = _cache_dir(repo_id)
    if not model_dir.exists():
        return 0
    return sum(p.stat().st_size for p in model_dir.rglob("*")
               if p.is_file() and not p.name.endswith(".lock"))


def _download(repo_id: str):
    """Worker: download the repo and record the outcome in _statuses."""
    total = _repo_total_size(repo_id)
    if total == 0:
        _statuses[repo_id] = _status(
            "error", 0.0, 0, "Repository not found on Hugging Face or is private.")
        return

    _statuses[repo_id] = _status("downloading", 0.0, total)
    try:
        snapshot_download(repo_id)
    except Exception as e:
        _statuses[repo_id] = _status("error", 0.0, total, str(e))
        return

    # Double-check there are no half-written files before reporting done.
    model_dir = _cache_dir(repo_id)
    if model_dir.exists() and not any(model_dir.rglob("*.incomplete")):
        _statuses[repo_id] = _status("completed", 100.0, total)
    else:
        _statuses[repo_id] = _status(
            "error", 0.0, total, "Files downloaded but snapshot validation failed.")
