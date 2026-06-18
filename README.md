# Lemma

Lemma is a local AI system that runs large language models on your own machine —
cross-platform, through **MLX** on Apple Silicon or **llama.cpp** (GGUF) on
Windows, Linux, and macOS. Beyond chat, it gives the model a persistent,
graph-based **brain**: as you talk, a second model automatically extracts the
information worth keeping and files it into a linked graph of Markdown
memories — a **calendar**, **people**, **tasks**, a **journal**, and other
structures — then reads the relevant pieces back into context on later turns.

It runs as two programs that talk over HTTP: a Python/FastAPI **backend**
(`server/`) that loads the model, streams replies, manages downloads, and
maintains the brain and conversation history (SQLite); and a React/Vite
**frontend** (`src/`) that renders the chat, the model picker, and an
interactive brain-graph explorer.

## Running it

### 1. Prerequisites

- **Python 3.10+**
- **Node.js 18+** (provides `npm`)

> `llama-cpp-python` installs prebuilt wheels on most platforms, but may build
> from source — which needs a C/C++ toolchain and CMake.

### 2. Get the code

```bash
git clone <repo-url> Lemma
cd Lemma
```

### 3. Install dependencies

Create the virtual environment as **`.venv`** (the dev script expects that name):

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate

pip install -r requirements.txt  # Python backend + the right inference engine
npm install                      # React frontend
```

`requirements.txt` installs the correct engine for your platform automatically
(MLX on macOS, llama.cpp everywhere).

### 4. Run

```bash
npm run dev
```

This starts the backend and frontend together. Open **http://localhost:5173**.

To run the production build instead (the backend serves the built frontend):

```bash
npm run build
python app.py        # then open http://127.0.0.1:8000
```

## Recommended models

Pick a model in the app (the model picker can download it from Hugging Face).
Good defaults per platform:

| Platform | Engine | Model |
|---|---|---|
| macOS (Apple Silicon) | MLX | [`mlx-community/gemma-4-12B-it-8bit`](https://huggingface.co/mlx-community/gemma-4-12B-it-8bit) |
| Windows / Linux | llama.cpp (GGUF) | [`unsloth/gemma-4-12B-it-qat-GGUF`](https://huggingface.co/unsloth/gemma-4-12B-it-qat-GGUF) |

On machines with less memory, try a smaller model such as
[`mlx-community/gemma-4-e4b-it-4bit`](https://huggingface.co/mlx-community/gemma-4-e4b-it-4bit)
(macOS) or a lower-bit GGUF quant.
