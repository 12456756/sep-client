---
name: designer-frontend
description: Apply the designer-skills design practice to this Electron React product. Use when reviewing or building UI where layout, color, component shape, visual hierarchy, interaction states, or motion need deliberate design decisions.
---

# Designer Frontend

Use this skill for user-facing frontend work in this repository. The goal is a quiet,
scannable desktop workbench for recurring task execution, not a marketing page or a
decorative prototype.

## Repository Context

- Renderer code lives in `src/`; the main workspace is composed from
  `src/pages/WorkspaceHomePage.tsx` and `src/components/workspace/`.
- Shared visual rules currently live primarily in `src/index.css`.
- The app is an Electron desktop client with a minimum window around 960 x 640 and a
  common working viewport around 1200 x 800.
- Preserve the existing React, CSS, and `lucide-react` patterns. Keep UI changes scoped
  to the requested surface and avoid unrelated refactors.

## Workflow

### 1. Inspect Before Editing

For an existing screen, establish the current layout, content priority, states, and
real data before proposing changes. Read the target component and its CSS, then inspect
the rendered screen at the normal and minimum desktop sizes when possible.

Run a short critique across hierarchy, composition, typography, color, affordance, and
information density. Read [critique-checklist.md](references/critique-checklist.md) for
the review dimensions and P1/P2/P3 severity rules.

### 2. Compose the Layout

- Define the page grid, column widths, gutters, and minimum sizes before styling details.
- Use a consistent 4 px or 8 px spacing scale; do not introduce unexplained one-off gaps.
- Let content determine breakpoints and reflow. The desktop shell must remain usable at
  960 px wide without clipping controls or causing text overlap.
- Use proximity and alignment to group related controls. Use a bordered or tinted region
  only when spacing alone cannot communicate grouping.
- Keep workbench pages dense enough for scanning. Avoid oversized hero sections,
  decorative floating cards, and nested cards.

### 3. Establish Visual Hierarchy

- Identify one primary action per view and make it the clearest action.
- Use size, weight, contrast, and whitespace intentionally; do not highlight every
  control.
- Keep titles and status labels compact in panels and sidebars. Reserve display-scale
  typography for an actual page-level entry point.
- Constrain long descriptions and logs to a readable measure instead of stretching text
  across the full window.

### 4. Apply Color and Shape

- Prefer semantic tokens such as surface, ink, muted, line, accent, success, warning,
  danger, and approval over raw color literals in component rules.
- Preserve contrast for text, disabled states, focus indicators, and status colors. Never
  use color as the only signal for task state.
- Use restrained, product-specific color. Do not add gradients, decorative blobs, or a
  single-hue palette without a clear semantic reason.
- Keep control geometry consistent: shared radius, border, height, icon size, and hover
  treatment should come from a small component vocabulary.
- Use familiar `lucide-react` icons inside icon buttons and provide an accessible label or
  tooltip for unfamiliar symbols.

For a larger CSS cleanup, read [token-conventions.md](references/token-conventions.md).

The full upstream reference set used for this skill is available under
`references/designer-skills/`. These are reference documents, not executable slash
commands. Read only the relevant files for the current task:

- Layout and color: `ui-design/skills/` or `ui-design/commands/`
- Existing-screen critique: `visual-critique/skills/` or `visual-critique/commands/`
- Tokens and component contracts: `design-systems/skills/` or `design-systems/commands/`
- Interaction, states, loading, and motion: `interaction-design/skills/` or
  `interaction-design/commands/`
- Evaluation and testing: `prototyping-testing/skills/` or
  `prototyping-testing/commands/`
- Handoff and visual QA: `design-ops/skills/` or `design-ops/commands/`

Use the command documents as workflow templates and the skill documents as decision
criteria. Do not copy their Claude/Gemini slash-command syntax into the application.

### 5. Design States and Motion

Every interactive surface needs explicit idle, hover, focus, disabled, loading, success,
and error behavior where applicable. Task and agent surfaces additionally need queued,
running, waiting for approval, paused, completed, failed, and cancelled states.

Motion should explain change, preserve spatial context, and stay short. Prefer opacity,
transform, and color transitions; avoid animation that delays a repeated task or competes
with streamed output. Respect `prefers-reduced-motion`.

Read [interaction-states.md](references/interaction-states.md) when working on task
execution, approval dialogs, drawers, composer feedback, or knowledge-base indexing.

### 6. Implement and Verify

- Change the smallest set of components and styles that delivers the design decision.
- Keep stable dimensions for toolbars, cards, status indicators, and buttons so dynamic
  content cannot shift the surrounding layout.
- Preserve keyboard navigation, visible focus, semantic labels, and usable hit targets.
- Check both 1200 x 800 and 960 x 640. Verify empty, loading, error, and long-content
  states, not only the happy path.
- For a visual change, report the affected files and the verification performed.

## Review Output

When asked to review without editing, produce prioritized findings with: issue, design
dimension, user impact, concrete fix, and severity. When asked to implement, make the
smallest coherent change and keep the same review criteria for verification.
