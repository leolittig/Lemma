"""Helpers for reasoning ("thinking") models.

Some models emit an internal reasoning phase before their final answer,
wrapped in special tags. Two tag styles are supported:

    Qwen style:    <think> ... </think>
    Gemma 4 style: <|channel>thought ... <channel|>

The frontend renders the reasoning in a collapsible block. These helpers cover
the two server-side needs: knowing whether the prompt template left a thinking
block open (so the stream can be prefixed with the opening tag), and stripping
reasoning out entirely when the user turned thinking off but the model
reasons anyway.
"""

QWEN_OPEN = "<think>"
QWEN_CLOSE = "</think>"
GEMMA_OPEN = "<|channel>thought"
GEMMA_CLOSE = "<channel|>"

# When stripping tags from a live stream, hold back this many trailing
# characters so a tag split across two chunks ("</thi" | "nk>") is never
# leaked before it's recognised.
TAG_HOLDBACK = max(len(QWEN_CLOSE), len(GEMMA_CLOSE))


def find_open_thinking(formatted_prompt: str):
    """Detect whether the chat template ended the prompt inside a thinking block.

    When it did, the model's very first streamed tokens are reasoning, so the
    server prepends the opening tag to the stream for the frontend to parse.
    Returns (is_open, opening_tag).
    """
    qwen_open = formatted_prompt.rfind(QWEN_OPEN) > formatted_prompt.rfind(QWEN_CLOSE)
    gemma_open = formatted_prompt.rfind(GEMMA_OPEN) > formatted_prompt.rfind(GEMMA_CLOSE)
    opening_tag = QWEN_OPEN if qwen_open else GEMMA_OPEN
    return qwen_open or gemma_open, opening_tag


def strip_thinking(text: str) -> str:
    """Remove a thinking block from `text`, returning just the answer.

    Used as a hard fallback when the user disabled thinking but the model
    emits reasoning anyway. Handles the still-open case (no end tag yet) by
    dropping everything from the opening tag on.
    """
    # Qwen style.
    open_i = text.find(QWEN_OPEN)
    if open_i != -1:
        close_i = text.find(QWEN_CLOSE, open_i)
        if close_i == -1:
            return text[:open_i]
        text = text[:open_i] + text[close_i + len(QWEN_CLOSE):]

    # Gemma 4 style.
    open_g = text.find(GEMMA_OPEN)
    if open_g != -1:
        close_g = text.find(GEMMA_CLOSE, open_g)
        if close_g == -1:
            return text[:open_g]
        text = text[:open_g] + text[close_g + len(GEMMA_CLOSE):]

    return text
