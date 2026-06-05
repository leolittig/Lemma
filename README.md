# Lemma

A lightweight local LLM chat interface optimized for Apple Silicon using MLX, React, and Vite.

## Project Structure

```text
Lemma/
├── src/                        # React frontend source code
│   ├── App.jsx                 # Main Chat UI, model switcher, and KaTeX math renderer
│   ├── main.jsx                # React bootstrapper
│   └── index.css               # Vanilla CSS layout, dark mode, and chat bubbles styling
├── app.py                      # FastAPI server (manages MLX models, unloads memory on swap, streams replies)
├── requirements.txt            # Python dependencies (fastapi, uvicorn, mlx-vlm, huggingface-hub, mlx, aiofiles)
├── package.json                # Node dependencies (react, marked, katex, concurrently)
├── vite.config.js              # Vite config (proxies api requests to FastAPI on port 8000)
└── index.html                  # Vite frontend HTML entrypoint
```

## How it Works

1. **Frontend ([src/App.jsx](src/App.jsx))**: A React application that manages conversation state, active model selection, and downloading status. It sends user inputs to `/chat` and uses a `ReadableStream` reader to decode and render responses in real time. It uses `marked` combined with `katex` to support Markdown, code highlighting, and LaTeX math formulas (e.g., `$E=mc^2$`).
2. **Backend ([app.py](app.py))**: A FastAPI server that runs MLX operations on the main event loop thread to ensure GPU stream cohesion. It manages model unloading (reclaiming memory via garbage collection and cache clearing), model loading, downloaded model listings, Hugging Face downloads, and formatting prompt history.

## Quick Start

### 1. Set Up Virtual Environment
Create and activate the virtual environment:
```bash
python -m venv .venv
source .venv/bin/activate
```

### 2. Install Dependencies
Install both Python and Node dependencies:
```bash
pip install -r requirements.txt
npm install
```

### 3. Run the App
You can run the app in two ways:

#### A. Development Mode (Recommended)
Runs both the frontend and the Python backend concurrently:
1. Start the development environment:
   ```bash
   npm run dev
   ```
2. Open `http://localhost:5173` in your browser.

#### B. Production Mode
Compiles the React frontend so the Python server can serve it directly:
1. Build the frontend:
   ```bash
   npm run build
   ```
2. Start the server:
   ```bash
   python app.py
   ```
3. Open `http://127.0.0.1:8000` in your browser.

## Model Management & Switching

Lemma provides a fully interactive model switcher in the UI's top bar:
* **Switching Models**: Click the dropdown in the top bar to select from your downloaded models. When switching, the backend automatically unloads the active model, runs garbage collection, and clears the MLX GPU cache to free system memory before loading the new model.
* **Adding Models**: You can download any MLX-compatible model directly inside the app. Click the add icon in the dropdown and enter any Hugging Face Repository ID (e.g., `mlx-community/gemma-2-9b-it-4bit-mlx`).
