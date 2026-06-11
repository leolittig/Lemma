# E2E Test Infra: Lemma Brain Topology Verification

## Test Philosophy
- Opaque-box, requirement-driven E2E conversation simulation.
- Verify memory graph topology under specific multi-persona scenarios.

## Feature Inventory
| # | Feature | Source | Tier 1 | Tier 2 | Tier 3 |
|---|---------|--------|:------:|:------:|:------:|
| 1 | Brain Reset | R1. Boot/reset | ✓ | | |
| 2 | Scenario A (Work) | R1. Persona A | ✓ | ✓ | ✓ |
| 3 | Scenario B (Academic) | R1. Persona B | ✓ | ✓ | ✓ |
| 4 | Scenario C (Hobbies) | R1. Persona C | ✓ | ✓ | ✓ |
| 5 | Adjacency Graph Audit | R2. Verification | ✓ | ✓ | ✓ |

## Test Architecture
- Test runner: `scripts/test_brain_simulation.py`
- Location of memory: `brain/active/`
- Expected: All scenarios run sequentially, programmatically validating topological properties and outputting `brain_audit_report.md`.

## Coverage Thresholds
- All 3 scenarios successfully simulated.
- Adjacency list printed for each scenario.
- Validation checks for category hubs, leaf nodes, dates, and core hubs.
