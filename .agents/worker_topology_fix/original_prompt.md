## 2026-06-11T09:50:58Z
You are the Topology Fix Worker. Your working directory is `/Users/leolittig/Development/Lemma/.agents/worker_topology_fix`.

Please perform the following tasks:
1. Edit `/Users/leolittig/Development/Lemma/server/brain/instruction_manual.md` to strengthen and clarify the topology and frontmatter rules for the Brain Manager model. Make sure you cover:
   - **Strict YAML Frontmatter**: Every CREATE or UPDATE command MUST output the `category` property (either `category: hub` or `category: leaf`). Explain that omitting this defaults the node to `leaf` and triggers critical topology failures.
   - **Hub vs Leaf Roles**:
     - Core hubs (`User`, `Assistant`, `Calendar`) must always be `category: hub`.
     - Custom category hubs (e.g., `Work`, `University`, `Hobbies`) must always be `category: hub`.
     - Factual nodes, tasks, papers, trips (e.g. `Migration`, `Paper1`, `Paper2`, `BirdTrip`) must always be `category: leaf`.
   - **Explicit Connections & Links Rules**:
     - `User.md` links only to custom category hubs (e.g., `[[Work]]`, `[[University]]`, `[[Hobbies]]`). Never link to `[[Assistant]]`. Links to `[[Calendar]]` only if there is a birthday/date.
     - `Assistant.md` must NEVER contain links to any node. The Connections section must remain empty.
     - `Calendar.md` links only to leaf nodes with dates/deadlines (e.g. `[[Migration]]`, `[[Paper1]]`, `[[Paper2]]`, `[[BirdTrip]]`). It must never link to custom category hubs or other core hubs (except `[[User]]` for birthday).
     - Custom Category Hubs (e.g., `Work.md`, `University.md`, `Hobbies.md`) link only back to `[[User]]`. They must never link to `[[Calendar]]` or to any leaf nodes.
     - Leaf Nodes (e.g., `Migration.md`) link to their parent custom category hub (e.g., `Hubs: [[Work]]`). If and only if they have a date/deadline, they also link to `[[Calendar]]` (e.g., `Hubs: [[Work]], [[Calendar]]`). They must NEVER link to other leaf nodes or to `[[User]]` or `[[Assistant]]`.

2. Run the E2E simulation script: `.venv/bin/python scripts/test_brain_simulation.py` to execute all three personas (Professional, Student, Hobbyist) and generate `brain_audit_report.md`.
3. Check the command output and `brain_audit_report.md`. Verify if all checks pass and all scenarios succeed (PASS). If any checks fail, refine the edits to `instruction_manual.md` and re-run.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Please write a handoff report at `/Users/leolittig/Development/Lemma/.agents/worker_topology_fix/handoff.md` detailing the edits made, the simulation output, and the path to the updated `brain_audit_report.md`. Send a message when you are done.
