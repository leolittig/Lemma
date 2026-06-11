# BRIEFING — 2026-06-11T06:36:00Z

## Mission
Explore the Lemma codebase to answer key questions on active brain reset, storage structure of brain nodes, chat requests, background memory processing, and how to run the server.

## 🔒 My Identity
- Archetype: Codebase Explorer
- Roles: Investigator, Reporter
- Working directory: /Users/leolittig/Development/Lemma/.agents/explorer_exploration
- Original parent: 16cfa112-56b3-4ab1-88f2-06f468e6b8b4
- Milestone: Explorer Exploration

## 🔒 Key Constraints
- Read-only investigation — do NOT implement

## Current Parent
- Conversation ID: 16cfa112-56b3-4ab1-88f2-06f468e6b8b4
- Updated: not yet

## Investigation State
- **Explored paths**:
  - `app.py` and `package.json`
  - `server/config.py` and `server/model_manager.py`
  - `server/routes/brain.py` and `server/storage/brain.py`
  - `server/routes/chat.py` and `server/schemas.py`
- **Key findings**:
  - Reset API: `POST /api/brain/reset`
  - Brain storage: Markdown nodes under `brain/active/` containing frontmatter and wikilinks `[[Target]]` mapped via `map.json`.
  - Chat requests: `POST /chat` with `ChatRequest` schema.
  - Background memory processing: daemon thread executing `_run_post_processing` serialized by `generation_lock` and finishing by writing `map.json`.
  - Server is active on port 8000.
- **Unexplored areas**: None, all objective questions are fully answered.

## Key Decisions Made
- Stored details in handoff.md and progress.md.
- Verified active server ports using lsof.

## Artifact Index
- /Users/leolittig/Development/Lemma/.agents/explorer_exploration/handoff.md — Final investigation report
