"""Lists the models already downloaded to the local Hugging Face cache.

The HF cache stores each repository as a "models--<org>--<name>" directory with
one or more snapshot folders. Two model kinds live there:

    MLX models   safetensors weights (an mlx-community repo). Loaded by the MLX
                 engine; the model ref is the repo id ("org/name").
    GGUF models  one or more .gguf files (often several quant variants in one
                 repo). Loaded by the llama.cpp engine; the model ref is the
                 absolute path to the chosen .gguf file.

Each catalog entry reports the engine format and whether that engine is
installed here (`compatible`), so the UI can flag models it can't run.
"""

from pathlib import Path

from . import config
from .engines import is_format_available

# mmproj/projector files are companions to a vision GGUF, never a model to pick.
_MMPROJ_MARKERS = ("mmproj", "mproj")


def _is_mmproj(name: str) -> bool:
    n = name.lower()
    return any(m in n for m in _MMPROJ_MARKERS)


def _repo_id_from_dir(dir_name: str) -> str:
    """'models--org--name' -> 'org/name' (name may contain '--')."""
    parts = dir_name.split("--")
    if len(parts) >= 3:
        return f"{parts[1]}/{'--'.join(parts[2:])}"
    return dir_name


def _snapshot_dirs(repo_dir: Path):
    snaps = repo_dir / "snapshots"
    if not snaps.exists():
        return []
    return [d for d in snaps.iterdir() if d.is_dir()]


def _scan_cache() -> list:
    """Walk the HF cache and build catalog entries for every usable model."""
    entries = []
    seen_ids = set()
    if not config.HF_CACHE_DIR.exists():
        return _with_default(entries, seen_ids)

    mlx_ok = is_format_available("mlx")
    llama_ok = is_format_available("llama")

    for repo_dir in config.HF_CACHE_DIR.glob("models--*"):
        if not repo_dir.is_dir():
            continue
        # A download in progress leaves .incomplete files behind.
        if any(repo_dir.rglob("*.incomplete")):
            continue
        repo_id = _repo_id_from_dir(repo_dir.name)

        has_safetensors = False
        gguf_files = {}  # filename -> resolved path (deduped across snapshots)
        for snap in _snapshot_dirs(repo_dir):
            if any(snap.glob("*.safetensors")):
                has_safetensors = True
            for g in snap.glob("*.gguf"):
                # Keep the snapshot path (a symlink ending in ".gguf"), NOT the
                # resolved blobs/ target — the engine is chosen by the ".gguf"
                # suffix, and the mmproj companion is found among its siblings.
                if not _is_mmproj(g.name) and g.name not in gguf_files:
                    gguf_files[g.name] = str(g)

        if has_safetensors:
            entries.append({
                "id": repo_id, "label": repo_id, "format": "mlx",
                "engine": "mlx", "compatible": mlx_ok,
            })
            seen_ids.add(repo_id)

        for fname, fpath in sorted(gguf_files.items()):
            entries.append({
                "id": fpath, "label": f"{repo_id}/{fname}", "format": "gguf",
                "engine": "llama", "compatible": llama_ok,
            })
            seen_ids.add(fpath)

    return _with_default(entries, seen_ids)


def _with_default(entries, seen_ids):
    """The default model is always offered so the picker shows it even on a
    fresh machine (selecting it then triggers a download)."""
    if config.DEFAULT_MODEL not in seen_ids:
        entries.append({
            "id": config.DEFAULT_MODEL, "label": config.DEFAULT_MODEL,
            "format": "mlx", "engine": "mlx", "compatible": is_format_available("mlx"),
        })
    entries.sort(key=lambda e: e["label"].lower())
    return entries


def list_downloaded_models() -> list:
    """Rich catalog entries for the API/UI:
    [{id, label, format, engine, compatible}], sorted by label."""
    return _scan_cache()


def list_downloaded_model_ids() -> list:
    """Loadable model refs for compatible engines only, used by the initial-load
    fallback in model_manager. Plain list of ids (repo ids and .gguf paths)."""
    return [e["id"] for e in _scan_cache() if e["compatible"]]


def delete_model_from_cache(model_id: str) -> bool:
    """Delete a model completely from the Hugging Face cache by wiping its repo folder.
    Returns True if a directory was found and deleted, False otherwise."""
    import shutil
    import re

    if not config.HF_CACHE_DIR.exists():
        return False

    repo_dir_name = None
    if "models--" in model_id:
        # It's an absolute path to a GGUF file. Extract the repo directory name.
        match = re.search(r'(models--[^/]+)', model_id)
        if match:
            repo_dir_name = match.group(1)
    else:
        # It's a repo id like 'mlx-community/gemma-4'. Construct the repo directory name.
        repo_dir_name = f"models--{model_id.replace('/', '--')}"

    if repo_dir_name:
        target_dir = config.HF_CACHE_DIR / repo_dir_name
        if target_dir.exists() and target_dir.is_dir():
            shutil.rmtree(target_dir, ignore_errors=True)
            return True

    return False
