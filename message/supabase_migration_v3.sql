-- Migration v3: Add public_key column for ECDH E2E encryption
-- Run this in the Supabase SQL Editor before deploying the updated app.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS public_key TEXT;

-- Optional: index for fast lookups when fetching a friend's public key
CREATE INDEX IF NOT EXISTS profiles_public_key_idx ON profiles (id) WHERE public_key IS NOT NULL;
