import protobuf from "protobufjs";
import path from "path";
import { TelemetryRecord } from "./store";

const PROTO_PATH = path.resolve(__dirname, "../../protos/vehicle_data.proto");

let payloadType: protobuf.Type;

async function loadProto() {
  if (payloadType) return;
  const root = await protobuf.load(PROTO_PATH);
  payloadType = root.lookupType("telemetry.Payload");
}

export async function decodePayload(rawBuffer: Buffer): Promise<TelemetryRecord> {
  await loadProto();

  const message = payloadType.decode(rawBuffer);
  const obj = payloadType.toObject(message, {
    longs: Number,
    enums: String,
    bytes: Buffer,
    defaults: false,
  }) as {
    txid: string;
    vin: string;
    createdAt: number;
    data: Array<{ key: string; value: Record<string, unknown> }>;
  };

  // Flatten the oneof Value into a plain key→value map
  const fields: Record<string, unknown> = {};
  for (const datum of obj.data ?? []) {
    const fieldName = datum.key;
    const valueObj = datum.value ?? {};
    // The oneof gives us exactly one property set in valueObj
    const entries = Object.entries(valueObj);
    if (entries.length > 0) {
      const [, val] = entries[0];
      fields[fieldName] = val;
    }
  }

  return {
    vin: obj.vin,
    txid: obj.txid,
    createdAt: obj.createdAt ?? Date.now(),
    fields,
  };
}
