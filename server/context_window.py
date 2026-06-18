"""Fits long conversations into the model's token budget.

When a conversation grows past the budget the user set with the Context Window
slider, some of it has to be left out of the prompt. Two strategies exist,
chosen by the "Smart context window" toggle in the UI:

Smart (default): keep three "bands" of the conversation and drop the gaps
between them. The bands and their budget shares (see config.py):

    head    HEAD_SHARE    the system prompt + the earliest messages
    middle  MIDDLE_SHARE  a contiguous slice around the chat's midpoint
    tail    TAIL_SHARE    the most recent messages (current turn always kept)

Simple: a plain recency cut — keep only the most recent messages that fit.

Either way, whole messages are kept or dropped (never split), and the caller
gets back the index ranges that fell out so the UI can dim those messages.
"""

from .config import HEAD_SHARE, MIDDLE_SHARE, TAIL_SHARE, PER_MESSAGE_OVERHEAD


def build_prompt(engine, messages, system_prompt,
                 image_paths, audio_paths, budget,
                 enable_thinking=None, smart=True):
    """Format the conversation for the engine, trimming it when over budget.

    Arguments:
        engine           The active inference engine (server/engines); it owns
                         chat-templating and token counting for both backends.
        messages         Full history as [{"role", "text", ...}], the current
                         user turn last.
        image_paths /    Media for the current turn (placed on the last user
        audio_paths      message by the engine's chat template).
        budget           Max prompt tokens; None or 0 disables trimming.
        enable_thinking  Forwarded to the chat template when not None
                         (toggles the reasoning phase on models that support it).
        smart            True = three-band trimming, False = recency cut.

    Returns (formatted, trimmed, out_ranges): `formatted` is the engine's opaque
    prompt object, and out_ranges is a list of [start, end) message-index ranges
    that fell out of context.
    """
    def fmt(msgs):
        return engine.format_chat(msgs, system_prompt, image_paths, audio_paths,
                                  enable_thinking)

    def prompt_tokens(prompt):
        return engine.count_prompt_tokens(prompt)

    # The common case: everything fits, nothing to do.
    formatted = fmt(messages)
    if not budget or prompt_tokens(formatted) <= budget:
        return formatted, False, []

    if not smart:
        return _recency_cut(messages, fmt, prompt_tokens, budget)

    # Per-message token cost, including the template's wrapping overhead.
    msg_tok = [engine.count_tokens(m["text"]) + PER_MESSAGE_OVERHEAD for m in messages]
    sys_tok = (engine.count_tokens(system_prompt) if system_prompt else 0) + PER_MESSAGE_OVERHEAD

    kept = [False] * len(messages)
    tail_start = _fill_tail(kept, msg_tok, TAIL_SHARE * budget)
    head_end = _fill_head(kept, msg_tok, HEAD_SHARE * budget - sys_tok, tail_start)
    _fill_middle(kept, msg_tok, MIDDLE_SHARE * budget, head_end, tail_start)

    out_ranges = _dropped_ranges(kept)
    return fmt([m for m, keep in zip(messages, kept) if keep]), True, out_ranges


def _fill_tail(kept, msg_tok, share):
    """Keep the most recent messages that fit `share`. The current turn (last
    message) is always kept, even if it alone overruns the share. Returns the
    index where the tail band starts."""
    n = len(kept)
    kept[n - 1] = True
    left = share - msg_tok[n - 1]
    tail_start = n - 1
    for i in range(n - 2, -1, -1):
        if msg_tok[i] > left:
            break
        kept[i] = True
        left -= msg_tok[i]
        tail_start = i
    return tail_start


def _fill_head(kept, msg_tok, share, tail_start):
    """Keep the earliest messages that fit `share` (the system prompt already
    counted against it). Never crosses into the tail band. Returns the index
    just past the head band."""
    left = share
    head_end = 0
    for i in range(tail_start):
        if msg_tok[i] > left:
            break
        kept[i] = True
        left -= msg_tok[i]
        head_end = i + 1
    return head_end


def _fill_middle(kept, msg_tok, share, head_end, tail_start):
    """Keep a contiguous window grown outward from the chat's midpoint,
    confined to the gap between the head and tail bands."""
    if head_end >= tail_start:
        return
    left = share
    center = min(max(len(kept) // 2, head_end), tail_start - 1)
    if msg_tok[center] > left:
        return
    kept[center] = True
    left -= msg_tok[center]
    lo, hi = center - 1, center + 1
    while True:
        grew = False
        if hi < tail_start and msg_tok[hi] <= left:
            kept[hi] = True
            left -= msg_tok[hi]
            hi += 1
            grew = True
        if lo >= head_end and msg_tok[lo] <= left:
            kept[lo] = True
            left -= msg_tok[lo]
            lo -= 1
            grew = True
        if not grew:
            return


def _dropped_ranges(kept):
    """Maximal runs of dropped messages = the gaps between the kept bands,
    as [start, end) index pairs."""
    ranges = []
    i = 0
    while i < len(kept):
        if kept[i]:
            i += 1
            continue
        j = i
        while j < len(kept) and not kept[j]:
            j += 1
        ranges.append([i, j])
        i = j
    return ranges


def _recency_cut(messages, fmt, token_count, budget):
    """Keep the largest run of most-recent whole messages that fits.

    Always keeps at least the current turn; drops everything older. Uses a
    binary search over "how many trailing messages" since fit is monotonic.
    """
    n = len(messages)

    def fits(k):
        return token_count(fmt(messages[n - k:] if k else [])) <= budget

    lo, hi = 1, n
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if fits(mid):
            lo = mid
        else:
            hi = mid - 1
    kept = lo  # always >= 1

    out_ranges = [[0, n - kept]] if kept < n else []
    return fmt(messages[n - kept:]), bool(out_ranges), out_ranges
