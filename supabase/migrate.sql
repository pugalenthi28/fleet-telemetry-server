-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: rename non-fleet_ tables + add range/source columns
-- Run this once in the Supabase SQL Editor on existing databases.
-- New installs should use schema.sql directly (already has correct names).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Rename app_auth_tokens → fleet_auth_tokens ────────────────────────────
ALTER TABLE IF EXISTS app_auth_tokens RENAME TO fleet_auth_tokens;
ALTER POLICY "app_auth_tokens_all" ON fleet_auth_tokens RENAME TO "fleet_auth_tokens_all";

-- ── 2. Rename software_versions → fleet_software_versions ────────────────────
ALTER TABLE IF EXISTS software_versions RENAME TO fleet_software_versions;

ALTER TABLE fleet_software_versions
  DROP CONSTRAINT IF EXISTS software_versions_vin_version_key,
  ADD  CONSTRAINT fleet_software_versions_vin_version_key UNIQUE (vin, current_version);

-- ── 3. Add end_ideal_range_mi / end_rated_range_mi to fleet_charging_sessions ─
ALTER TABLE fleet_charging_sessions
  ADD COLUMN IF NOT EXISTS end_ideal_range_mi DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS end_rated_range_mi DOUBLE PRECISION;

-- ── 4. Add source column to all tables (existing rows default to 'SUPA') ──────
ALTER TABLE fleet_vehicles           ADD COLUMN IF NOT EXISTS source VARCHAR NOT NULL DEFAULT 'SUPA';
ALTER TABLE fleet_trips              ADD COLUMN IF NOT EXISTS source VARCHAR NOT NULL DEFAULT 'SUPA';
ALTER TABLE fleet_charging_sessions  ADD COLUMN IF NOT EXISTS source VARCHAR NOT NULL DEFAULT 'SUPA';
ALTER TABLE fleet_telemetry_data     ADD COLUMN IF NOT EXISTS source VARCHAR NOT NULL DEFAULT 'SUPA';
ALTER TABLE fleet_telemetry_state    ADD COLUMN IF NOT EXISTS source VARCHAR NOT NULL DEFAULT 'SUPA';
ALTER TABLE fleet_daily_summary      ADD COLUMN IF NOT EXISTS source VARCHAR NOT NULL DEFAULT 'SUPA';
ALTER TABLE fleet_auth_tokens        ADD COLUMN IF NOT EXISTS source VARCHAR NOT NULL DEFAULT 'SUPA';
ALTER TABLE fleet_software_versions  ADD COLUMN IF NOT EXISTS source VARCHAR NOT NULL DEFAULT 'SUPA';
ALTER TABLE fleet_api_tracking       ADD COLUMN IF NOT EXISTS source VARCHAR NOT NULL DEFAULT 'SUPA';

-- All existing rows in Supabase are already stamped 'SUPA' via the DEFAULT above.
-- Rows migrated from Neon will be inserted with source = 'NEON' by the migration script.

-- ── 5. Drop LifetimeEnergyGainedRegen tracking (collected but never surfaced in any
--       Grafana panel — dropping it also removes a billable Tesla telemetry signal),
--       and add SelfDrivingMilesSinceReset (paired with the existing but previously
--       unwired MilesSinceReset column to compute an FSD-usage-% metric) ───────────
ALTER TABLE fleet_telemetry_state ADD COLUMN IF NOT EXISTS self_driving_miles_since_reset DOUBLE PRECISION;
ALTER TABLE fleet_telemetry_state DROP COLUMN IF EXISTS lifetime_energy_regen_kwh;
ALTER TABLE fleet_telemetry_data  ADD COLUMN IF NOT EXISTS self_driving_miles_since_reset DOUBLE PRECISION;
ALTER TABLE fleet_telemetry_data  DROP COLUMN IF EXISTS lifetime_energy_regen_kwh;
ALTER TABLE fleet_trips           DROP COLUMN IF EXISTS start_lifetime_energy_regen_kwh;
ALTER TABLE fleet_trips           DROP COLUMN IF EXISTS end_lifetime_energy_regen_kwh;
