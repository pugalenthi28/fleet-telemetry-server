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

-- ── 6. Add BMSState tracking (trips + charging sessions) and ChargingCableType /
--       FastChargerType (charging sessions only) — plain passthrough columns, no
--       derived logic attached ──────────────────────────────────────────────────
ALTER TABLE fleet_trips              ADD COLUMN IF NOT EXISTS start_bms_state VARCHAR;
ALTER TABLE fleet_trips              ADD COLUMN IF NOT EXISTS end_bms_state   VARCHAR;
ALTER TABLE fleet_charging_sessions  ADD COLUMN IF NOT EXISTS start_bms_state     VARCHAR;
ALTER TABLE fleet_charging_sessions  ADD COLUMN IF NOT EXISTS end_bms_state       VARCHAR;
ALTER TABLE fleet_charging_sessions  ADD COLUMN IF NOT EXISTS charging_cable_type VARCHAR;
ALTER TABLE fleet_charging_sessions  ADD COLUMN IF NOT EXISTS fast_charger_type   VARCHAR;

-- ── 7. Trim the Pacific-time trigger down to fleet_trips.start_time_pst/end_time_pst
--       only — the sole two *_pst columns any Grafana panel actually queries. Drop
--       order matters: the 6 non-fleet_trips triggers must be dropped BEFORE the
--       function is replaced, otherwise the old triggers (still attached) would fire
--       the new simplified body — which references NEW.start_time/NEW.end_time — on
--       tables that don't have those columns (e.g. fleet_vehicles), erroring on the
--       very next insert/update to any of them ─────────────────────────────────────
DROP TRIGGER IF EXISTS tr_pst_fleet_vehicles          ON fleet_vehicles;
DROP TRIGGER IF EXISTS tr_pst_fleet_charging_sessions ON fleet_charging_sessions;
DROP TRIGGER IF EXISTS tr_pst_fleet_telemetry_data    ON fleet_telemetry_data;
DROP TRIGGER IF EXISTS tr_pst_fleet_telemetry_state   ON fleet_telemetry_state;
DROP TRIGGER IF EXISTS tr_pst_fleet_daily_summary     ON fleet_daily_summary;
DROP TRIGGER IF EXISTS tr_pst_fleet_software_versions ON fleet_software_versions;

CREATE OR REPLACE FUNCTION public.sync_pst_timestamps()
RETURNS TRIGGER AS $$
BEGIN
  NEW.start_time_pst := NEW.start_time AT TIME ZONE 'America/Los_Angeles';
  NEW.end_time_pst   := NEW.end_time   AT TIME ZONE 'America/Los_Angeles';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE fleet_vehicles           DROP COLUMN IF EXISTS first_seen_pst;
ALTER TABLE fleet_vehicles           DROP COLUMN IF EXISTS last_seen_pst;
ALTER TABLE fleet_trips              DROP COLUMN IF EXISTS created_at_pst;
ALTER TABLE fleet_trips              DROP COLUMN IF EXISTS last_seen_at_pst;
ALTER TABLE fleet_charging_sessions  DROP COLUMN IF EXISTS start_time_pst;
ALTER TABLE fleet_charging_sessions  DROP COLUMN IF EXISTS end_time_pst;
ALTER TABLE fleet_charging_sessions  DROP COLUMN IF EXISTS created_at_pst;
ALTER TABLE fleet_telemetry_data     DROP COLUMN IF EXISTS recorded_at_pst;
ALTER TABLE fleet_telemetry_data     DROP COLUMN IF EXISTS created_at_pst;
ALTER TABLE fleet_telemetry_state    DROP COLUMN IF EXISTS updated_at_pst;
ALTER TABLE fleet_daily_summary       DROP COLUMN IF EXISTS created_at_pst;
ALTER TABLE fleet_software_versions  DROP COLUMN IF EXISTS update_time_pst;

-- ── 8. Drop start_tpms_*_bar from fleet_trips — no panel queries the start-of-trip
--       reading, only end_tpms_*_bar (panel-27 "TPMS" timeseries). Tire pressure
--       barely moves within a single trip anyway; the trend signal lives in the
--       end_ values across trips, not a per-trip start/end delta ──────────────────
ALTER TABLE fleet_trips DROP COLUMN IF EXISTS start_tpms_fl_bar;
ALTER TABLE fleet_trips DROP COLUMN IF EXISTS start_tpms_fr_bar;
ALTER TABLE fleet_trips DROP COLUMN IF EXISTS start_tpms_rl_bar;
ALTER TABLE fleet_trips DROP COLUMN IF EXISTS start_tpms_rr_bar;

-- ── 9. Drop cut_off and source — neither is read or written anywhere in
--       application code (src/), and no Grafana panel queries either one.
--       `source` distinguished native Supabase rows ('SUPA') from rows carried
--       over by scripts/migrate-from-neon.ts ('NEON'); that one-time migration
--       has already run, so the distinction no longer serves a purpose ────────
ALTER TABLE fleet_vehicles           DROP COLUMN IF EXISTS source;
ALTER TABLE fleet_trips              DROP COLUMN IF EXISTS cut_off;
ALTER TABLE fleet_trips              DROP COLUMN IF EXISTS source;
ALTER TABLE fleet_charging_sessions  DROP COLUMN IF EXISTS cut_off;
ALTER TABLE fleet_charging_sessions  DROP COLUMN IF EXISTS source;
ALTER TABLE fleet_telemetry_data     DROP COLUMN IF EXISTS cut_off;
ALTER TABLE fleet_telemetry_data     DROP COLUMN IF EXISTS source;
ALTER TABLE fleet_telemetry_state    DROP COLUMN IF EXISTS source;
ALTER TABLE fleet_daily_summary      DROP COLUMN IF EXISTS cut_off;
ALTER TABLE fleet_daily_summary      DROP COLUMN IF EXISTS source;
ALTER TABLE fleet_auth_tokens        DROP COLUMN IF EXISTS source;
ALTER TABLE fleet_software_versions  DROP COLUMN IF EXISTS source;
ALTER TABLE fleet_api_tracking       DROP COLUMN IF EXISTS source;

-- ── 10. Pack electrical + thermal extremes for battery health metrics ────────
--       PackVoltage/PackCurrent columns already exist on both tables but were
--       never written; ModuleTemp*/BrickVoltage* are new. After deploy, re-push
--       fleet_telemetry_config so the vehicle starts streaming these fields.
ALTER TABLE fleet_telemetry_data
  ADD COLUMN IF NOT EXISTS module_temp_max_c   DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS module_temp_min_c   DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS brick_voltage_max_v DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS brick_voltage_min_v DOUBLE PRECISION;

ALTER TABLE fleet_telemetry_state
  ADD COLUMN IF NOT EXISTS module_temp_max_c   DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS module_temp_min_c   DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS brick_voltage_max_v DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS brick_voltage_min_v DOUBLE PRECISION;
