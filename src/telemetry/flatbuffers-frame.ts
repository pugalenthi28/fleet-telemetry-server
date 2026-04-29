/**
 * Minimal FlatBuffers parser for Tesla fleet-telemetry wire format.
 *
 * Tesla vehicles send:  FlatbuffersEnvelope { txid, topic, messageType=4, message=FlatbuffersStream }
 * FlatbuffersStream contains:  payload = protobuf-encoded vehicle_data.Payload bytes
 *
 * We send back:  FlatbuffersEnvelope { txid (same), messageType=5 (StreamAck), message=FlatbuffersStreamAck (empty) }
 *
 * Field layout from generated Go code (tesla/fleet-telemetry):
 *   FlatbuffersEnvelope vtable slots (0-based field index):
 *     0 → txid        (bytes vector)
 *     1 → topic       (bytes vector)
 *     2 → messageType (uint8)
 *     3 → message     (nested table — FlatbuffersStream or FlatbuffersStreamAck)
 *
 *   FlatbuffersStream vtable slots:
 *     0 → createdAt   (uint32)
 *     1 → senderId    (bytes vector, deprecated)
 *     2 → payload     (bytes vector — protobuf Payload)
 */

import { Builder } from "flatbuffers";

const MESSAGE_TYPE_STREAM     = 4;
const MESSAGE_TYPE_STREAM_ACK = 5;

// ── Low-level FlatBuffers binary helpers ─────────────────────────────────────

function fieldOff(buf: Buffer, tablePos: number, fieldIdx: number): number {
  const vtable = tablePos - buf.readInt32LE(tablePos);
  const vtableSize = buf.readUInt16LE(vtable);
  const slot = 4 + fieldIdx * 2;
  if (slot >= vtableSize) return 0;
  return buf.readUInt16LE(vtable + slot);
}

function readBytes(buf: Buffer, tablePos: number, fieldIdx: number): Buffer {
  const off = fieldOff(buf, tablePos, fieldIdx);
  if (!off) return Buffer.alloc(0);
  const ref = tablePos + off;
  const vecStart = ref + buf.readInt32LE(ref);
  const len = buf.readUInt32LE(vecStart);
  return buf.subarray(vecStart + 4, vecStart + 4 + len);
}

function readUint8(buf: Buffer, tablePos: number, fieldIdx: number): number {
  const off = fieldOff(buf, tablePos, fieldIdx);
  return off ? buf.readUInt8(tablePos + off) : 0;
}

function readTable(buf: Buffer, tablePos: number, fieldIdx: number): number {
  const off = fieldOff(buf, tablePos, fieldIdx);
  if (!off) return 0;
  const ref = tablePos + off;
  return ref + buf.readInt32LE(ref);
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface ParsedFrame {
  txid: string;
  topic: string;
  payloadBytes: Buffer;
}

export function parseFrame(raw: Buffer): ParsedFrame | null {
  try {
    // FlatBuffers root: first 4 bytes are the offset to the root table
    const rootPos = raw.readUInt32LE(0);

    const txid  = readBytes(raw, rootPos, 0).toString("utf8");
    const topic = readBytes(raw, rootPos, 1).toString("utf8");
    const msgType = readUint8(raw, rootPos, 2);

    if (msgType !== MESSAGE_TYPE_STREAM) return null;

    const streamPos = readTable(raw, rootPos, 3);
    if (!streamPos) return null;

    const payloadBytes = readBytes(raw, streamPos, 2);
    return { txid, topic, payloadBytes };
  } catch {
    return null;
  }
}

export function buildAck(txid: string): Buffer {
  const builder = new Builder(128);

  // Build empty FlatbuffersStreamAck (0 fields) — must be built before the envelope
  builder.startObject(0);
  const ackTable = builder.endObject();

  // Build txid bytes vector
  const txidBytes = Buffer.from(txid, "utf8");
  const txidVec = builder.createByteVector(txidBytes);

  // Build FlatbuffersEnvelope (4 fields)
  builder.startObject(4);
  builder.addFieldOffset(0, txidVec, 0);           // field 0: txid
  // field 1 (topic): omit — not needed in ACK
  builder.addFieldInt8(2, MESSAGE_TYPE_STREAM_ACK, 0); // field 2: messageType = 5
  builder.addFieldOffset(3, ackTable, 0);          // field 3: message = StreamAck
  const envelope = builder.endObject();

  builder.finish(envelope);
  return Buffer.from(builder.asUint8Array());
}
