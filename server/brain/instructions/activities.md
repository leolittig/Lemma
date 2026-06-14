# Instructions for Activity Nodes (`type: activity`)

- **`activity` → root or parent activity (avoid direct links to root for sub-activities)**:
  - Top-level main activities (e.g., `[[College]]`, `[[Work]]`) must link directly to the root (`[[User]]`).
  - Sub-activities or nested activities (e.g., specific classes/courses like `[[Math_101]]` under `[[College]]`, or specific projects/gigs under `[[Work]]`) must link **only** to their parent activity, and **never** directly to the root user (`[[User]]`).
  - A sub-activity connects to the root user *implicitly* through its parent activity.
- A job, a gig, a project, and a side-business are separate activities, never merged into one.
