# ADR 0001: Monorepo layout, Tailwind v4 design tokens, and Phase 0 static shell

- **Status:** Accepted
- **Date:** 2026-11-04
- **References:** `PRD.md` §6.2–6.4, `DESIGN.md` §3–6, `AGENTS.md` §6–13

## Context

ADAS CRM is a modular monolith in a single TypeScript pnpm workspace (`apps/web`, `apps/api`, `packages/shared`, `packages/config`). Phase 0 establishes the repository structure, strict TypeScript/ESLint module boundaries, environment validation with `zod`, design tokens from `adasglobuspro.com` (`DESIGN.md`), and the static application shell for owner sign-off before Phase 1 database and authentication work begins.

## Decisions

1. **Module-boundary enforcement in ESLint:** `eslint-plugin-boundaries` and `no-restricted-imports` enforce that `apps/api/src/platform/**` never imports from `apps/api/src/modules/**`, and business modules only import other modules through their public `index.ts`.
2. **Self-hosted Hanken Grotesk:** Installed via `@fontsource-variable/hanken-grotesk` (and `@fontsource/hanken-grotesk` fallback weights) so the internal CRM never makes runtime requests to Google Fonts (`DESIGN.md` §4).
3. **Tailwind CSS v4 + CSS variable tokens:** `apps/web/src/styles/tokens.css` defines the exact token palette from `DESIGN.md` §3, and `apps/web/src/styles/app.css` maps shadcn/ui and Tailwind v4 `@theme inline` tokens without clashing `--accent` (hover fill) with `--blue` (brand focus/link blue).
4. **Dev login compilation guard:** The development sign-in helper is gated behind `NODE_ENV !== 'production'` on the API and `import.meta.env.PROD` on the web app, with unit tests verifying that production builds reject dev login (`AGENTS.md` §6).
