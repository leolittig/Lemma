# Original User Request

## Initial Request — 2026-06-11T06:34:00Z

Run end-to-end conversation simulation tests against the Lemma Brain manager across multiple user personas and use cases to verify that the generated memory graph consistently complies with the strict scale-free category hub and leaf node topology.

Working directory: /Users/leolittig/Development/Lemma
Integrity mode: development

## Requirements

### R1. Multi-Persona Conversation Simulation Script
- Write a Python script (`scripts/test_brain_simulation.py`) that simulates three distinct user personas, resetting the active brain before each scenario:
  
  **Scenario A: The Professional / Work-heavy Persona**
  1. Boot/reset (User, Assistant, Calendar disconnected).
  2. "I just started as a software developer at ACME Corp." (Work category hub created, linked only to User).
  3. "I have a database migration assignment next week." (Assignment leaf created, linked to Work).
  4. "The database migration deadline is June 20th." (Assignment linked to Calendar; Work stays disconnected from Calendar).
  5. "My birthday is January 15th." (User links to Calendar).

  **Scenario B: The Student / Academic Persona**
  1. Boot/reset.
  2. "I study computer science at the university." (University category hub created, linked only to User).
  3. "I have two papers to write: Paper 1 on AI Ethics, and Paper 2 on Compilers." (Paper1 and Paper2 leaves created, linked to University).
  4. "AI Ethics is due on June 18th, and Compilers is due on June 22nd." (Paper1 and Paper2 linked to Calendar; University stays disconnected from Calendar).

  **Scenario C: The Hobbyist / Social Persona**
  1. Boot/reset.
  2. "I love birdwatching and hiking in my free time." (Hobbies category hub created, linked only to User).
  3. "I have a birdwatching trip scheduled." (Trip leaf created, linked to Hobbies).
  4. "The trip is on July 5th." (Trip linked to Calendar; Hobbies stays disconnected from Calendar).

- The script must make chat requests to the backend server (on `http://127.0.0.1:8000/chat` or via direct backend route calls) representing each turn.
- Wait for background memory processing to complete after each turn.
- Log the assistant response and disk changes for each scenario.

### R2. Adjacency Graph Audit & Reporting
- At the end of each scenario, parse the files in `brain/active/` to build the graph representation.
- Programmatically verify that:
  - All category hubs link ONLY to `[[User]]` (or custom categories but NEVER calendar).
  - Leaf nodes with dates link to both their category hub and `[[Calendar]]`.
  - Leaf nodes without dates do NOT link to `[[Calendar]]`.
  - Core hubs (`User`, `Assistant`, `Calendar`) start disconnected and only connect on relevant entries.
- Output a comprehensive audit report `brain_audit_report.md` detailing the test logs, final graph structures, and an analysis of how this aligns with the user's requested brain topology.

## Acceptance Criteria

### Script Execution & Personal Logging
- [ ] The simulation script successfully executes all three scenarios.
- [ ] Logs capture the step-by-step assistant replies and file CRUD commands.

### Topology Verification
- [ ] The script prints the final graph adjacency list for each scenario.
- [ ] The script programmatically flags any invalid links (such as category hubs linked to Calendar, or cross-leaf links).
- [ ] The audit report is generated at `brain_audit_report.md` with a thorough analysis.
