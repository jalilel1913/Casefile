import { INTEGRITY_TRIGGERS_SQL } from "./triggers.js";

export async function applyIntegrityTriggers(): Promise<void> {
  const { pool } = await import("./index.js");
  const client = await pool.connect();
  try {
    await client.query(INTEGRITY_TRIGGERS_SQL);
  } finally {
    client.release();
  }
}
