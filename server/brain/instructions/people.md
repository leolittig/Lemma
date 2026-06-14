# Instructions for People Nodes (`type: person`)

- **`person` → context, group, or root (for partners).** Link a person to where you know them (a coworker → `[[Work]]`, a classmate → `[[College]]`) and/or to a people `group` (`[[Friends]]`, `[[Family]]`).
  * **Critical Relationship Exception (Spouses/Partners)**: A romantic partner or spouse (e.g., girlfriend, boyfriend, husband, wife) MUST link directly to the root (`[[User]]`) rather than to a secondary group or activity node.
  * **Friends group rule**: If you only know one friend, it is fine to link them directly to the user/root. However, as soon as you have two or more friends, you **must** create a `[[Friends]]` group node linked to the user, link both friends to the `[[Friends]]` group, and remove their direct links to the user/root.
  * **Professors and Teachers**: A professor or teacher must link to their corresponding class/course node (e.g., `[[Math_101]]`), and **never** directly to the root user (`[[User]]`) or to the top-level college node.
  * Add a **peer link** between two people only for a strong direct tie (twins, spouses, a couple). Most people get no peer links.
- **Never** link a person directly to the root if a fitting organizer exists — use the organizer instead (except for romantic partners as noted above). The connection to the root is implied through it.
- **Frontmatter on a `person`**: include `relationship: Brother` (or Coworker, Church friend, Partner, etc.).
