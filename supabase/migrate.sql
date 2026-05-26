-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: rename non-fleet_ tables + add range columns to charging sessions
-- Run this once in the Supabase SQL Editor on existing databases.
-- New installs should use schema.sql directly (already has correct names).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Rename app_auth_tokens → fleet_auth_tokens ────────────────────────────
ALTER TABLE IF EXISTS app_auth_tokens RENAME TO fleet_auth_tokens;
ALTER POLICY "app_auth_tokens_all" ON fleet_auth_tokens RENAME TO "fleet_auth_tokens_all";

-- ── 2. Rename software_versions → fleet_software_versions ────────────────────
ALTER TABLE IF EXISTS software_versions RENAME TO fleet_software_versions;

-- Re-create the unique constraint with the new name (old one is dropped with the rename).
ALTER TABLE fleet_software_versions
  DROP CONSTRAINT IF EXISTS software_versions_vin_version_key,
  ADD  CONSTRAINT fleet_software_versions_vin_version_key UNIQUE (vin, current_version);

-- ── 3. Add end_ideal_range_mi / end_rated_range_mi to fleet_charging_sessions ─
ALTER TABLE fleet_charging_sessions
  ADD COLUMN IF NOT EXISTS end_ideal_range_mi DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS end_rated_range_mi DOUBLE PRECISION;
