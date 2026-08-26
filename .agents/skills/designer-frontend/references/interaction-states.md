# Interaction And Motion States

Use these state contracts when designing or implementing the task workbench.

## Task Lifecycle

| State | Required UI meaning | Motion/feedback |
| --- | --- | --- |
| queued | Accepted but not started | Stable neutral indicator; no constant movement |
| running | Work is actively progressing | Subtle progress or streaming feedback; avoid distracting spinners |
| waiting-approval | User action is required | Clear warning/approval treatment and an explicit next action |
| paused | Work is intentionally stopped | Preserve context and expose resume/cancel where supported |
| completed | Result is available | One-time success feedback; keep result actions visible |
| failed | Work did not finish | Explain the failure and expose retry or recovery |
| cancelled | User or system stopped the work | Confirm finality and preserve useful logs |

## Component States

For buttons, inputs, drawers, dialogs, and import controls, define at minimum:

```text
idle -> hover -> focus -> active
idle -> loading -> success
idle -> loading -> error -> retry
idle -> disabled
```

`focus` must be visible without relying only on color. `loading` must prevent duplicate
submissions where appropriate. `error` must say what happened and how to recover.

## Motion Rules

- Animate the changed region, not the whole page.
- Use transform/opacity for entry and exit; reserve height changes for intentional
  disclosure and keep them short.
- Use one consistent easing and duration family across the workbench.
- Do not animate every status refresh or streamed token.
- Provide a reduced-motion path with no nonessential movement.
