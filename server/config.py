"""Central configuration: every path and tunable constant the backend uses.

If you need to change where data is stored, which model loads by default, or
how aggressively long conversations are trimmed, this is the file to edit.
"""

from pathlib import Path

# The project root is the directory containing app.py (one level above this
# package). Anchoring paths here means the server finds its data regardless of
# the directory it was launched from.
PROJECT_ROOT = Path(__file__).resolve().parent.parent

# The main directory holding all memory graph variations.
BRAIN_ROOT = PROJECT_ROOT / "brain"

# The main directory holding all memory graph files.
BRAIN_MODES = {
    "active": BRAIN_ROOT / "active",
}

# Where conversations and messages are stored (SQLite).
DB_FILE = PROJECT_ROOT / "chats.db"

# Where uploaded images/audio files are saved. Served back at /uploads/<id>.
UPLOADS_DIR = PROJECT_ROOT / "uploads"

# The global default system prompt (the "Instructions" field in Settings) is
# persisted to this file. Deleted when the prompt is cleared.
SYSTEM_PROMPT_FILE = PROJECT_ROOT / "system_prompt.txt"

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
