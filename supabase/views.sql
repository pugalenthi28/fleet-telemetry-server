-- ─────────────────────────────────────────────────────────────────────────────
-- Fleet Telemetry Server — Grafana compatibility views
-- Run this in the Supabase SQL Editor after schema.sql.
-- These views let existing dashboard queries work unchanged by mapping the
-- old polling-DB table/column names to the new fleet_ telemetry tables.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── telemetry_data ────────────────────────────────────────────────────────────
-- Old dashboards use `timestamp` column; new table uses `recorded_at`.
CREATE OR REPLACE VIEW telemetry_data AS
SELECT
  id,
  vin,
  recorded_at                         AS timestamp,
  recorded_at,
  latitude,
  longitude,
  gps_heading,
  speed,
  odometer,
  miles_since_reset,
  shift_state,
  battery_level,
  usable_battery_level,
  pack_voltage_v,
  pack_current_a,
  energy_remaining_kwh,
  est_battery_range,
  rated_range_mi,
  ideal_range_mi,
  charge_state,
  charge_amps,
  charger_voltage_v,
  ac_charging_power_kw,
  dc_charging_power_kw,
  charge_rate,
  charger_power,
  charge_limit_soc,
  time_to_full_charge_h,
  fast_charger_present,
  charge_port_door_open,
  inside_temp_c,
  outside_temp_c,
  locked,
  sentry_mode,
  software_version,
  power,
  raw_data,
  created_at,
  cut_off
FROM fleet_telemetry_data;

-- ── trips ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW trips AS
SELECT * FROM fleet_trips;

-- ── charging_sessions ─────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW charging_sessions AS
SELECT * FROM fleet_charging_sessions;

-- ─────────────────────────────────────────────────────────────────────────────
-- CUTOVER — run once when switching from polling DB to telemetry as primary.
-- Changes the default so all new inserts are marked cut_off = true.
-- Existing parallel-period rows stay false intentionally.
-- ─────────────────────────────────────────────────────────────────────────────
-- ALTER TABLE fleet_trips             ALTER COLUMN cut_off SET DEFAULT true;
-- ALTER TABLE fleet_charging_sessions ALTER COLUMN cut_off SET DEFAULT true;
-- ALTER TABLE fleet_telemetry_data    ALTER COLUMN cut_off SET DEFAULT true;
-- ALTER TABLE fleet_daily_summary     ALTER COLUMN cut_off SET DEFAULT true;
