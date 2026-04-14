# Project TODO

Update: reflect current tracked todo list and mark progress from the production audit.
 
## Todo List

- [x] Validate DEFAULT_SYMBOLS at startup
- [ ] Database & Migrations audit (in-progress)
- [ ] Trading engine audit
- [ ] Risk engine audit
- [ ] Strategy system audit
- [ ] Audit & logging audit
- [ ] Infrastructure & deployment audit
- [ ] Produce remediation SQL/code patches
- [ ] Add CI migration validation checks
- [ ] Final report & handoff

## Verified fixes (from audit) — action items

High priority
- [ ] Route-level code splitting: convert top-level static imports to dynamic imports to reduce main chunk size and TTI. Files: `app/dashboard/page.tsx`, `app/dashboard/trades/page.tsx`, `app/dashboard/markets/page.tsx`.
- [ ] `markets` page extraction: extract `OtpModal`, `ConnectedCard`, `ExchangeForm`, `ExchangeRow` into separate components/files and lazy-load them. File: `app/dashboard/markets/page.tsx`.
- [ ] `hasAccess` cookie precedence: avoid old `user_session` cookie blocking a fresh NextAuth token. Prefer token or validate cookie age. File: `middleware.ts`.
- [ ] Missing CSP headers: add CSP via `headers()` or middleware. File: `next.config.js` (or create a `middleware` header rule).

Medium priority
- [ ] Modal state causes full `BotControls` re-renders: move modal state out of the per-market render path (portal or controller) so opening a modal doesn't re-render all market buttons. File: `components/dashboard/bot-controls.tsx`.
- [ ] Stabilize `perMarketOpenTrades` fallback to avoid creating a new `{}` every render; use `useMemo` or a stable ref. File: `components/dashboard/bot-controls.tsx`.
- [ ] `['me']` staleTime Infinity / logout invalidation: either remove `staleTime: Infinity` or ensure `/api/logout` calls `qc.invalidateQueries(['me'])` and client clears the cache. Files: `components/dashboard/mode-controls.tsx`, `components/dashboard/topbar.tsx`, `app/api/logout/route.ts`.
- [ ] Unify `refetchInterval` for market modes (provider vs consumer). Make a central constant or rely on provider defaults. Files: `components/dashboard/mode-controls.tsx`, `components/providers.tsx`.
- [ ] No lazy loading of heavy libs/components: dynamically import heavy charts and libraries (e.g., recharts/date-fns). Files: `app/dashboard/trades/page.tsx`, `app/dashboard/page.tsx`.

Low priority / Nice-to-have
- [ ] Giant components: further split `BotControls` (~700 lines) and `StrategySettings` (~800 lines) into smaller components for maintainability and testing. Files: `components/dashboard/bot-controls.tsx`, `components/dashboard/strategy-settings.tsx`.
- [ ] Replace inline style object pattern in auth pages: move `S = { ... }` to module-level constants or CSS. File: `app/(auth)/access/page.tsx`.
- [ ] Replace ad-hoc query key string literals with central `lib/query-keys.ts` constants across the repo (codemod). File: `lib/query-keys.ts` and usage sites.
- [ ] Centralize polling strategy to reduce Neon pressure; consider switching high-frequency status to websocket or SSE if feasible. Files: `lib/use-bot-status-query.ts`, `components/providers.tsx`.
- [ ] `now` captured once in `BotHistory` (durations stale): add ticking `now` via a clock hook or per-row timers. File: `app/dashboard/bot-history/page.tsx`.

Already implemented / partially implemented (no immediate action required)
- [x] `isFiringRef` reset checks and mutation onSettled handlers verified and present in `components/dashboard/bot-controls.tsx`.
- [x] `lockedActions` ref change to avoid re-renders (migrated to `lockedActionsRef`) in `components/dashboard/bot-controls.tsx`.
- [x] `TradeTable` typed interface added (`components/dashboard/trade-table.tsx`).
- [x] `providers`: `placeholderData` logic updated to avoid showing stale financial data (`components/providers.tsx`).
- [x] `useBotStatusQuery` poll tuning (8s while running, 15s otherwise) to reduce DB pressure (`lib/use-bot-status-query.ts`).
- [x] Replace remaining client-side raw `fetch()` calls with the central `apiFetch()` wrapper across client components. (Examples: `components/dashboard/bot-controls.tsx`, `components/dashboard/strategy-settings.tsx`, `app/dashboard/markets/page.tsx`, various hooks)
- [x] Extract OTP/reveal modal network logic into hooks: `lib/hooks/use-exchange-otp.ts` and `lib/hooks/use-mode-otp.ts`. Updated `components/modals/otp-modal.tsx`, `components/modals/mode-otp-modal.tsx`, and `app/dashboard/markets/page.tsx` to use the hooks and new `onVerified(data?)` flow.
- [x] Add explicit response typings and fix missing `apiFetch` imports across multiple files to resolve TypeScript errors; production build now succeeds.
- [x] Extract Recharts charts from `app/dashboard/performance/page.tsx` into a dynamically imported component: `components/charts/performance-charts.tsx` (reduces initial bundle size).

Notes
- Mark each task with an owner and PR link when assigning.
- For high-impact items (route splitting, markets extraction, modal extraction, `hasAccess` cookie fix, CSP), create small focused PRs that include tests or smoke-checks.

Generated/updated by the audit assistant on 2026-04-11.
## Notes

- Items marked `[x]` are completed.
- Items marked `[ ]` are pending.
- The `Database & Migrations audit` task is currently in-progress and tracked in CI/automation.

Generated/updated by the audit assistant on 2026-04-11.
 