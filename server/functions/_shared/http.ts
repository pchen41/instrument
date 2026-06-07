// Tiny HTTP helpers shared by the edge functions. Browser-invoked functions must
// answer CORS preflight and echo permissive headers (the console calls these from
// the deployed SPA on a different origin than the API).

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-worker-secret',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: corsHeaders });
}
