---
name: frontend-design
description: Expert frontend design guidelines for creating beautiful, modern UIs. Use when building or redesigning pages, components, dashboards, desktop app surfaces, or any user interface; for this repository, tailor decisions to its Electron + React + Tailwind desktop product context.
metadata: {"clawdbot":{"emoji":"🎨"}}
---

# Frontend Design Skill

Use this skill when creating UI components, application screens, landing pages, dashboards, or any frontend design work. Start from the product's actual workflow and audience: operational and desktop tools should prioritize clarity, information density, predictable navigation, and repeated use; marketing pages may use more expressive composition.

For this repository, design for an Electron desktop AI employee client built with React 18 and Tailwind CSS 4. Reuse the existing component system and local dependencies, preserve renderer/main process boundaries, and treat authentication, instance selection, conversations, streaming output, tool activity, approvals, retries, errors, and empty states as first-class UI states.

## Design Workflow

Follow this structured approach for UI design:

1. **Layout Design** — Think through component structure, create ASCII wireframes
2. **Theme Design** — Define colors, fonts, spacing, shadows
3. **Animation Design** — Plan micro-interactions and transitions
4. **Implementation** — Generate the actual code

### 1. Layout Design

Before coding, sketch the layout in ASCII format. Match the wireframe to the product type rather than defaulting to a landing-page composition.

Landing-page example:

```
┌─────────────────────────────────────┐
│         HEADER / NAV BAR            │
├─────────────────────────────────────┤
│                                     │
│            HERO SECTION             │
│         (Title + CTA)               │
│                                     │
├─────────────────────────────────────┤
│   FEATURE   │  FEATURE  │  FEATURE  │
│     CARD    │   CARD    │   CARD    │
├─────────────────────────────────────┤
│            FOOTER                   │
└─────────────────────────────────────┘
```

Desktop workspace example:

```
┌──────────────┬────────────────────────────────────┐
│ Instance /   │ Active employee · session actions  │
│ conversation ├────────────────────────────────────┤
│ navigation   │                                    │
│              │ Conversation and tool activity     │
│              │                                    │
│ Account /    ├────────────────────────────────────┤
│ settings     │ Composer · attachments · send      │
└──────────────┴────────────────────────────────────┘
```

For application screens, include loading, empty, streaming/busy, approval, retry, error, disabled, and narrow-window states in the layout plan.

### 2. Theme Guidelines

**Color Rules:**
- NEVER use generic bootstrap-style blue (#007bff) — it looks dated
- Prefer oklch() for modern color definitions
- Use semantic color variables (--primary, --secondary, --muted, etc.)
- Consider both light and dark mode from the start

**Font Selection:**
```
Sans-serif: Inter, Roboto, Poppins, Montserrat, Outfit, Plus Jakarta Sans, DM Sans, Space Grotesk
Monospace: JetBrains Mono, Fira Code, Source Code Pro, IBM Plex Mono, Space Mono, Geist Mono
Serif: Merriweather, Playfair Display, Lora, Source Serif Pro, Libre Baskerville
Display: Architects Daughter, Oxanium
```
For packaged or offline-capable desktop apps, prefer the existing local font setup or an OS-appropriate system stack. Bundle any new font with the application instead of depending on a runtime Google Fonts request, and verify Chinese/English fallback behavior.

**Spacing & Shadows:**
- Use consistent spacing scale (0.25rem base)
- Shadows should be subtle — avoid heavy drop shadows
- Consider using oklch() for shadow colors too

### 3. Theme Patterns

Treat these as references, not automatic choices. Select a direction from the product's audience and usage duration. For operational desktop tools, favor a restrained, readable palette with clear semantic states; avoid applying glassmorphism or neo-brutalism merely for novelty.

**Modern Dark Mode (Vercel/Linear style):**
```css
:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --primary: oklch(0.205 0 0);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.970 0 0);
  --muted: oklch(0.970 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --border: oklch(0.922 0 0);
  --radius: 0.625rem;
  --font-sans: Inter, system-ui, sans-serif;
}
```

**Neo-Brutalism (90s web revival):**
```css
:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0 0 0);
  --primary: oklch(0.649 0.237 26.97);
  --secondary: oklch(0.968 0.211 109.77);
  --accent: oklch(0.564 0.241 260.82);
  --border: oklch(0 0 0);
  --radius: 0px;
  --shadow: 4px 4px 0px 0px hsl(0 0% 0%);
  --font-sans: DM Sans, sans-serif;
  --font-mono: Space Mono, monospace;
}
```

**Glassmorphism:**
```css
.glass {
  background: rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 1rem;
}
```

### 4. Animation Guidelines

**Micro-syntax for planning:**
```
button: 150ms [S1→0.95→1] press
hover: 200ms [Y0→-2, shadow↗]
fadeIn: 400ms ease-out [Y+20→0, α0→1]
slideIn: 350ms ease-out [X-100→0, α0→1]
bounce: 600ms [S0.95→1.05→1]
```

**Common patterns:**
- Entry animations: 300-500ms, ease-out
- Hover states: 150-200ms
- Button press: 100-150ms
- Page transitions: 300-400ms

### 5. Implementation Rules

Use the project's existing framework, build pipeline, dependencies, and component primitives before adding anything new.

**For this Electron + React repository:**
- Use the installed Tailwind CSS 4 build setup; do not add a Tailwind CDN script.
- Reuse `src/components/ui` and existing Radix primitives before introducing another component library.
- Use an installed React icon package such as Lucide when available; do not load icon scripts from a CDN or hand-draw common icons.
- Keep runtime assets local or deliberately packaged so the desktop app remains usable without public CDN access.
- Do not introduce Flowbite unless the project explicitly adopts it through its package and design-system workflow.

**For standalone prototypes only:**
Remote prototype resources may be used when the user explicitly asks for a disposable HTML prototype and offline packaging is not required.

**Images:**
- Use images only when they communicate the actual product, employee, file, or application state.
- Reuse verified local assets or valid remote URLs; never invent image URLs.
- Do not add decorative stock imagery to operational screens merely to fill space.

### 6. Responsive Design

Design for the product's real viewport range. Websites should remain mobile-first; desktop applications should start from the minimum supported window size and scale cleanly through common and wide desktop windows.

```css
/* Example desktop application shell */
.app-shell {
  min-width: 48rem;
  display: grid;
  grid-template-columns: minmax(13rem, 17rem) minmax(0, 1fr);
}

@media (max-width: 56rem) {
  .app-shell {
    grid-template-columns: 4rem minmax(0, 1fr);
  }
}
```

Use stable grid/flex constraints, `minmax(0, 1fr)`, overflow handling, and explicit minimum dimensions so long messages, paths, labels, loading content, and tool parameters do not overlap or resize controls unexpectedly.

### 7. Accessibility

- Use semantic HTML (header, main, nav, section, article)
- Include proper heading hierarchy (h1 → h2 → h3)
- Add aria-labels to interactive elements
- Ensure sufficient color contrast (4.5:1 minimum)
- Support keyboard navigation

### 8. Component Design Tips

**Cards:**
- Use cards for genuinely independent repeated items, modals, and framed tools—not as the default wrapper for every page section
- Subtle shadows, not heavy drop shadows
- Consistent padding (p-4 to p-6)
- Add lift/shadow hover only when it communicates clickability; static work panels should remain stable

**Buttons:**
- Clear visual hierarchy (primary, secondary, ghost)
- Adequate touch targets (min 44x44px)
- Loading and disabled states

**Forms:**
- Clear labels above inputs
- Visible focus states
- Inline validation feedback
- Adequate spacing between fields

**Navigation:**
- Use predictable, persistent navigation for desktop workspaces and clear active-state indication
- Preserve the user's current context when opening drawers, approvals, or detail views
- Use a mobile hamburger menu only when the target product and viewport actually require it

---

## Quick Reference

| Element | Recommendation |
|---------|---------------|
| Primary font | Inter, Outfit, DM Sans |
| Code font | JetBrains Mono, Fira Code |
| Border radius | 0.5rem - 1rem (modern), 0 (brutalist) |
| Shadow | Subtle, 1-2 layers max |
| Spacing | 4px base unit (0.25rem) |
| Animation | 150-400ms, ease-out |
| Colors | oklch() for modern, avoid generic blue |

---

*Based on SuperDesign patterns — https://superdesign.dev*
