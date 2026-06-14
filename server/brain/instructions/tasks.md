# Instructions for Task Nodes (`type: task`)

- **`task` → its activity (never link tasks directly to the user/root if they serve an activity)**:
  - A task (such as an assignment, test, exam, homework, or project) must always link to the specific class/course node it serves (e.g., `[[Math_101]]`), rather than to the top-level college node (`[[College]]`) or directly to the root user (`[[User]]`).
  - If the parent activity/organizer/class (e.g., `[[Math_101]]`) does not exist yet, you must **create it first** (as `type: activity`) and then link the task nodes to it.
  - Only generic personal tasks with no clear activity can link directly to the root.
- **Frontmatter on a `task`**: include `status: open` or `status: done`, and `tags: tag1, tag2`.
