import { createHash } from "node:crypto";

function serializeString(value: string): string {
  return JSON.stringify(value);
}

function serializePrimitive(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error("RFC 8785: NaN/Infinity no permitidos");
      }
      return JSON.stringify(value);
    case "string":
      return serializeString(value);
    default:
      throw new Error(`RFC 8785: tipo no serializable (${typeof value})`);
  }
}

/** Canonical JSON Serialization compatible con RFC 8785/JCS para valores JSON finitos. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return serializePrimitive(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const body = keys
    .map((key) => {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) return "";
      return `${serializeString(key)}:${canonicalize(child)}`;
    })
    .filter(Boolean)
    .join(",");
  return `{${body}}`;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function contextHashFor(payload: Record<string, unknown>): string {
  const { contextHash: _ignored, ...rest } = payload;
  return sha256Hex(canonicalize(rest));
}

export function withContextHash<T extends Record<string, unknown>>(payload: T): T & { contextHash: string } {
  const clone = { ...payload } as Record<string, unknown>;
  delete clone.contextHash;
  const hash = sha256Hex(canonicalize(clone));
  return { ...payload, contextHash: hash };
}
