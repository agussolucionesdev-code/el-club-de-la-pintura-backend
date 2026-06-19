# SaaS Multi-Tenancy — Design Guardrails (not yet built)

This document is **design-only**. Multi-tenancy is **not implemented** and must not
be built speculatively. Its purpose is to keep current work from closing the door on
reusing this codebase as a multi-store SaaS later (other paint shops, with billing).

When writing new code today, follow the guardrails below so the eventual tenant layer
is an additive change, not a rewrite.

## Where we are today (single tenant)

- Everything is already **branch-scoped**: `Sale`, `Payment`, `Stock`, `Movement`,
  `Expense`, `CashRegister`, `Employee`, etc. all carry `branchId`, and access is gated
  by `authorizeBranchAccess` + the user's `branchIds`.
- A `Branch` is the operational unit (e.g. Lomas de Zamora, Temperley). Both belong to
  one implicit organization — **the single client**.
- Roles are global strings: `ADMIN | ENCARGADO | EMPLOYEE`.
- Several things are hardcoded to this one client: admin bootstrap (`app.ts`),
  `ADMIN_ONBOARD_SECRET`, and brand assets on the frontend (logo, colors, copy).

The key insight: **`Branch` is to a store what `Organization`/`Tenant` will be to a
customer.** Today one customer owns all branches. Tomorrow each customer owns a subset.

## Target model (future)

```
Organization (tenant)  1───∞  Branch  1───∞  {Sale, Stock, CashRegister, ...}
       │
       └──∞ User (scoped to one organization)
```

Add an `Organization` table; give `Branch` and `User` an `organizationId`. Every
business query then filters by the caller's `organizationId` **in addition to**
`branchId`. Because data is already branch-scoped, this is a containment layer on top,
not a re-model.

## Guardrails for code written NOW

1. **Never introduce global singletons for business data.** No "the company", no
   module-level caches keyed by a single store. Scope by `branchId` (and, later,
   `organizationId`). New tables that hold business data should carry `branchId`.
2. **Keep tenant-derivable context in the request, not in globals.** Branch/org scope
   must come from the authenticated user (`req.user.branchIds`), exactly as today —
   never from a hardcoded constant.
3. **Don't hardcode single-tenant assumptions.** Avoid literal branch ids, the client's
   name, or "there is only one admin" logic in new code paths.
4. **Parametrize what is currently hardcoded** (defer the work, but isolate it so it's
   swappable later):
   - Admin bootstrap (`app.ts`) → per-organization onboarding.
   - `ADMIN_ONBOARD_SECRET` → per-organization invite/onboarding token.
   - Frontend brand assets (logo, palette, copy) → a theme/config object, so a tenant's
     branding is data, not code.
5. **RBAC stays role-based but will gain an org dimension.** Keep using
   `hasPermission(role, permission)`; later, resolve the role **within the caller's
   organization**. Don't bake cross-tenant assumptions into permission checks.
6. **Indexes already help.** The Phase-1 hot-path indexes lead with `branchId`; an
   `organizationId` column would extend, not replace, them.

## Explicitly out of scope (do NOT build now)

- The `Organization` table / migration and the `organizationId` columns.
- Tenant resolution middleware.
- Billing & plans (Stripe / MercadoPago), metering, invoicing of the SaaS itself.
- Self-service signup / tenant provisioning.
- Per-tenant theming UI.

## Migration path sketch (for when it's greenlit)

1. Add `Organization`; backfill a single org for the current client.
2. Add nullable `organizationId` to `Branch` and `User`; backfill; then make non-null.
3. Add tenant-scope middleware that injects `organizationId` from the user and filters
   every business query by it.
4. Move bootstrap, onboarding secret, and brand assets to per-organization config.
5. Only then: billing and self-service onboarding.

Keeping new code aligned with guardrails 1–6 makes steps 1–3 mechanical instead of a
rewrite.
