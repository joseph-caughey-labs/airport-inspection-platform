# `apps/web`

Operator + reviewer dashboard. **Nuxt 3 shell** in this PR — dark-mode-first design system, Pinia store for connection state and role, default operator layout (sticky header with status pill and role badge), placeholder home page. Live map, alert feed, WebSocket integration, incident timeline, and reviewer queue arrive in Phase 2 and Phase 4.

## Stack

- **Nuxt 3** with SSR.
- **TailwindCSS** dark-mode-first (`darkMode: 'class'`, html class `dark`).
- **Pinia** for state.
- **`@aip/shared-contracts`** for typed enums (Role, Severity, etc.).

## Design system

Tokens in `tailwind.config.ts`:

| Token group                                                   | Purpose                                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `aip.base / panel / elevated / border / fg / muted / accent`  | Background tiers + foreground + single cyan brand accent. No pure black. |
| `severity.{critical, high, medium, low, info, resolved, ack}` | Severity scale, **paired with shape / position** per UX role doc.        |
| `conn.{ok, stale, down}`                                      | Connection-state pill colors.                                            |

Typography: Inter sans + monospaced system stack. Tabular numerals enforced via `font-feature-settings`.

## Endpoints (Nuxt server)

This PR's shell has no server routes. Phase 2 may add a BFF for SSR data prefetch.

## Configuration

| Var                        | Default                           |
| -------------------------- | --------------------------------- |
| `NUXT_PUBLIC_API_BASE_URL` | `/api/v1` (proxied through NGINX) |
| `NUXT_PUBLIC_WS_BASE_URL`  | `/ws/v1` (proxied through NGINX)  |

## Local dev

```bash
pnpm --filter @aip/web dev
# → http://localhost:3000
```

## What's NOT here yet

- Live airport map (MapLibre) — T-211
- Live alert feed — T-212
- WebSocket integration with reconnect resume — T-213
- Incident timeline + playback — T-414
- Reviewer queue + decision UI — T-410
- Auth flow (JWT) — T-504
- Role-based routing — T-410 / T-504

## Why dark mode only

Per the UX role doc, the platform is intentionally **dark-mode-only**. Operator UIs run on 24"+ ops displays for hours; the high signal-to-noise palette is part of the operational credibility. Any future light-mode work needs a UX role-doc update first.
