# Instructions for Group Nodes (`type: group`)

- **Grouping (avoid flat fan-outs)**:
  - When **two or more** nodes of the same kind would otherwise hang off the root with nothing in common, create a `group` (or `activity`) to hold them, and link them to it instead. Example: the moment a second friend appears, make a `Friends` group and put both under it.
  - A single, lone node may attach directly to the root until a sibling appears — then create the organizer and re-parent both.
  - If one organizer collects too many heterogeneous children (~7–10+), split it into sub-organizers.
