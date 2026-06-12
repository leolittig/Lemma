"""Standalone sanity check for the mlx_vlm generation loop.

Runs generate_step against a tiny dummy model (no real weights needed), so it
verifies the installed mlx/mlx_vlm versions are compatible without loading a
multi-gigabyte checkpoint. Run with: .venv/bin/python scripts/smoke_test_generation.py
"""

import mlx.core as mx
import mlx.nn as nn
from mlx_vlm.generate.ar import generate_step

class DummyLM(nn.Module):
    def __call__(self, x, **kwargs):
        # returns shape (batch, seq, vocab)
        return type('Outputs', (), {'logits': mx.zeros((1, 1, 10)), 'cross_attention_states': None, 'encoder_outputs': None})

class DummyModel(nn.Module):
    def __init__(self):
        super().__init__()
        self.language_model = DummyLM()
    def get_input_embeddings(self, *args, **kwargs):
        return type('Embeddings', (), {'inputs_embeds': mx.zeros((1, 1, 10)), 'to_dict': lambda: {}})

model = DummyModel()
gen = generate_step(mx.array([[1]]), model, None, None, max_tokens=5)
tokens = list(gen)
print("Generated length:", len(tokens))
