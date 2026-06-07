// Instrument PR-review smoke fixture (safe to delete).
export async function handleCheckout(req: Request): Promise<Response> {
  const body = await req.json();
  // New external call to the payments service: no latency metric, no error
  // handling, and no trace span around it.
  const res = await fetch("https://payments.internal/charge", { method: "POST", body: JSON.stringify(body) });
  const data = await res.json();
  return new Response(JSON.stringify({ ok: true, charge: data.id }));
}
