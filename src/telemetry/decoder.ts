import protobuf from "protobufjs";
import path from "path";
import { TelemetryRecord } from "./store";

const PROTO_PATH = path.resolve(__dirname, "../../protos/vehicle_data.proto");

let payloadType: protobuf.Type;

async function loadProto() {
  if (payloadType) return;
  // protobufjs resolves google/protobuf/timestamp.proto from its bundled well-known types
  const root = await protobuf.load(PROTO_PATH);
  payloadType = root.lookupType("telemetry.vehicle_data.Payload");
}

export async function decodePayload(rawBuffer: Buffer): Promise<TelemetryRecord> {
  await loadProto();

  const message = payloadType.decode(rawBuffer);
  const obj = payloadType.toObject(message, {
    longs: Number,
    enums: String,
    bytes: Buffer,
    defaults: false,
    oneofs: true, // adds oneof discriminator so 0-valued fields aren't silently dropped
  }) as {
    vin: string;
    createdAt: { seconds: number; nanos: number } | number;
    isResend: boolean;
    data: Array<{ key: string; value: Record<string, unknown> & { value?: string } }>;
  };

  // created_at is now a google.protobuf.Timestamp { seconds, nanos }
  let createdAt: number;
  if (typeof obj.createdAt === "object" && obj.createdAt !== null) {
    createdAt = (obj.createdAt.seconds ?? 0) * 1000;
  } else {
    createdAt = obj.createdAt ?? Date.now();
  }

  const fields: Record<string, unknown> = {};
  for (const datum of obj.data ?? []) {
    const fieldName = datum.key;
    const valueObj = datum.value ?? {};
    // oneofs:true adds a discriminator key "value" naming which oneof field is set.
    // Use it to look up the actual value — this handles the case where the field value
    // is 0.0 (default float), which defaults:false would otherwise drop entirely.
    const activeField = valueObj.value as string | undefined;
    if (!activeField) continue;
    // "invalid" means the vehicle could not determine the value — skip
    if (activeField === "invalid" || activeField === "invalidValue") continue;
    const val = activeField in valueObj ? valueObj[activeField] : 0;
    fields[fieldName] = val;
  }

  return {
    vin: obj.vin ?? "unknown",
    txid: `${obj.vin}-${createdAt}`,
    createdAt,
    fields,
  };
}
