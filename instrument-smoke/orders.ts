// Instrument PR-review smoke fixture 2 (safe to delete).
export async function listOrders(userId: string): Promise<unknown[]> {
  // New DB query with no latency timing, no error logging if it throws, no span.
  const rows = await db.query("select * from orders where user_id = $1", [userId]);
  return rows;
}
