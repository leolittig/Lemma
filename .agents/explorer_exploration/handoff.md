# Handoff Report: Codebase Exploration

This handoff report summarizes the findings from the exploration of the Lemma codebase under Milestone 1.

## 1. Observation
Below are the direct observations from exploring the files in `/Users/leolittig/Development/Lemma`.

### Active Brain Reset Mechanism
- **REST API Endpoint**: In `server/routes/brain.py` (lines 214-226):
  ```python
  @router.post("/api/brain/reset")
  async def reset_brain(
      mode: str = Query(default=None),
  ):
      resolved_mode = _resolve_mode(mode)
      try:
          storage_brain.reset_brain(resolved_mode)
          return {"status": "ok"}
      except ValueError as e:
          raise HTTPException(status_code=400, detail=str(e))
      except Exception as e:
          raise HTTPException(status_code=500, detail=str(e))
  ```
- **Backend Function**: In `server/storage/brain.py` (lines 345-356):
  ```python
  def reset_brain(mode: str):
      """Deletes all memory files in the brain directory for a given mode, and seeds default hubs."""
      brain_dir = get_brain_dir(mode).resolve()
      if not brain_dir.exists() or not brain_dir.is_dir():
          return
      # Delete all files in the brain directory
      for fpath in brain_dir.iterdir():
          if fpath.is_file():
              fpath.unlink()
      # Re-initialize brains (re-seeds default hubs and rebuilds map.json)
      init_brains()
  ```

### Active Brain File Structure and Formats
- **Files Location**: All active brain memory nodes are located inside the directory `brain/active/` (corresponding to the `"active"` mode defined in `server/config.py`).
- **File Format**: The nodes are written in Markdown (`.md`) files. An index file `map.json` keeps a cache of filename stems to short descriptions.
- **Node Structure**: In `server/storage/brain.py`, the function `parse_markdown_node` (lines 128-186) parses the following:
  1. **Frontmatter**: Block at the top between `---` markers containing properties:
     - `created`: datetime in `YYYY-MM-DD HH:MM` format.
     - `updated`: datetime in `YYYY-MM-DD HH:MM` format.
     - `category`: `"hub"` or `"leaf"`.
  2. **Title**: Defined by a level-1 header `# <Title>`.
  3. **Description**: Text paragraph directly following the H1 title.
  4. **Logs**: List of bullet points or logs starting with a timestamp `[YYYY-MM-DD HH:MM]`.
  5. **Connections/Links**: Wikilinks using double square brackets `[[TargetNode]]`, which can also contain anchors (`#`) and aliases (`|`). E.g., `[[Calendar]]` or `[[Calendar#events|My Events]]`.
- **Connections Adjacency**: The endpoint `GET /api/brain/graph` in `server/routes/brain.py` (lines 141-196) lists all node stems as node IDs, and parses wikilinks pointing to existing stems in the folder as directed edges/links.

### Chat Requests API
- **Endpoint**: `POST /chat` in `server/routes/chat.py` (lines 55-130).
- **Payload Schema**: Matching `ChatRequest` Pydantic model in `server/schemas.py` (lines 12-34):
  ```python
  class ChatRequest(BaseModel):
      conversation_id: str
      text: str = ""
      attachments: List[Dict[str, Any]] = []
      temperature: Optional[float] = None
      max_kv_size: Optional[int] = None
      enable_thinking: Optional[bool] = None
      max_tokens: Optional[int] = None
      smart_context: Optional[bool] = True
      enable_brain: Optional[bool] = True
  ```
- **Response Format**: `StreamingResponse` (media type `text/plain`) containing raw text tokens streamed from MLX. Custom headers serve context window and brain activity metadata:
  - `X-Context-Trimmed`: `"1"` if trimmed.
  - `X-Context-Out-Ranges`: JSON array of message ranges omitted from context.
  - `X-Brain-Activity`: JSON metadata containing the pre-analysis routing reasoning and files read.

### Background Memory Processing
- **Asynchronous Execution**: Spawned in `POST /chat` (lines 481-486 in `server/routes/chat.py`):
  ```python
  if brain_mode:
      threading.Thread(
          target=_run_post_processing,
          args=(cid, msg_pos, brain_mode, user_text, clean, brain_activity),
          daemon=True,
      ).start()
  ```
- **Locking & Serialization**: The thread runs `_run_post_processing` which executes generation under the global `generation_lock` (defined in `server/model_manager.py`, line 25) using a `with generation_lock:` block to serialize MLX executions.
- **Completion Detection**: 
  - The thread finishes its execution by updating `brain_activity` in SQLite (only if changes were written/deleted) and rewriting `brain/active/map.json`.
  - To programmatically detect or wait for completion, a client can:
    - Monitor the file modification time (`mtime`) of `brain/active/map.json`.
    - Try to acquire the `generation_lock` (or hit endpoints like `POST /api/brain/mode` or `POST /model` which try to acquire the lock and block until it is free).

### Running the Server
- **Scripts**: Defined in `package.json` (lines 6-10):
  - `"dev": "concurrently \".venv/bin/python app.py\" \"vite\""`
- **Backend Startup**: Runs `.venv/bin/python app.py` which runs `uvicorn` on host `127.0.0.1` and port `8000` (defined in `server/config.py`).
- **Current Status**: Verified using `lsof -i :8000` that the backend is already running on PID 30190, and the `vite` dev server is running on PID 30191.

---

## 2. Logic Chain
1. By examining `server/routes/brain.py`, we located the `POST /api/brain/reset` router endpoint, which delegates to `server.storage.brain.reset_brain(resolved_mode)`. Looking at `server/storage/brain.py`, we see this function clears the target directory using `fpath.unlink()` and repopulates the default seeds (`User.md`, `Assistant.md`, `Calendar.md`) using `init_brains()`.
2. By reviewing `server/storage/brain.py`'s parsing logic (`parse_markdown_node`, `validate_markdown_node`), we see that brain nodes are stored as markdown files with specific headers, timestamps, and `[[wikilink]]` references to determine connectivity, and `map.json` is used as a JSON index.
3. In `server/routes/chat.py`, we identified the `/chat` route that accepts `ChatRequest` from `server/schemas.py`.
4. In `server/routes/chat.py` (lines 481-486), we found the daemon thread creation pointing to `_run_post_processing`. We traced how it serializes using the shared `generation_lock` and updates database and files. We reasoned that since `rebuild_map` writes `map.json` at the end, tracking `map.json` modification time is a reliable file-based wait indicator, and calling endpoints that acquire the `generation_lock` is an API-based wait indicator.
5. In `package.json` and `app.py`, we identified the start command `npm run dev` and python command `.venv/bin/python app.py`. Running `lsof -i :8000` confirmed the python server process is already running.

---

## 3. Caveats
- Hugging Face cache and model downloads rely on internet connectivity, which is restricted in this environment. However, the models needed for routing/chat must be cached locally for normal operation.
- If no file edits or deletions are suggested by the model during post-processing, the database `brain_activity` JSON is not rewritten (though `map.json` is still rebuilt).

---

## 4. Conclusion
The Lemma codebase represents memory nodes as Markdown files under `brain/active/` with wikilink topology. Chat requests are streamed via `POST /chat`, and memory processing executes asynchronously via a background daemon thread that serializes generation through a global mutex `generation_lock` and updates `map.json` upon completion. The server is currently active and listening on port 8000.

---

## 5. Verification Method
- **Verify Reset API**: Run `curl -X POST http://127.0.0.1:8000/api/brain/reset?mode=active` and verify that `brain/active/` contains only the three seeded default files (`User.md`, `Assistant.md`, `Calendar.md`) and a regenerated `map.json`.
- **Verify Chat API**: Run `curl -i -X POST http://127.0.0.1:8000/chat -H "Content-Type: application/json" -d '{"conversation_id": "test_id", "text": "Hello", "enable_brain": false}'` and ensure the HTTP response streams back.
