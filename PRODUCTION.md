# Production Deployment Guide

## Infrastructure Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| Backend host | Render Starter ($7/mo) | Render Standard ($25/mo) |
| PostgreSQL | Render Postgres Basic | Managed DB with auto-backup |
| RAM | 512 MB | 1 GB+ |
| Node.js | 20.x | 20.x LTS |

> **Free tier is not suitable for production POS.** Render free tier has 512 MB RAM,
> spins down after inactivity, and has no SLA. Use a paid instance.

## Required Environment Variables

All must be set in your deployment environment before starting the server.
**None have hardcoded defaults.**

| Variable | Description | Notes |
|----------|-------------|-------|
| `DATABASE_URL` | PostgreSQL connection string | Use a managed DB with SSL |
| `JWT_SECRET` | Token signing secret | 64+ random chars; **do not rotate** unless planned |
| `FRONTEND_URL` | CORS-allowed origin(s) | Comma-separated for multiple |
| `COOKIE_SAME_SITE` | Cookie policy | `none` for cross-origin (Vercel+Render); `lax` for same-domain |
| `ADMIN_EMAIL` | Initial admin email | Only used on first deploy if user does not exist |
| `ADMIN_PASSWORD` | Initial admin password | Only used on first deploy; never overwritten after |
| `ADMIN_ONBOARD_SECRET` | Passphrase for creating more ADMINs | Keep secret |
| `CLOUDINARY_CLOUD_NAME` | Image hosting | Required if product photos are used |
| `CLOUDINARY_API_KEY` | Image hosting | Required if product photos are used |
| `CLOUDINARY_API_SECRET` | Image hosting | Required if product photos are used |
| `NODE_ENV` | Runtime mode | Must be `production` |
| `PORT` | HTTP listen port | Default: 4000 |

## Pre-deployment Checklist

- [ ] Set all required env vars in your deployment secrets vault
- [ ] JWT_SECRET is a stable, strong secret — not auto-generated
- [ ] ADMIN_EMAIL and ADMIN_PASSWORD are set for first-deploy bootstrap
- [ ] COOKIE_SAME_SITE=none if frontend (Vercel) and backend (Render) are on different domains
- [ ] Run migrations before starting: `npx prisma migrate deploy`
- [ ] Build passes: `npm run build`
- [ ] Tests pass: `npm test` (with test DATABASE_URL)

## Deploy Steps (Render)

1. Push your branch to GitHub
2. Render detects the push, runs the build command:
   ```
   npm install --include=dev && npx prisma generate && npm run build && npx prisma migrate deploy
   ```
3. Render starts the app with: `npm start`
4. On first start, if ADMIN_EMAIL and ADMIN_PASSWORD are set, the initial admin is created

## JWT Secret Policy

- Generate once: `openssl rand -base64 64`
- Store in your deployment secrets — never in the repository
- **Do not change** JWT_SECRET without a maintenance window (all users will be logged out)
- If a secret rotation is required, coordinate with the team and communicate the expected logout

## Cookie Configuration

For cross-origin deployments (Vercel frontend + Render backend):
```
COOKIE_SAME_SITE=none
```
This requires `secure: true` which is automatic in production.

For same-domain deployments:
```
COOKIE_SAME_SITE=lax
```

## Database Backups

- Enable automatic daily backups on your managed PostgreSQL provider
- Keep at least 7 days of backups
- Test restore procedure before go-live

## Monitoring and Logging

- Configure a log drain on Render to capture structured JSON logs (Winston)
- Set up uptime checks for `GET /api/health`
- Monitor for 5xx error rates — particularly around bulk price updates and sync push

## AFIP Status

AFIP electronic invoicing is **not implemented**. Internal receipts are internal documents only.
They are not legal fiscal invoices for Argentina's AFIP system.

Do not configure AFIP-facing features until the WSFEv1 integration is complete and tested
in the AFIP sandbox environment.

## Pilot Readiness Verdict

This system is suitable for a **controlled pilot** when:
- [ ] Backend build passes
- [ ] Frontend build passes
- [ ] All tests pass
- [ ] Migrations applied to production DB
- [ ] ADMIN_EMAIL and ADMIN_PASSWORD configured (no default credentials)
- [ ] JWT_SECRET is a stable, manually-set secret
- [ ] COOKIE_SAME_SITE=none for cross-origin deployment
- [ ] Health endpoint responds: `GET /api/health → 200`
- [ ] AFIP labeled as pending in UI and docs
- [ ] Staff trained on offline conflict resolution workflow

---

# Operations Runbook

Day-2 operations: what to check, how to recover, and how to rotate secrets.

## Continuous Integration

Both repositories run GitHub Actions on every push and pull request to `main`
(`.github/workflows/ci.yml`). A red check means the change is **not safe to deploy** —
fix it before merging.

| Repo | Checks |
|------|--------|
| Backend | `prisma generate` · `tsc --noEmit` · `prisma db push` (ephemeral Postgres) · `npm test` (Jest integration) |
| Frontend | `eslint` · `vitest run` (RBAC + POS money math) · `tsc -b && vite build` |

Hosting auto-deploys (Render/Vercel) are independent of CI. CI is the **gate that
tells you a deploy is risky** — treat a red pipeline as a deploy blocker.

## Error tracking & observability

- The frontend has an app-wide **React error boundary**: a render crash shows a
  branded recovery screen (Recargar / Volver al inicio) instead of a white page.
- All caught errors flow through `src/core/observability/reportError.ts` (console today).
- To enable remote tracking, set `VITE_SENTRY_DSN` and load the Sentry SDK
  (`window.Sentry`); errors then forward automatically. No code change required.
- Backend logs are structured JSON (Winston). Configure a Render log drain to retain them.

## Health & uptime

- Liveness: `GET /api/health → 200` (no auth). Point UptimeRobot/BetterStack at it,
  1-minute interval. Alert on non-200 or >2s latency.
- A paid Render instance avoids cold-start 30–60s stalls that look like an outage.

## Incident response

**Symptom → first action:**

| Symptom | Check | Likely fix |
|---------|-------|------------|
| Site down / 502 | Render service logs; `GET /api/health` | Service crashed or sleeping → restart / upgrade off free tier |
| Login fails for everyone | Did `JWT_SECRET` change? | Restore the previous secret (rotating it logs everyone out) |
| CORS / cookie errors | `FRONTEND_URL`, `COOKIE_SAME_SITE` | Cross-origin needs `COOKIE_SAME_SITE=none` |
| 5xx on a mutation | Logs around `prisma` / validation | Check Zod 400s vs 500s; inspect the failing query |
| Sale/stock looks wrong | AuditLog + Movement rows | Sales are transactional; reconcile from the audit trail |

General loop: **check `/api/health` → read Render logs → identify the failing
endpoint → reproduce → fix → redeploy → verify the endpoint.**

## Database restore drill (do this BEFORE go-live)

Backups are only real once a restore has been tested.

1. On the managed Postgres provider, take/locate the latest automatic backup.
2. Restore it into a **separate** scratch database (never over production).
3. Point a local backend at it: `DATABASE_URL=<scratch> npm start`.
4. Verify row counts on `Sale`, `Payment`, `Stock` look sane and the app boots.
5. Record the restore time (RTO) and the backup age (RPO). Target: RPO ≤ 24h.
6. Drop the scratch database.

Bridge option until managed backups exist: run `scripts/backup-db.sh` on a daily
schedule (Render Cron Job or crontab). It writes a compressed `pg_dump` to
`BACKUP_DIR` and prunes to the last `RETENTION` copies. Restore with:
`gunzip -c <dump>.sql.gz | psql "$SCRATCH_DATABASE_URL"` (into a scratch DB first).

## Secret rotation

| Secret | When to rotate | Procedure |
|--------|----------------|-----------|
| `JWT_SECRET` | On suspected leak only | Maintenance window — rotating logs out every user. `openssl rand -base64 64` |
| `ADMIN_ONBOARD_SECRET` | Periodically | Update env var; no user impact |
| Cloudinary keys | On leak | Rotate in Cloudinary dashboard, update env vars |
| GitHub / Vercel deploy tokens | On leak or staff change | Revoke in provider, re-add. **Never commit a token into a git remote URL.** |

After rotating any env var on Render, trigger a redeploy so the new value loads.
