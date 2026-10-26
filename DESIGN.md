---
name: SEP 硅基员工平台
description: 面向企业协作的硅基员工桌面工作台
colors:
  brand-red: "#ae383d"
  brand-red-deep: "#8f2d34"
  canvas: "#f0eef1"
  surface: "#ffffff"
  surface-subtle: "#fbf9fa"
  ink: "#302e34"
  ink-secondary: "#514d55"
  ink-muted: "#716a72"
  line: "#e5dfe4"
  ready: "#1a7f52"
  attention: "#8a6410"
  danger: "#bf3149"
typography:
  display:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "25px"
    fontWeight: 700
    lineHeight: 1.2
  title:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "15px"
    fontWeight: 650
    lineHeight: 1.35
  body:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.35
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.brand-red}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
    height: "36px"
  surface:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"

# Design System: SEP 硅基员工平台

## Overview

**Current visual baseline:** the renderer currently uses a light desktop shell, a fixed left navigation, a top context bar, red brand accents, semantic status colors, compact typography, and optional dark mode. This file records the incumbent system before the approved whole-client redesign is implemented.

The redesign must keep the product in Operate mode: users arrive to complete work, inspect a real employee state, make a decision, or retrieve a result. Brand personality should appear in identity and state language, not in decorative effects. The target system should feel like a calm operations room for a team of capable digital colleagues.

**Key Characteristics:**

- Desktop-first, dense enough for repeated work, with readable scanning hierarchy.
- Red brand color used as a scarce action and identity signal.
- Semantic state colors paired with text and icons.
- Stable navigation and action locations across pages.
- Employee identity expressed through role, capability, state, and work history.

## Colors

The incumbent palette is warm red against cool neutral surfaces. During redesign, keep semantic meaning but reduce decorative gradients and reserve the brand accent for navigation, primary actions, selected states, and employee identity.

### Primary

- **SEP Brand Red** (#ae383d): primary actions, selected navigation, employee identity accents, and focused controls.
- **Deep Brand Red** (#8f2d34): pressed and high-emphasis brand states.

### Neutral

- **Canvas** (#f0eef1): application background and page gutters.
- **Surface** (#ffffff): primary working surfaces.
- **Subtle Surface** (#fbf9fa): secondary areas and quiet states.
- **Ink** (#302e34): titles and high-priority content.
- **Secondary Ink** (#514d55): supporting content.
- **Muted Ink** (#716a72): metadata and explanatory text.
- **Line** (#e5dfe4): separators and low-emphasis boundaries.

### Semantic

- **Ready** (#1a7f52): available, complete, or healthy.
- **Attention** (#8a6410): waiting for user action, confirmation, or review.
- **Danger** (#bf3149): failed, stopped, or destructive action.

### Named Rules

**The State With Evidence Rule.** A status must explain what happened and what the user can do next; color alone is never the message.

**The Scarce Accent Rule.** Brand red should identify action and focus, not paint every surface.

## Typography

**Display Font:** system UI sans stack.

**Body Font:** system UI sans stack.

**Character:** compact, neutral, and highly legible. Use weight and spacing to establish hierarchy rather than oversized marketing headlines or decorative type.

### Hierarchy

- **Display** (700, 25px, 1.2): page titles and the primary work context.
- **Title** (650, 15px, 1.35): section headings, employee names, and work titles.
- **Body** (400, 13px, 1.55): goals, descriptions, messages, and explanatory copy.
- **Label** (600, 11px, 1.35): metadata, status labels, timestamps, and filter labels.

## Layout

- Keep one application shell with one primary navigation model. Do not duplicate the same destinations in both a top nav and side nav.
- Keep employee discovery as one navigation destination. Use an in-page scope control for “与我有关 / 企业全部”; reserve organization views for authorization and management relationships.
- Use a fixed navigation rail with a collapsible compact state. Keep the content region fluid and page-specific.
- Use a page header for title, context, and the primary action. Page-specific tabs stay inside the page header or workbench.
- Use a reading width around 1180–1280px for list and detail pages; allow workbench and organization graph surfaces to use the available width.
- Keep a consistent 8px rhythm with 16px and 24px grouping intervals.
- At narrower desktop widths, collapse secondary panels before reducing primary content below readable measure.
- Detail pages use a clear two-column relationship: primary work or employee content, then a contextual rail for state, actions, or metadata.

## Elevation & Depth

Use tonal surfaces and one restrained shadow vocabulary. A surface may use a border or a shadow, not both as a default. Prefer open page regions, alignment, whitespace, and one or two separators over boxed panels. Dialogs and drawers can use stronger separation. Avoid decorative glow, glass, and large ambient gradients.

## Shapes

- Small controls: 6px radius.
- Buttons and inputs: 8px radius.
- Main panels and drawers: 12px radius.
- Pills are reserved for compact status and filter controls.
- Keep focus rings visible and brand-derived.
- Do not use nested cards as the primary page composition.

## Components

- **Navigation item:** icon, label, selected state, optional count; selected state must remain legible in compact mode. Employee discovery is one item; scope is selected inside the page.
- **Employee identity:** avatar or generated face, name, role, availability, and current work state. Identity is never just an image.
- **Work status:** icon + text + semantic color + next action when applicable.
- **Primary button:** one clear action per page region; label names the action.
- **Filter group:** segmented controls for a small set, select or menu for larger sets, search for text discovery.
- **Timeline:** chronological state changes with actor, time, and evidence.
- **Deliverable row:** file or result name, source step or employee, status, and open/reveal action.
- **Dialog/drawer:** reserved for focused decisions, protected confirmation, or contextual detail that should not reset page context.

## Do's and Don'ts

### Do

- Make the employee, work state, pending decision, and deliverable visible within seconds.
- Use real data ranges and long content to validate layout.
- Keep primary actions in stable locations.
- Pair every waiting, failed, or completed state with a recovery or next-step action.
- Use Lucide icons consistently and provide accessible labels.

### Don't

- Do not use a dashboard of decorative metric cards as the default home page.
- Do not duplicate navigation destinations in multiple competing bars.
- Do not make every page a grid of same-shaped cards.
- Do not use gradients, glowing effects, or sci-fi ornament as a substitute for hierarchy.
- Do not invent employee activity, progress, capabilities, or business claims.
