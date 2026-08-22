# XITE Platform — Complete UI Architecture & Backend Specification Reference

> **Persistent System Reference Document**  
> This specification documents the complete UI flow, floating toolbar dock system, page/theme side drawer, custom domain & publishing suite, and corresponding backend API contracts for the Xite Academic Platform.

---

## 🛠️ System Architecture Overview

The Xite Academic Platform consists of two primary services:
* **`xite-F`** (Frontend): Next.js App Router + TypeScript + Tailwind CSS + Zod validation
* **`xite-B`** (Backend): Express API Gateway + Node.js + Prisma ORM + PostgreSQL

---

## 1. 🎛️ Floating Bottom Toolbar Dock (`EditorToolbar.tsx`)

The floating bottom toolbar provides real-time controls for site layout, section management, and multi-device preview modes.

### Visual Component Layout:
```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ [X] │ [⚙️ Settings] [💾 Save Status] [🔗 Share Link] [👁️ Preview] │                      │
│     │ [Hero] [📋 Copy] [↶ Undo] [↻ Swap] [↷ Redo] [↑ Up] [↓ Down] [🗑️ Delete] [✕ Close]│
│     │ [🖥️ 1200px] [💻 Tablet] [📱 Mobile]                                               │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

### Functional Specifications:
1. **Brand & System Tools**:
   - `[X]` / `[⚙️ Settings]`: Opens the College Brand & Domain Settings Modal.
   - `[💾 Save Status]`: Live autosave indicator (`Saved 15:42` / `Saving...`).
   - `[🔗 Copy Link]`: Copies tenant preview link to clipboard.
   - `[👁️ View Site]`: Opens public tenant portal in new browser tab.

2. **Active Section Control Bar**:
   - `Section Label`: Displays current active section type (e.g. `Hero`, `About`, `Courses`).
   - `[📋 Duplicate]`: Clones section content and inserts immediately below.
   - `[↶ Undo / ↷ Redo]`: Traverses client section history stack.
   - `[↻ Swap Variant]`: Cycles through available variant designs in `registry.tsx` for that section type.
   - `[↑ Move Up / ↓ Move Down]`: Shifts section `displayOrder` in real time.
   - `[🗑️ Delete]`: Removes section with undo capability.

3. **Responsive Viewport Controls**:
   - `Desktop`: `1200px` container width.
   - `Tablet`: `768px` container width.
   - `Mobile`: `375px` container width.

---

## 2. 📑 Pages, Colors & Fonts Side Drawer (`DrawerPanel.tsx`)

The left sliding drawer manages page navigation structure, color palettes, and typography presets.

### Functional Specifications:
1. **Pages Tab**:
   - Lists all pages in `navOrder` sequence:
     - `Home` (`/home`)
     - `About Us` (`/about`)
     - `Academics` (`/academics`)
     - `Events & News` (`/events`)
     - `Faculty` (`/faculty`)
     - `Admissions` (`/admissions`)
     - `Contact Us` (`/contact`)
     - `Programs` (`/programs`)
     - `Schools/Department` (`/departments`)
     - `Placement & Career...` (`/placements`)
     - `Scholarships` (`/scholarships`)
   - `+ Add New Page`: Triggers page creation modal (`title`, `slug`, `navOrder`).

2. **Colors Tab**:
   - Palette picker selecting active `themePaletteId`.
   - Modifies CSS custom properties (`--primary`, `--accent`, `--background`, `--text`).

3. **Fonts Tab**:
   - Font family selector setting `themeFontId` (Heading Font & Body Font).

---

## 3. 🌐 Custom Domain & Publishing Suite (`DomainSettingsModal.tsx`)

### Visual Component Layout:
```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│  Publishing & Custom Domain Settings                                                    │
│  Configure A Record, CNAME, and SSL hosting for your website                            │
│                                                                                         │
│  PRIMARY CUSTOM DOMAIN                                      [✓ SSL Active & Connected]  │
│  ┌───────────────────────────────────────────────────────┐  ┌───────────────────────┐  │
│  │ mec.edu.in                                            │  │      Save Domain      │  │
│  └───────────────────────────────────────────────────────┘  └───────────────────────┘  │
│                                                                                         │
│  (● PRODUCTION LIVE) • Last deployed Jul 31, 2026 at 05:35 AM                            │
│  Publish Website to Production                              [ 🌐 Publish to Production ]│
│  Target URL: https://mec.edu.in                             [      Visit Live Site ↗ ]│
│                                                                                         │
│  DNS CONFIGURATION INSTRUCTIONS                                                         │
│  ┌──────┬────────────┬─────────────────────────┬──────────────┬──────┐                  │
│  │ TYPE │ HOST/NAME  │ TARGET VALUE            │ STATUS       │ COPY │                  │
│  ├──────┼────────────┼─────────────────────────┼──────────────┼──────┤                  │
│  │ A    │ @          │ 76.76.21.21             │ ● Connected  │  📋  │                  │
│  └──────┴────────────┴─────────────────────────┴──────────────┴──────┤                  │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

### Functional Specifications:
1. **Primary Custom Domain**:
   - Custom domain input field (e.g. `mec.edu.in`).
   - SSL status badge (`SSL Active & Connected`).
   - `Save Domain` action triggering domain binding in backend.

2. **Production Deployment Engine**:
   - Deployment status badge (`PRODUCTION LIVE` / `UNPUBLISHED DRAFT`).
   - Last deployed timestamp display (`Last deployed Jul 31, 2026 at 05:35 AM`).
   - `Publish to Production`: Syncs draft layout to public live site.
   - `Visit Live Site ↗`: Direct link to primary domain (`https://mec.edu.in`).

3. **DNS Configuration Table**:
   - **Type**: `A Record` / `CNAME`.
   - **Host / Name**: `@` (Root domain) / `www`.
   - **Target Value**: `76.76.21.21` / `cname.webxite.org`.
   - **Status**: `Connected` / `Pending Verification`.
   - **Copy Action**: One-click clipboard copy for DNS records.

---

## 4. 🗄️ Backend API Contracts & Schema Mapping (`xite-B`)

### Prisma Database Models:

```prisma
model College {
  id             String        @id @default(cuid())
  name           String
  subdomain      String        @unique
  customDomain   String?       @unique @map("custom_domain")
  status         CollegeStatus @default(DRAFT)
  templateId     String?       @map("template_id")
  themePaletteId String?       @map("theme_palette_id")
  themeFontId    String?       @map("theme_font_id")
  createdAt      DateTime      @default(now()) @map("created_at")
  pages          Page[]
  sections       CollegeSection[]
}

model Page {
  id        String   @id @default(cuid())
  collegeId String   @map("college_id")
  slug      String
  title     String
  navOrder  Int      @default(0) @map("nav_order")
  sections  CollegeSection[]

  @@unique([collegeId, slug])
}

model CollegeSection {
  id           String    @id @default(cuid())
  collegeId    String    @map("college_id")
  sectionId    String    @map("section_id")
  variantId    String    @map("variant_id")
  pageId       String?   @map("page_id")
  displayOrder Int       @map("display_order")
  isVisible    Boolean   @default(true) @map("is_visible")
  content      Json      @default("{}")
  lastSavedAt  DateTime? @map("last_saved_at")
}
```

### Express REST API Endpoints:

| Endpoint | Method | Purpose |
| :--- | :--- | :--- |
| `/api/v1/editor/:subdomain` | `GET` | Fetch all pages, sections, theme palettes, and configuration for editor canvas. |
| `/api/v1/sections/:id` | `PATCH` | Auto-save section JSON content and update `lastSavedAt`. |
| `/api/v1/pages` | `POST` | Create a new page for the college tenant (`title`, `slug`, `navOrder`). |
| `/api/v1/publish` | `POST` | Publish site status to `PUBLISHED` and record deployment timestamp. |
| `/api/v1/college/domain` | `PATCH` | Bind custom domain (`customDomain`) and trigger SSL status check. |

---

> **Document Status**: Verified & Synced across `xite-F` and `xite-B`.
