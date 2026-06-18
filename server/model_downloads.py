"""Background model downloads from Hugging Face, with progress tracking.

Two download shapes are supported:
  - a whole MLX repo (safetensors), via snapshot_download;
  - a single GGUF file chosen from a repo's quant variants, via hf_hub_download
    (its mmproj vision projector, if the repo ships one, is fetched alongside so
    image input works).

Each download runs in a daemon thread so the API stays responsive. Progress
isn't tracked continuously: get_statuses() measures the bytes on disk at the
moment the frontend polls GET /download/status, against the target's total
size. A status entry looks like:

    {"status": "downloading" | "completed" | "error",
     "progress": 0.0–100.0, "downloaded_bytes": int, "total_bytes": int,
     "error_message": str, "repo_id": str}

Downloads are keyed by repo id (MLX repo) or "<repo>/<filename>" (a GGUF file),
so two quant variants of one repo don't collide.
"""

import multiprocessing as mp
import re
import shutil

from huggingface_hub import HfApi, hf_hub_download, snapshot_download

from . import config

# Downloads run in a separate process (not a daemon thread) so a stalled
# transfer — huggingface_hub can hang for a long time on a half-open
# connection — can be force-terminated for Cancel/Restart. A thread can't be
# killed; a process can. "spawn" (not fork) keeps the child from inheriting the
# server's locks and threads.
_MP = mp.get_context("spawn")

# mmproj/projector files are a vision companion, never a standalone model.
_MMPROJ_MARKERS = ("mmproj", "mproj")

# One entry per download key. For "downloading" entries the byte counts are
# filled in at read time by get_statuses(); terminal entries (completed/error)
# persist until the user dismisses, cancels, or restarts them.
_statuses = {}

# The live download process per key, while one is running.
_procs = {}


def _is_mmproj(name: str) -> bool:
    n = name.lower()
    return any(m in n for m in _MMPROJ_MARKERS)


def sanitize_repo_id(repo_id: str) -> str:
    """Keep only characters that can appear in a Hugging Face repo id."""
    return re.sub(r"[^a-zA-Z0-9\-._/]", "", repo_id).strip()


def list_repo_files(repo_id: str) -> dict:
    """Inspect a repo and return its selectable model files:

        {repo, is_mlx, gguf: [{filename, size}], mmproj: [{filename, size}]}

    `is_mlx` means the repo has safetensors weights (an MLX/full-repo download);
    `gguf` lists the quant variants the user can pick from; `mmproj` is the
    vision projector companion (auto-paired on download), if present. `mlx_size`
    is the total bytes fetched for an MLX download (the whole snapshot, matching
    the download progress total), or 0 when not an MLX repo.
    """
    info = HfApi().model_info(repo_id, files_metadata=True)
    gguf, mmproj = [], []
    is_mlx = False
    for s in info.siblings:
        name = s.rfilename
        low = name.lower()
        if low.endswith(".safetensors"):
            is_mlx = True
        elif low.endswith(".gguf"):
            entry = {"filename": name, "size": s.size or 0}
            (mmproj if _is_mmproj(name) else gguf).append(entry)
    gguf.sort(key=lambda e: e["filename"].lower())
    mlx_size = sum(s.size for s in info.siblings if s.size) if is_mlx else 0
    return {"repo": repo_id, "is_mlx": is_mlx, "gguf": gguf, "mmproj": mmproj,
            "mlx_size": mlx_size}


def start_download(repo_id: str, filename: str = None) -> str:
    """Kick off a background download in its own process. `filename` selects one
    GGUF variant; omit it to download a whole (MLX) repo. Returns "started",
    "already_downloading", or "error" (repo/file not found)."""
    key = f"{repo_id}/{filename}" if filename else repo_id
    proc = _procs.get(key)
    if proc is not None and proc.is_alive():
        return "already_downloading"

    # Planning hits the network; doing it here (the request runs in a worker
    # thread) lets us seed the real total and report a not-found repo up front.
    total, mmproj = _plan_download(repo_id, filename)
    if total == 0:
        _statuses[key] = _status(
            "error", 0.0, 0, repo_id,
            "Repository or file not found on Hugging Face, or is private.")
        return "error"

    _statuses[key] = _status("downloading", 0.0, total, repo_id)
    proc = _MP.Process(target=_download_worker, args=(repo_id, filename, mmproj),
                       daemon=True)
    proc.start()
    _procs[key] = proc
    return "started"


def get_statuses() -> dict:
    """All download statuses, with live progress measured from disk.

    A "downloading" entry whose process has exited is resolved to its terminal
    state (completed/error) here, the next time the frontend polls."""
    result = {}
    for key, status in list(_statuses.items()):
        if status["status"] == "downloading":
            proc = _procs.get(key)
            if proc is not None and proc.is_alive():
                downloaded = _bytes_on_disk(status["repo_id"])
                total = status["total_bytes"]
                progress = min(99.9, downloaded / total * 100.0) if total else 0.0
                status = {**status, "progress": round(progress, 1),
                          "downloaded_bytes": downloaded}
            else:
                status = _resolve_terminal(status)
                _procs.pop(key, None)
            _statuses[key] = status
        result[key] = status
    return result


def _status(state: str, progress: float, total: int, repo_id: str, error: str = ""):
    downloaded = total if state == "completed" else 0
    return {
        "status": state,
        "progress": progress,
        "downloaded_bytes": downloaded,
        "total_bytes": total,
        "error_message": error,
        "repo_id": repo_id,
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
    """Bytes currently downloaded for this repo (lock files excluded).

    Only real files in blobs/ are counted: the HF cache also keeps a
    snapshots/ tree of symlinks pointing back at those same blobs, and
    `p.stat()` follows symlinks — counting both would double every finalised
    file and push reported progress past 100% (pinning it at the 99.9% cap)."""
    model_dir = _cache_dir(repo_id)
    if not model_dir.exists():
        return 0
    return sum(p.stat().st_size for p in model_dir.rglob("*")
               if p.is_file() and not p.is_symlink() and not p.name.endswith(".lock"))


def _plan_download(repo_id: str, filename: str):
    """Resolve the target total size and any mmproj companion for a download.
    Returns (total_bytes, mmproj_filename|None)."""
    if not filename:
        return _repo_total_size(repo_id), None
    try:
        files = list_repo_files(repo_id)
    except Exception as e:
        print(f"Error fetching repo files for {repo_id}: {e}")
        return 0, None
    total = next((g["size"] for g in files["gguf"] + files["mmproj"]
                  if g["filename"] == filename), 0)
    mmproj = files["mmproj"][0]["filename"] if files["mmproj"] else None
    if mmproj:
        total += next((m["size"] for m in files["mmproj"] if m["filename"] == mmproj), 0)
    return total, mmproj


def _download_worker(repo_id: str, filename: str, mmproj: str):
    """Runs in a child process: fetch the target. The parent reads success or
    failure back from the process exit and the files on disk (_resolve_terminal),
    so a hung transfer can be force-terminated by Cancel/Restart."""
    if filename:
        hf_hub_download(repo_id, filename)
        if mmproj:  # pair the vision projector so image input works
            hf_hub_download(repo_id, mmproj)
    else:
        snapshot_download(repo_id)


def _resolve_terminal(status: dict) -> dict:
    """Map a finished/terminated download process to completed or error, judged
    by the files on disk: no half-written *.incomplete files means it's done."""
    repo_id = status["repo_id"]
    total = status["total_bytes"]
    model_dir = _cache_dir(repo_id)
    if model_dir.exists() and not any(model_dir.rglob("*.incomplete")):
        return _status("completed", 100.0, total, repo_id)
    return _status("error", 0.0, total, repo_id,
                   "Download was interrupted before it finished.")


def _delete_repo_cache(repo_id: str):
    """Remove a repo's cache directory (its partial/finished files) and the HF
    lock directory that shadows it."""
    model_dir = _cache_dir(repo_id)
    shutil.rmtree(model_dir, ignore_errors=True)
    shutil.rmtree(config.HF_CACHE_DIR / ".locks" / model_dir.name, ignore_errors=True)


def _stop_process(key: str):
    """Force-terminate the download process for `key`, if one is running."""
    proc = _procs.pop(key, None)
    if proc is not None and proc.is_alive():
        proc.terminate()
        proc.join(timeout=5)


def cancel_download(key: str) -> bool:
    """Stop the download and delete its (incomplete) cache directory."""
    _stop_process(key)
    status = _statuses.pop(key, None)
    if status:
        _delete_repo_cache(status["repo_id"])
    return True


def restart_download(key: str) -> str:
    """Delete everything for this download and start it over from scratch."""
    status = _statuses.get(key)
    if not status:
        return "error"
    repo_id = status["repo_id"]
    filename = (key[len(repo_id) + 1:]
                if key != repo_id and key.startswith(repo_id + "/") else None)
    cancel_download(key)
    return start_download(repo_id, filename)
