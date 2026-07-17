-- Profile photo for each user account.
-- Strictly additive and idempotent: the column is nullable with no default, so
-- existing rows keep working untouched (null = fall back to the initial).
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT;
