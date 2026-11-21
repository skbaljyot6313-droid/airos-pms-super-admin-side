# 02 — Design System Audit

Source files: `frontend/src/index.css`, `frontend/index.html`, `frontend/src/components/ui/*`, `frontend/src/components/employees/analysis/kit.tsx`, `docs/aesthetics.md`. Counts are from grep over `frontend/src/**/*.tsx` (class-token occurrences, not unique elements).

## 1. Architecture of the design system

- **No design tokens exist as CSS variables or a Tailwind `@theme` block.** `index.css` contains only `@import "tailwindcss"`, a body rule, two font utilities, scrollbar styles, and motion keyframes.
- **All colours are hardcoded hex inside Tailwind arbitrary-value classes** (e.g. `bg-[#386641]`). Changing a brand colour requires editing hundreds of files.
- Shared primitives exist in `components/ui/`: `Button`, `Card`, `Badge`, `Modal`, `Drawer`, `ConfirmationDialog`, `Skeleton`, `BackButton`, `ToastContainer`, `OperationalCalendar`.
- A second, parallel primitive kit exists for analysis: `components/employees/analysis/kit.tsx` (`C` object, `card`, `Section`, `Panel`, `Empty`, `Delta`, KPI helpers).
- Dependencies relevant to UI: Tailwind 4.3, `tailwind-merge`, `lucide-react` 0.546, `@dnd-kit/core` 6.3, `leaflet` 1.9 + `leaflet.markercluster` 1.5. **No chart library** (no recharts, chart.js, visx, or echarts): all charts are hand-built CSS bars or inline SVG.

## 2. Colour — warm system (shell and most pages)

This is the palette to preserve, as requested. Values are exact as they appear in the source.

### 2.1 Core tokens (de facto)

| Role | Hex | Occurrences (approx.) | Where |
|---|---|---|---|
| Brand green (primary) | `#386641` | 371 | Primary buttons, logo tile, active accents |
| Brand green hover | `#2F5736` | — | `Button` primary hover |
| Charcoal text | `#24221F` | 331 | Body text (`index.css`), headings, modal titles |
| Muted text | `#8C867C` | 228 | Metadata, IST label, breadcrumbs |
| Secondary text | `#6C675F` | 125 | Descriptions, table secondary |
| Body background | `#FAF8F5` | 176 | `index.css` `body` |
| Shell background | `#F7F4EE` | — | `App.tsx` AppContent wrapper (**differs from body**) |
| Card border | `#EAE5DC` | 94 | `Card`, header bottom borders |
| Input/outline border | `#DDD7CB` | 175 | Buttons outline/secondary, inputs |
| Dark green text (active nav) | `#244E2C` | 37 | Active primary/secondary nav text |
| Sage surface | `#EBF3EC` | 65 | Active nav background, sage badge/button |
| Sage border | `#CEE4D1` | — | Sage badge/button border |
| Sage text | `#285230` (badge), `#2B5433` (button) | — | Badges, sage button |
| Hover surface | `#F6F3EE` / `#F5F2EB` / `#F2EEE7` | 45 (`#F2ECE3`), 45 (`#F0ECE4`) | Hover states, secondary button |
| Divider (light) | `#F2ECE3`, `#F0ECE4`, `#F4F0E8` | 45 / 45 / 26 | Modal header, card dividers |
| Scrollbar thumb | `#D9D4CB` / hover `#BCB6AA` | — | `index.css` |

### 2.2 Status colours (warm system)

| Status | Text | Background | Border | Source |
|---|---|---|---|---|
| Sage / success | `#285230` | `#EBF3EC` | `#CEE4D1` | `Badge` sage |
| Orange / warning | `#9A4C07` | `#FEF3E8` | `#FCD9BD` | `Badge` orange |
| Red / danger | `#A32A2A` | `#FDE8E8` | `#F9C3C3` | `Badge` red |
| Lavender / info | `#554388` | `#F2EFF9` | `#DDD5F0` | `Badge` lavender |
| Neutral | `#48443D` | `#F3EFE9` | `#E2DDD5` | `Badge` neutral |
| Outline | `#575249` | transparent | `#DDD7CC` | `Badge` outline |
| Destructive button | white | `#C53B3B` (hover `#AF3232`) | — | `Button` destructive |
| Error text | `#A82828` | `#FDE8E8` | — | error cards, logout |
| Amber accent | `#C98232` | — | — | ~18 uses |
| Teal accent | `#169B72` | — | — | ~22 uses (shared with analysis palette) |

### 2.3 Cool analysis palette (employee analysis and team analytics)

Defined in `kit.tsx` as `C`. Documented in `docs/aesthetics.md` §1.2. This is a **second, different palette** and must be resolved before redesign (see §9).

| Token | Hex | Role |
|---|---|---|
| bg | `#F8F9FB` (doc says `#F7F8FA`) | App wash, empty wells |
| surface | `#FFFFFF` | Cards |
| text | `#17212B` | Primary text |
| muted | `#697586` | Secondary text |
| faint | `#98A2B3` | Tertiary/axis |
| border | `#E9EDF2` | Card borders |
| hairline | `#EEF1F5` | Separators |
| track / mutedSurface | `#F1F3F6` | Progress tracks |
| navy (accent) | `#365D78` | Active tab, primary bars |
| blue | `#6686A0` | Secondary series |
| success | `#169B72` | Completed/approved |
| warning | `#D99532` | Pending |
| danger | `#D76565` | Abandoned/rejected |
| successBg / warningBg / dangerBg | `#EAF6F0` / `#FBF4E8` / `#FCEEEE` | Tinted surfaces |
| nested | `#FAFBFC` | Expanded nested areas |

Note the doc/code mismatch: `aesthetics.md` lists background `#F7F8FA` while `kit.tsx` uses `#F8F9FB`. Treat `kit.tsx` as authoritative.

## 3. Typography

| Item | Value | Source |
|---|---|---|
| Body family | `'Satoshi', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif` | `index.css` |
| Satoshi loading | Fontshare CSS import (`satoshi@400,500,600,700`) | `index.css` L1 — external CDN dependency |
| Display family | `'Space Grotesk', system-ui, …` (`.font-display`) | `index.css` |
| Space Grotesk loading | Google Fonts (`600;700`) | `index.html` |
| Inter | Loaded from Google Fonts (`400;500;600;700`) | `index.html` L15 — **no usage found** in `src` (`font-inter`, `'Inter'` grep: 0 matches). Candidate for removal. |
| `font-body` uses | 200 | grep |
| `font-display` uses | 103 | grep |
| `font-mono` uses | 31 | grep (Tailwind default mono) |

### Size distribution (class-token counts)

| Class | Count | Px |
|---|---|---|
| `text-[9px]` | 35 | 9 |
| `text-[9.5px]` | 10 | 9.5 |
| `text-[10px]` | 155 | 10 |
| `text-[10.5px]` | 21 | 10.5 |
| `text-[11px]` | 284 | 11 |
| `text-xs` | 482 | 12 |
| `text-[12px]` | 44 | 12 |
| `text-[12.5px]` | 29 | 12.5 |
| `text-[13px]` | 93 | 13 |
| `text-[14px]` | 9 | 14 |
| `text-sm` | 256 | 14 |
| `text-[15px]` | 33 | 15 |
| `text-base` | 10 | 16 |
| `text-lg` | 29 | 18 |
| `text-xl` | 17 | 20 |
| `text-2xl` | 15 | 24 |
| `text-[28px]` | 17 | 28 |

**Assessment**: ~505 usages at ≤11px, the same order as the 12px body class. No consistent type scale exists. Recommended scale for redesign: 11 (metadata, uppercase labels only), 12 (secondary), 13 (body dense), 14 (body default), 16 (section), 20 (page title), 24 (KPI large). Use `tabular-nums` for all figures (analysis kit already does; warm pages mostly do not).

## 4. Spacing

- Tailwind default 4px scale in use. Common paddings: `p-3`, `p-4`, `p-5` (Card), `px-3 py-1.5` (small buttons), `px-4 py-2` (default buttons).
- Vertical rhythm: `space-y-5` (page), `space-y-4` (sections), `gap-3`/`gap-4` (grids).
- Page containers: shell `max-w-[1600px] px-4 sm:px-6 lg:px-8 py-6`; analysis `max-w-[1440px]`; many feature views `max-w-[1320px]` or narrower.

## 5. Radius

Multiple radii, no scale.

| Class | Count |
|---|---|
| `rounded-[10px]` | 190 |
| `rounded-full` | 130 |
| `rounded-[8px]` | 99 |
| `rounded-lg` | 66 |
| `rounded-[7px]` | 63 |
| `rounded-[12px]` | 62 |
| `rounded-md` | 34 |
| `rounded-xl` | 28 |
| `rounded-[14px]` | 27 |
| `rounded-[9px]` | 26 |
| `rounded-[16px]` | Card |

Recommended: 6 / 8 / 12 / full (4 tokens). The brief asks for fewer rounded containers; `Card` at 16px and buttons at 12px are the largest.

## 6. Shadows and elevation

| Class | Count |
|---|---|
| `shadow` | 43 |
| `shadow-xs` | 21 |
| `shadow-sm` | 16 |
| `shadow-lg` | 8 |
| `shadow-xl` | 6 |
| `shadow-md` | 3 |
| `shadow-2xl` | 2 |

Card uses `shadow-[0_1px_3px_rgba(0,0,0,0.03)]`, hover `shadow-[0_4px_12px_rgba(36,34,31,0.05)]`. Analysis `card` uses `shadow-[0_1px_2px_rgba(16,24,40,0.04)]`. Dropdowns use `shadow-lg`. Recommend two elevations only (flat border; floating menu).

## 7. Components

### 7.1 Button (`components/ui/Button.tsx`)

- Variants: `primary` (green fill, white), `sage` (tinted green), `secondary` (warm grey fill), `outline`, `destructive` (red), `ghost`.
- Sizes: `sm` (text-xs, px-3 py-1.5), `md` (text-sm, px-4 py-2), `lg` (text-base, px-5 py-2.5).
- Base: `rounded-[12px]`, `font-body font-medium`, focus ring `#3E6B48/30`, disabled opacity 50, `active:scale-[0.99]` on primary/sage.
- Loading state built in (`isLoading` spinner).
- Gap: no icon-only button size, no `link` variant; inline `<button>` elements with custom classes are common across views (see Header, Overview). Count of raw `<button className=…>` is high — primitives are under-used.

### 7.2 Badge (`components/ui/Badge.tsx`, 351 lines)

- Variants: sage, orange, red, lavender, neutral, outline. Sizes: `sm` (11px, px-2 py-0.5), `md` (12px, px-2.5 py-1). Pill (`rounded-full`).
- Also contains task/room/bed/type status mapping (imports `TaskStatus`, `RoomStatus`, `BedStatus`) — **business mapping lives inside a UI primitive**. Recommend moving status→variant mapping to a `statusMeta` module.

### 7.3 Card (`components/ui/Card.tsx`)

- `bg-white border border-[#EAE5DC] rounded-[16px] p-5 shadow-[…]`, optional `hoverEffect`. Also exports `CardHeader`, etc.
- Analysis `card` token is different (`rounded-xl`, border `#E9EDF2`, 12px radius).

### 7.4 Modal (`components/ui/Modal.tsx`, 99 lines)

- Overlay `bg-[#24221F]/40 backdrop-blur-xs`, `ea-fade` animation. Panel rounded and scrollable; header with `border-[#F2ECE3]`, title `font-display font-bold text-xl`. Close button 32px.
- ~25 modals/drawers across the app; most are bespoke sizes.

### 7.5 Drawer (`components/ui/Drawer.tsx`, 83 lines) — used by task and template detail.

### 7.6 ConfirmationDialog (`components/ui/ConfirmationDialog.tsx`, 106 lines) — used for destructive actions.

### 7.7 Skeleton, ToastContainer, BackButton — present; `Skeleton` used by WorkspaceGate and Overview.

### 7.8 Inputs

- No shared `Input`, `Select`, `Textarea`, or `Field` primitive in `components/ui/`. Auth has `FormField.tsx` and `PasswordInput.tsx` only. Inputs are styled inline per form — **the largest source of styling inconsistency** for the redesign. Count of raw `<input` / `<select` elements should be measured during implementation (NEEDS VERIFICATION exact count).

### 7.9 Tables

- No shared `DataTable`. Tables are hand-written `<table>` or CSS grid rows per view (Departments, Employee Directory, Units, Tasks). Sorting/filter UX differs per table.

### 7.10 Charts

- No chart library. Implemented visuals: CSS distribution bars (`EmployeeDashboard`), SVG activity chart and bucket hover (`analysis/OverviewTab`), allocation stepper (`AllocationTimeline`), Leaflet map (`LiveLocationMap`), calendar grids (`OperationalCalendar`, `TaskCalendarView`, `MaintenanceCalendarView`).

### 7.11 Icons

- `lucide-react` 0.546 across the app. Icon sizes mostly `w-3.5`–`w-4` (14–16px) with `w-[18px]` in modals. Consistent library.

### 7.12 Motion

- Keyframes in `index.css`: `ea-rise`, `ea-fade` (analysis); `lp-*` (landing: rise, fade, float, dash, fill, count, reveal-img, drift, marquee). All honour `prefers-reduced-motion`.

## 8. Breakpoints and responsive

- Tailwind defaults in use: `sm` 640, `md` 768, `lg` 1024, `xl` 1280, `2xl` 1536. No custom breakpoints in config (`@theme` absent).
- Header: hamburger below `md`; secondary nav hidden below `md`; ISTClock hidden below `lg`.
- Grids: `grid-cols-2 sm:grid-cols-3 lg:grid-cols-6` (Overview), `md:grid-cols-2 lg:grid-cols-3` (WorkspaceGate skeleton).
- Mobile-specific tables: NEEDS VERIFICATION (no dedicated mobile table pattern found).

## 9. Decisions required before redesign

1. **Single palette or two?** The brief asks to preserve the warm palette. The analysis surfaces use a cool slate palette with different accents (navy `#365D78`, success `#169B72`, warning `#D99532`). Options: (a) converge analysis onto warm tokens; (b) keep cool palette as an analysis-only theme; (c) document both as "data palette". **Recommendation**: (a) for chrome, keep semantic status hues but map them to the warm family.
2. **Background**: choose `#FAF8F5` or `#F7F4EE` as the canonical shell background.
3. **Inter**: remove the unused import or adopt it deliberately.

## 10. Proposed token set (for the redesign to adopt; values taken from current usage)

```
--color-brand:          #386641
--color-brand-hover:    #2F5736
--color-brand-ink:      #244E2C
--color-brand-soft:     #EBF3EC
--color-brand-line:     #CEE4D1
--color-ink:            #24221F
--color-ink-2:          #6C675F
--color-ink-3:          #8C867C
--color-bg:             #FAF8F5   (decide vs #F7F4EE)
--color-surface:        #FFFFFF
--color-line:           #EAE5DC
--color-line-strong:    #DDD7CB
--color-hover:          #F6F3EE
--color-danger:         #C53B3B
--color-danger-ink:     #A32A2A
--color-danger-soft:    #FDE8E8
--color-warn-ink:       #9A4C07
--color-warn-soft:      #FEF3E8
--color-info-ink:       #554388
--color-info-soft:      #F2EFF9
--font-body:            'Satoshi', system-ui, …
--font-display:         'Space Grotesk', system-ui, …
--radius-sm: 6px; --radius-md: 8px; --radius-lg: 12px;
```

Implement as a Tailwind `@theme` block in `index.css` so existing hex classes can be migrated mechanically.
