# Frontend Critique Checklist

Use this checklist for an existing screen before changing its visual design.

## Dimensions

- **Hierarchy**: Is the entry point obvious? Is there one dominant action? Do title,
  content, status, metadata, and secondary actions read in the right order?
- **Composition**: Are columns, gutters, whitespace, and alignment balanced? Are regions
  grouped by spacing or an intentional container rather than arbitrary borders?
- **Typography**: Are size, weight, line height, and casing consistent? Do long labels,
  logs, and errors remain readable without clipping?
- **Color**: Are surfaces, text, borders, accents, and status colors semantically mapped?
  Do normal, hover, focus, disabled, dark, and error states retain contrast?
- **Affordance**: Can users tell what is clickable, editable, loading, selected, or
  blocked? Are icon-only controls labelled?
- **Density**: Does the screen show enough information for repeated work without making
  every item equally prominent? Are empty and progressive-disclosure states useful?
- **Brand**: Does the screen feel like the same SEP desktop product as adjacent screens?

## Severity

- **P1**: Blocks task completion, hides a required action, causes overlap, or creates an
  accessibility failure. Fix before shipping.
- **P2**: Slows a common workflow, creates visual inconsistency, or makes state/action
  meaning ambiguous. Fix in the current change.
- **P3**: Polish opportunity with no material task failure. Fix when the surface is being
  revisited.

## Review Format

For each finding record:

```text
[P1/P2/P3] Dimension: short issue
Impact: what the user experiences
Fix: the smallest concrete design or code change
```
