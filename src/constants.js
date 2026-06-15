// Shared UI constants. Values that tune backend behavior live in
// server/config.py; these only shape what the frontend offers.

// Discrete context-window options (tokens). The slider in the settings modal
// snaps to these by index; the default is the middle step. Doubling each step
// keeps the low end (where most useful values live) as well-spaced as the
// high end.
export const CTX_STEPS = [512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072];
export const CTX_DEFAULT_INDEX = 2; // 2048

// Discrete options for the maximum response length (tokens). 0 = unlimited.
export const MAX_TOKENS_STEPS = [128, 256, 512, 1024, 2048, 4096, 8192, 16384, 0];
export const MAX_TOKENS_DEFAULT_INDEX = 8; // Unlimited


// Shown in the top bar until the backend reports the actually loaded model.
export const INITIAL_MODEL_NAME = 'mlx-community/gemma-4-12B-it-8bit';
