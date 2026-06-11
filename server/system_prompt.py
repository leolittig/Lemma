"""Persistence for the global default system prompt.

This is the "Instructions" text from the Settings panel. It seeds every newly
created conversation (each conversation then keeps its own copy in the
database). Stored as a plain text file so it survives restarts.
"""

from . import config


def save_default_system_prompt(text: str):
    """Write the prompt to disk, or remove the file when the prompt is empty."""
    if text:
        try:
            config.SYSTEM_PROMPT_FILE.write_text(text, encoding="utf-8")
        except Exception as e:
            print(f"Error saving system prompt: {e}")
    elif config.SYSTEM_PROMPT_FILE.exists():
        try:
            config.SYSTEM_PROMPT_FILE.unlink()
        except Exception as e:
            print(f"Error removing system prompt file: {e}")


def load_default_system_prompt() -> str:
    """Read the saved prompt, or return an empty string when none is set."""
    if config.SYSTEM_PROMPT_FILE.exists():
        try:
            return config.SYSTEM_PROMPT_FILE.read_text(encoding="utf-8").strip()
        except Exception as e:
            print(f"Error loading system prompt: {e}")
    return ""
