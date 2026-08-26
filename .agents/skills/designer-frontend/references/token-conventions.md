# Token Conventions

Use tokens to keep the existing workbench coherent while avoiding a broad visual
rewrite. Prefer CSS custom properties in `src/index.css` and consume semantic tokens in
component rules.

## Token Tiers

1. **Primitive**: raw palette and measurement values, such as a red tonal scale or a
   4 px spacing unit.
2. **Semantic**: roles such as `--workspace-surface`, `--workspace-ink`,
   `--workspace-muted`, `--workspace-line`, `--workspace-accent`, `--status-warning`.
3. **Component**: a specific use such as `--sidebar-width`, `--control-height-sm`, or
   `--task-card-radius`.

Components should normally consume semantic or component tokens, not primitive hex
values. Add a new token only when a value is reused, semantically meaningful, or needs a
theme/state mapping.

## Recommended Scales

- Spacing: 2, 4, 8, 12, 16, 24, 32, 48 px.
- Control heights: compact 28-32 px, standard 36-40 px, prominent 44 px.
- Radius: one small control radius, one panel radius, and one pill radius only when a
  pill communicates status.
- Typography: caption, body-small, body, section, page-title; define line height with
  each size instead of overriding it ad hoc.

## Status Mapping

Keep status semantics stable across sidebar, task list, detail view, and notifications:

```text
queued      -> neutral
running     -> accent/in-progress
waiting     -> warning/approval
paused      -> muted-warning
completed   -> success
failed      -> danger
cancelled   -> muted-danger or neutral
```

Pair color with text, icon, shape, or position so state remains understandable in
grayscale and for color-impaired users.
