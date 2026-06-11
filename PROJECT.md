# Project: Lemma Brain Topology Verification

## Architecture
- **Backend Server**: Fast API server running on `http://127.0.0.1:8000`.
- **Brain Manager**: Active files under `brain/active/`.
- **Memory Graph**: Adjacency list representation formed by files and links between categories, hubs, leaves, and calendar.
- **Verification Script**: `scripts/test_brain_simulation.py` to run multi-persona E2E conversations, log outputs, verify topology, and print adjacency lists.

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Exploration | Inspect how backend structures memory, handles chats, resets brain, and saves nodes. | None | DONE |
| 2 | E2E Test Suite | Implement a test script that covers the 3 personas and checks constraints. | M1 | DONE |
| 3 | Graph Adjacency Verification | Implement the parser and topology checks within the script. | M2 | DONE |
| 4 | Audit & Reporting | Generate the comprehensive `brain_audit_report.md` | M3 | DONE |

## Interface Contracts
### Brain Reset API / Method
- `POST http://127.0.0.1:8000/api/brain/reset?mode=active` (Unlinks all memory files, re-seeds defaults)
### Chat API
- Endpoint: `POST http://127.0.0.1:8000/chat`
- Request: `ChatRequest` (conversation_id, text, enable_brain=True)
- Response: Streamed text tokens
### Active Brain Directory
- Location: `brain/active/` containing markdown (.md) nodes and `map.json` index.
