-- Add permissionsJson column to User table for custom role permission overrides
-- JSON: { "grant": ["perm_key_1", ...], "deny": ["perm_key_2", ...] }

ALTER TABLE "User" ADD COLUMN "permissionsJson" TEXT;
