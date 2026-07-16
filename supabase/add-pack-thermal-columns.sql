-- Pack electrical + thermal extremes (run once in Supabase SQL Editor)
-- PackVoltage/PackCurrent columns already exist; these add module/brick extremes.
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
