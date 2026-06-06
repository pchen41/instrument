# Instrument TrueFoundry MCP Server

Remote MCP server for Instrument's TrueFoundry observability tools.
It is intentionally small: Render hosts the HTTP service, TrueFoundry MCP
Gateway registers the public `/mcp` URL, and Agent API workflows call it by FQN.

## Endpoints

- `GET /healthz` - Render health check and non-secret readiness.
- `/mcp` - Streamable HTTP MCP endpoint.

## Tools

- `health_check`
- `query_truefoundry_model_metrics`
- `query_truefoundry_mcp_metrics`
- `search_truefoundry_request_logs`
- `get_truefoundry_trace_spans`
- `get_instrument_evidence_bundle` - demo stub until Instrument evidence APIs exist.

## Environment

Set these in Render. Record secret names only in task notes, never values.

- `TFY_BASE_URL` - defaults to `https://gateway.truefoundry.ai`.
- `TFY_API_TOKEN` - TrueFoundry API token or VAT for server-side API calls.
- `TFY_DATA_ROUTING_DESTINATION` - optional TrueFoundry routing header value.
- `MCP_AUTH_TOKEN` - shared bearer/header token for the demo MCP endpoint.
- `MCP_ALLOWED_HOSTS` - comma-separated host headers accepted by the MCP SDK's
  DNS rebinding protection. For the current Render service, set
  `instrument-9z6j.onrender.com`. Render's `RENDER_EXTERNAL_HOSTNAME` is also
  accepted when present.
- `MCP_ALLOWED_ORIGINS` - optional comma-separated origins if a browser-based
  MCP client sends an `Origin` header.
- `MAX_TIME_WINDOW_HOURS` - default `6`.
- `MAX_RESULT_LIMIT` - default `50`.

For local unauthenticated experiments only, set
`ALLOW_UNAUTHENTICATED_MCP=true`.

## Local Run

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
export MCP_AUTH_TOKEN=local-demo-token
python server.py
```

Connect an MCP client to `http://localhost:8000/mcp` with either:

- `Authorization: Bearer local-demo-token`
- `x-mcp-auth: local-demo-token`

## Tests

```bash
python -m unittest discover -s tests
```

The included tests cover bounds and redaction without live TrueFoundry
credentials. Live smoke testing happens after Render deploy and TrueFoundry MCP
Gateway registration.

## Render + TrueFoundry Demo Setup

1. Create the Render service from the repository `render.yaml`.
2. Add the secret env vars in Render.
3. Confirm `https://<render-service>/healthz` returns `status: ok`.
4. Register `https://<render-service>/mcp` in TrueFoundry MCP Gateway as a
   remote MCP server.
5. Configure Gateway auth to send either `Authorization: Bearer <MCP_AUTH_TOKEN>`
   or `x-mcp-auth: <MCP_AUTH_TOKEN>`.
6. Copy only non-secret values into task notes or `integrations.config`: server
   URL, Gateway FQN, proxy URL if applicable, health status, and allowed tools.

Production OAuth, token passthrough, and automated MCP registration are deferred
until after the demo validation path is proven.
