"""Central configuration: every path and tunable constant the backend uses.

If you need to change where data is stored, which model loads by default, or
how aggressively long conversations are trimmed, this is the file to edit.
"""

from pathlib import Path
from contextvars import ContextVar

# The project root is the directory containing app.py (one level above this
# package). Anchoring paths here means the server finds its data regardless of
# the directory it was launched from.
PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Thread-safe, async-safe contextvar to hold the active profile name
active_profile: ContextVar[str] = ContextVar("active_profile", default="default")

def get_db_file() -> Path:
    p = active_profile.get()
    if p == "default":
        return PROJECT_ROOT / "chats.db"
    return PROJECT_ROOT / "profiles" / p / "chats.db"

def get_brain_root() -> Path:
    p = active_profile.get()
    if p == "default":
        return PROJECT_ROOT / "brain"
    return PROJECT_ROOT / "profiles" / p / "brain"

def get_uploads_dir() -> Path:
    p = active_profile.get()
    if p == "default":
        return PROJECT_ROOT / "uploads"
    return PROJECT_ROOT / "profiles" / p / "uploads"

def get_system_prompt_file() -> Path:
    p = active_profile.get()
    if p == "default":
        return PROJECT_ROOT / "system_prompt.txt"
    return PROJECT_ROOT / "profiles" / p / "system_prompt.txt"

class DynamicBrainModesDict(dict):
    def __getitem__(self, key):
        if key != "active":
            raise KeyError(key)
        return get_brain_root() / "active"

    def __contains__(self, key):
        return key == "active"

    def keys(self):
        return ["active"]

    def values(self):
        return [self["active"]]

    def items(self):
        return [("active", self["active"])]

    def get(self, key, default=None):
        if key == "active":
            return self["active"]
        return default

# The main directory holding all memory graph variations (compatibility root)
BRAIN_ROOT = PROJECT_ROOT / "brain"

# The main directory holding all memory graph files (dynamic dict)
BRAIN_MODES = DynamicBrainModesDict()

# Module-level __getattr__ for PEP 562 dynamic variables
def __getattr__(name: str):
    if name == "DB_FILE":
        return get_db_file()
    elif name == "UPLOADS_DIR":
        return get_uploads_dir()
    elif name == "SYSTEM_PROMPT_FILE":
        return get_system_prompt_file()
    raise AttributeError(f"module '{__name__}' has no attribute '{name}'")

# Hugging Face stores downloaded models here; we scan it to list local models.
HF_CACHE_DIR = Path.home() / ".cache" / "huggingface" / "hub"

# Always offered in the model picker, even before it has been downloaded.
DEFAULT_MODEL = "mlx-community/gemma-4-12B-it-8bit"

# Used as the load target only when no model exists in the cache at all.
FALLBACK_MODEL = "mlx-community/gemma-4-e4b-it-4bit"

# Generation defaults, used when the client doesn't send a value.
DEFAULT_TEMPERATURE = 1.0
DEFAULT_MAX_TOKENS = 2048

# Context-window trimming (see context_window.py for how these are applied).
# RESPONSE_HEADROOM: fraction of the window the prompt may use; the rest is
# reserved for the model's reply.
RESPONSE_HEADROOM = 0.75
# When trimming, the conversation is kept in three "bands" and the gaps between
# them are dropped. These are each band's share of the prompt budget.
HEAD_SHARE = 0.30    # the system prompt + the start of the chat
MIDDLE_SHARE = 0.10  # a slice from the middle of the chat
TAIL_SHARE = 0.60    # the most recent messages
# Rough number of tokens the chat template adds around each message.
PER_MESSAGE_OVERHEAD = 8

# Network address the backend listens on.
SERVER_HOST = "127.0.0.1"
SERVER_PORT = 8000
