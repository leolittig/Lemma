# Implementation Plan

## Phase 1: Exploration (Complete)
- **Step 1.1**: Explore codebase, server reset, and map.json update mechanisms.
- **Step 1.2**: Restart outdated backend server and verify core hubs seed disconnected.

## Phase 2: Execution (In Progress)
- **Step 2.1**: Update `server/brain/instruction_manual.md` with:
  - Strict frontmatter requirement for `category: hub` or `category: leaf` on all CREATE/UPDATE operations.
  - Precise rules for the `Connections & Links` section of each node type.
  - Concrete topology boundaries to avoid cross-leaf links and core hub links.
- **Step 2.2**: Run E2E conversation simulation using `scripts/test_brain_simulation.py` via a worker.
- **Step 2.3**: Verify that all three scenarios (Professional, Student, Hobbyist) complete with a status of `PASS`.

## Phase 3: Verification
- **Step 3.1**: Spawn reviewer to verify correct instruction manual layout and correct topology outputs.
- **Step 3.2**: Spawn forensic auditor to verify no hardcoding/integrity violations.
- **Step 3.3**: Verify final generated `brain_audit_report.md` is clean and contains no topology errors.
