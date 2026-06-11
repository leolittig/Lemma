# Lemma

A lightweight local LLM chat interface optimized for Apple Silicon using MLX, React, and Vite.

## How it works

Lemma is two programs that talk over HTTP:

1. **Backend** (`server/`, started by [app.py](app.py)) — a Python FastAPI server that loads an MLX model into memory, streams generated replies, manages model downloads from Hugging Face, and persists conversations in SQLite.
2. **Frontend** (`src/`) — a React app that renders the chat, reads the reply stream token by token, and renders Markdown, code, and LaTeX math (via `marked` + KaTeX).

In development, Vite serves the frontend on port 5173 and proxies API calls to the backend on port 8000 (see [vite.config.js](vite.config.js)). In production, the backend serves the built frontend itself.

## Quick start

### 1. Set up a virtual environment

```bash
python -m venv .venv
source .venv/bin/activate
```

### 2. Install dependencies

```bash
pip install -r requirements.txt
npm install
```

### 3. Run the app

**Development mode (recommended)** — runs frontend and backend together:

```bash
npm run dev
```

Then open `http://localhost:5173`.

**Production mode** — build the frontend once, then the Python server serves everything:

```bash
npm run build
python app.py
```

Then open `http://127.0.0.1:8000`.

## Features

* **Conversation sidebar** — history is saved locally in SQLite; rename, delete, and switch chats from the sidebar.
* **Model management** — pick any downloaded model from the top-bar dropdown, or download a new one by entering a Hugging Face repo id. Switching unloads the old model and clears the MLX GPU cache to free memory.
* **Thinking models** — reasoning models (Qwen 3, Gemma 4, …) get a Thinking toggle; the reasoning stream is parsed and shown in a collapsible block above the answer.
* **Context & token management** — sliders cap the response length and the context (history) sent to the model. The "smart context window" keeps the start, a middle slice, and the most recent turns of an over-long chat, and the UI dims the messages that fell out.
* **Attachments** — send images and audio to vision/audio-capable models.

## Project structure

Every feature lives in its own module. The fastest way to find something: decide whether it's backend (Python) or frontend (JS), then match the file name below.

```text
Lemma/
├── app.py                       Backend entry point (just starts the server)
├── server/                      Python backend, one module per feature
│   ├── main.py                  Assembles the FastAPI app from the modules below
│   ├── config.py                ALL paths and tunable constants
│   ├── schemas.py               Shapes of the JSON request bodies (API contract)
│   ├── model_manager.py         The loaded model: loading, swapping, unloading
│   ├── model_catalog.py         Lists models already in the Hugging Face cache
│   ├── model_downloads.py       Background downloads + progress tracking
│   ├── context_window.py        Trims long conversations to the token budget
│   ├── thinking.py              Reasoning (<think>) tag detection/stripping
│   ├── system_prompt.py         Persists the default system prompt
│   ├── mlx_compat.py            Workaround for checkpoints with extra tensors
│   ├── storage/
│   │   ├── database.py          Conversations + messages (SQLite, chats.db)
│   │   └── uploads.py           Uploaded media files (uploads/)
│   └── routes/                  One file per API area, each exposing a router
│       ├── chat.py              POST /chat — the streamed generation turn
│       ├── models.py            /model, /models, /download
│       ├── conversations.py     /conversations CRUD
│       ├── files.py             /upload
│       └── frontend.py          GET / (serves the built frontend)
├── src/                         React frontend
│   ├── main.jsx                 Entry point (mounts App)
│   ├── App.jsx                  Root component: wires hooks to components
│   ├── constants.js             Slider steps and other UI constants
│   ├── api/client.js            EVERY backend call, in one place
│   ├── hooks/                   Reusable state + behavior
│   │   ├── useConversations.js  The sidebar list + the open conversation
│   │   ├── useChat.js           The send flow: post a turn, stream the reply
│   │   ├── useSettings.js       All user settings, persisted to localStorage
│   │   ├── useModels.js         Active model, switching, downloads
│   │   ├── useAttachments.js    Pending uploads for the composer
│   │   ├── useAutoScroll.js     The follow-the-stream scroll lock
│   │   ├── useMessageFlip.js    Slide-up reflow animation for the bubbles
│   │   └── usePersistentState.js  localStorage-backed useState
│   ├── components/              The UI, one file per area
│   │   ├── TopBar.jsx           App bar (sidebar toggle, new chat, settings)
│   │   ├── ModelPicker.jsx      Model dropdown + download progress
│   │   ├── Sidebar.jsx          Conversation list (rename/delete/switch)
│   │   ├── MessageList.jsx      The scrollable chat area
│   │   ├── MessageBubble.jsx    One message (attachments, thinking, text)
│   │   ├── BubbleText.jsx       Completed-message markdown + context dimming
│   │   ├── ThinkingBlock.jsx    Collapsible reasoning panel
│   │   ├── Composer.jsx         Input row (attach, thinking toggle, send)
│   │   ├── Modal.jsx            Shared dialog shell (overlay + title + close)
│   │   ├── ToggleSwitch.jsx     Shared on/off switch
│   │   ├── SettingsModal.jsx    Settings dialog
│   │   ├── AddModelModal.jsx    "Download a model" dialog
│   │   └── ModelLoadingOverlay.jsx  Spinner while swapping models
│   ├── lib/                     Pure helpers (no state)
│   │   ├── markdown.jsx         marked + KaTeX setup, streaming renderer
│   │   ├── thinking.js          Splits reasoning from the answer
│   │   ├── modelName.jsx        Pretty model name for the top bar
│   │   └── textarea.js          Auto-growing textarea helper
│   └── styles/                  CSS, one file per UI area
│       ├── index.css            Imports all of the below
│       ├── base.css             Font, page defaults, button/textarea defaults
│       ├── layout.css           Page skeleton
│       ├── topbar.css           App bar
│       ├── sidebar.css          Conversation sidebar
│       ├── messages.css         Chat area, bubbles, animations, markdown
│       ├── thinking.css         Reasoning block
│       ├── composer.css         Input area + attachment chips
│       ├── controls.css         Shared switches and sliders
│       ├── settings.css         Modal dialogs + settings form
│       └── model-picker.css     Model dropdown + loading overlay
├── scripts/
│   └── smoke_test_generation.py Minimal mlx_vlm generation sanity check
├── chats.db                     SQLite database (created on first run)
├── uploads/                     Uploaded attachment files
├── system_prompt.txt            Saved default system prompt (optional)
├── requirements.txt             Python dependencies
├── package.json                 Node dependencies and npm scripts
├── vite.config.js               Dev-server proxy to the backend
└── index.html                   Vite HTML entry point
```

## Where to change what

| I want to… | Look in |
|---|---|
| Change a default (model, port, paths, trimming shares) | [server/config.py](server/config.py), [src/constants.js](src/constants.js) |
| Change how long chats are trimmed | [server/context_window.py](server/context_window.py) |
| Change how replies are generated/streamed | [server/routes/chat.py](server/routes/chat.py) |
| Change what's stored, or the DB schema | [server/storage/database.py](server/storage/database.py) |
| Change model loading/switching behavior | [server/model_manager.py](server/model_manager.py) |
| Add/modify an API endpoint | the matching file in [server/routes/](server/routes/) + [src/api/client.js](src/api/client.js) |
| Change a request body's fields | [server/schemas.py](server/schemas.py) + [src/api/client.js](src/api/client.js) |
| Change how messages look or animate | [src/components/MessageBubble.jsx](src/components/MessageBubble.jsx) + [src/styles/messages.css](src/styles/messages.css) |
| Change markdown / math rendering | [src/lib/markdown.jsx](src/lib/markdown.jsx) |
| Add a user setting | [src/hooks/useSettings.js](src/hooks/useSettings.js) + [src/components/SettingsModal.jsx](src/components/SettingsModal.jsx) |
| Change scroll/“follow the stream” behavior | [src/hooks/useAutoScroll.js](src/hooks/useAutoScroll.js) |
| Restyle a UI area | the matching file in [src/styles/](src/styles/) |

## How to add a feature

**A new API endpoint.** Add a request schema to `server/schemas.py` (if it has a body), implement the endpoint in the matching `server/routes/` module (or a new module exposing a `router`, included in `server/main.py`), add a function for it in `src/api/client.js`, and — if it's a new top-level path — add the path to `BACKEND_PATHS` in `vite.config.js`.

**A new user setting.** Add a persisted value in `src/hooks/useSettings.js`, render its control in `src/components/SettingsModal.jsx`, and if the backend needs it: send it in the `/chat` body (`buildChatBody` in `src/hooks/useChat.js`), add the field to `ChatRequest` in `server/schemas.py`, and use it in `server/routes/chat.py`.

**A new piece of UI.** Create a component in `src/components/`, a stylesheet in `src/styles/` (imported from `styles/index.css`), and render it from `App.jsx` or the component that owns that screen area. Keep state in `App.jsx` or a hook; keep components presentational where possible.

**A new kind of stored data.** Add a table or column in `server/storage/database.py` (`init_db` shows the backfill pattern for adding columns to existing databases), plus accessor functions in the same file.
