"""Compatibility shim for model checkpoints with extra, unused tensors.

mlx_vlm loads mlx-format checkpoints with a *strict* weight load and (for that
format) skips its sanitize pass, so any tensors the model class doesn't define
abort the load — e.g. a Qwen3 MTP speculative-decoding head, or KV-sharing
projections in Gemma 3n. Those extras aren't needed for generation, so we wrap
load_weights to retry non-strict (ignoring just the unknown tensors) instead
of failing outright. Strict behaviour is unchanged when there are no extras.
"""

import mlx.nn as nn

_original_load_weights = nn.Module.load_weights
_installed = False


def _lenient_load_weights(self, file_or_weights, strict=True):
    try:
        return _original_load_weights(self, file_or_weights, strict=strict)
    except ValueError as e:
        if strict and "not in model" in str(e):
            print(f"Note: this checkpoint has tensors the architecture doesn't use; "
                  f"loading without them.\n{e}")
            return _original_load_weights(self, file_or_weights, strict=False)
        raise


def install_lenient_weight_loading():
    """Patch mlx's weight loading once. Safe to call multiple times."""
    global _installed
    if _installed:
        return
    nn.Module.load_weights = _lenient_load_weights
    _installed = True
