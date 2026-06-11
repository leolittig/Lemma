"""Lists the models already downloaded to the local Hugging Face cache.

The HF cache stores each repository as a "models--<org>--<name>" directory.
A model counts as available only when its download actually finished: it must
have a non-empty snapshot and no leftover .incomplete files.
"""

from . import config


def list_downloaded_models() -> list:
    """Return sorted repo ids ("org/name") of fully downloaded models.

    The default model is always included so the picker offers it even on a
    fresh machine (selecting it then triggers a download by Hugging Face).
    """
    models = []
    if config.HF_CACHE_DIR.exists():
        for path in config.HF_CACHE_DIR.glob("models--*"):
            if not path.is_dir():
                continue
            # A repo without snapshots was never fully downloaded.
            snapshots_dir = path / "snapshots"
            if not snapshots_dir.exists() or not any(snapshots_dir.iterdir()):
                continue
            # .incomplete files mean a download is unfinished or was aborted.
            if any(path.rglob("*.incomplete")):
                continue

            # Directory name format: models--<org>--<name> (name may itself
            # contain "--", so only the first two separators are structural).
            parts = path.name.split("--")
            if len(parts) >= 3:
                org = parts[1]
                name = "--".join(parts[2:])
                models.append(f"{org}/{name}")

    if config.DEFAULT_MODEL not in models:
        models.append(config.DEFAULT_MODEL)
    return sorted(models)
