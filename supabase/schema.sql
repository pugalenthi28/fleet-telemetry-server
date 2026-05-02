-- ─────────────────────────────────────────────────────────────────────────────
-- Fleet Telemetry Server — Supabase schema
-- Run this entire file once in the Supabase SQL Editor.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── fleet_vehicles ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fleet_vehicles (
  id           BIGSERIAL    PRIMARY KEY,
  vin          VARCHAR      NOT NULL UNIQUE,
  display_name VARCHAR,
  model        VARCHAR,
  year         INTEGER,
  color        VARCHAR,
  first_seen   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_seen    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE fleet_vehicles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fleet_vehicles_all" ON fleet_vehicles FOR ALL USING (true) WITH CHECK (true);

-- ── fleet_trips ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fleet_trips (
  id              BIGSERIAL    PRIMARY KEY,
  vin             VARCHAR      NOT NULL,
  start_time      TIMESTAMPTZ  NOT NULL,
  end_time        TIMESTAMPTZ,
  start_location  JSONB,
  end_location    JSONB,
  start_battery   INTEGER,
  end_battery     INTEGER,
  start_odometer  DOUBLE PRECISION,
  end_odometer    DOUBLE PRECISION,
  distance_miles  DOUBLE PRECISION,
  energy_used_kwh DOUBLE PRECISION,
  avg_speed       DOUBLE PRECISION,
  max_speed       DOUBLE PRECISION,
  status            VARCHAR      NOT NULL DEFAULT 'active',
  charge_accounted  BOOLEAN      DEFAULT NULL,  -- NULL = not yet counted toward a charge session
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_seen_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS fleet_trips_vin_start_time ON fleet_trips(vin, start_time DESC);

ALTER TABLE fleet_trips ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fleet_trips_all" ON fleet_trips FOR ALL USING (true) WITH CHECK (true);

-- ── fleet_charging_sessions ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fleet_charging_sessions (
  id                      BIGSERIAL    PRIMARY KEY,
  vin                     VARCHAR      NOT NULL,
  start_time              TIMESTAMPTZ  NOT NULL,
  end_time                TIMESTAMPTZ,
  start_battery           INTEGER,
  end_battery             INTEGER,
  start_range             DOUBLE PRECISION,
  end_range               DOUBLE PRECISION,
  energy_added_kwh        DOUBLE PRECISION,
  charge_rate_avg         DOUBLE PRECISION,
  charge_rate_max         DOUBLE PRECISION,
  duration_minutes        DOUBLE PRECISION,
  location                JSONB,
  status                  VARCHAR      NOT NULL DEFAULT 'active',
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  charger_power                      INTEGER,
  start_odometer                     DOUBLE PRECISION,
  miles_since_last_charge            DOUBLE PRECISION,
  end_odometer                       DOUBLE PRECISION,
  energy_used_since_last_charge_kwh  DOUBLE PRECISION  -- sum of trip kWh since previous charge
);

CREATE INDEX IF NOT EXISTS fleet_charging_sessions_vin_start_time
  ON fleet_charging_sessions(vin, start_time DESC);

ALTER TABLE fleet_charging_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fleet_charging_sessions_all" ON fleet_charging_sessions FOR ALL USING (true) WITH CHECK (true);

-- ── fleet_telemetry_data ───────────────────────────────────────────────────
-- Append-only row per message. Enable via ENABLE_TELEMETRY_EVENTS=true env var.
CREATE TABLE IF NOT EXISTS fleet_telemetry_data (
  id                   BIGSERIAL    PRIMARY KEY,
  vin                  VARCHAR      NOT NULL,
  recorded_at          TIMESTAMPTZ  NOT NULL,
  latitude             DOUBLE PRECISION,
  longitude            DOUBLE PRECISION,
  battery_level        INTEGER,
  usable_battery_level DOUBLE PRECISION,
  est_battery_range    DOUBLE PRECISION,
  charge_state         VARCHAR,
  charge_rate          DOUBLE PRECISION,
  charge_limit_soc     INTEGER,
  charge_port_door_open BOOLEAN,
  speed                DOUBLE PRECISION,
  odometer             DOUBLE PRECISION,
  shift_state          VARCHAR,
  power                INTEGER,
  charger_power        INTEGER,
  raw_data             JSONB,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS fleet_telemetry_data_vin_recorded_at
  ON fleet_telemetry_data(vin, recorded_at DESC);

ALTER TABLE fleet_telemetry_data ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fleet_telemetry_data_all" ON fleet_telemetry_data FOR ALL USING (true) WITH CHECK (true);

-- ── fleet_telemetry_state ─────────────────────────────────────────────────
-- Latest merged state per VIN — upserted on every message (dashboard use).
CREATE TABLE IF NOT EXISTS fleet_telemetry_state (
  vin                       VARCHAR      PRIMARY KEY,
  updated_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  gear                      VARCHAR,
  vehicle_speed_mph         DOUBLE PRECISION,
  odometer_mi               DOUBLE PRECISION,
  miles_since_reset         DOUBLE PRECISION,
  soc_pct                   DOUBLE PRECISION,
  battery_level_pct         DOUBLE PRECISION,
  pack_voltage_v            DOUBLE PRECISION,
  pack_current_a            DOUBLE PRECISION,
  energy_remaining_kwh      DOUBLE PRECISION,
  rated_range_mi            DOUBLE PRECISION,
  est_battery_range_mi      DOUBLE PRECISION,
  ideal_battery_range_mi    DOUBLE PRECISION,
  lifetime_energy_used_kwh  DOUBLE PRECISION,
  lifetime_energy_regen_kwh DOUBLE PRECISION,
  detailed_charge_state     VARCHAR,
  charge_amps               DOUBLE PRECISION,
  charger_voltage_v         DOUBLE PRECISION,
  ac_charging_power_kw      DOUBLE PRECISION,
  dc_charging_power_kw      DOUBLE PRECISION,
  charge_limit_soc_pct      DOUBLE PRECISION,
  time_to_full_charge_h     DOUBLE PRECISION,
  fast_charger_present      BOOLEAN,
  charge_port_door_open     BOOLEAN,
  inside_temp_c             DOUBLE PRECISION,
  outside_temp_c            DOUBLE PRECISION,
  locked                    BOOLEAN,
  sentry_mode               VARCHAR,
  vehicle_name              VARCHAR,
  software_version          VARCHAR,
  raw_state                 JSONB
);

ALTER TABLE fleet_telemetry_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fleet_telemetry_state_all" ON fleet_telemetry_state FOR ALL USING (true) WITH CHECK (true);

-- ── fleet_daily_summary ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fleet_daily_summary (
  id                     BIGSERIAL   PRIMARY KEY,
  vin                    VARCHAR     NOT NULL,
  date                   DATE        NOT NULL,
  total_miles            DOUBLE PRECISION DEFAULT 0,
  total_energy_used_kwh  DOUBLE PRECISION DEFAULT 0,
  total_energy_added_kwh DOUBLE PRECISION DEFAULT 0,
  num_trips              INTEGER          DEFAULT 0,
  num_charges            INTEGER          DEFAULT 0,
  avg_efficiency         DOUBLE PRECISION,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (vin, date)
);

CREATE INDEX IF NOT EXISTS fleet_daily_summary_vin_date
  ON fleet_daily_summary(vin, date DESC);

ALTER TABLE fleet_daily_summary ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fleet_daily_summary_all" ON fleet_daily_summary FOR ALL USING (true) WITH CHECK (true);
