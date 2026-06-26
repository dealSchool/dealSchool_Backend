import { Timestamp } from "firebase-admin/firestore";

// Converts Firestore Timestamps to ISO strings so they serialize cleanly in JSON
export function serializeDoc(data: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v instanceof Timestamp) {
      out[k] = v.toDate().toISOString();
    } else if (v && typeof v === "object" && !Array.isArray(v) && "toDate" in v) {
      out[k] = (v as Timestamp).toDate().toISOString();
    } else {
      out[k] = v;
    }
  }
  return out;
}
