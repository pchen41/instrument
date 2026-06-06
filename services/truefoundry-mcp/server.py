"""Render entrypoint for Instrument's demo TrueFoundry MCP server."""

from __future__ import annotations

from typing import Any

import uvicorn
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from starlette.applications import Starlette
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from settings import Settings, load_settings
from tools import register_tools


class DemoBearerAuthMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: Any, settings: Settings) -> None:
        super().__init__(app)
        self.settings = settings

    async def dispatch(self, request: Request, call_next: Any) -> Response:
        if not request.url.path.startswith("/mcp"):
            return await call_next(request)

        if self.settings.allow_unauthenticated_mcp:
            return await call_next(request)

        expected = self.settings.mcp_auth_token
        if not expected:
            return JSONResponse(
                {"error": "MCP_AUTH_TOKEN is not configured"},
                status_code=503,
            )

        authorization = request.headers.get("authorization", "")
        bearer = authorization.removeprefix("Bearer ").strip()
        header_token = request.headers.get("x-mcp-auth", "").strip()
        if bearer == expected or header_token == expected:
            return await call_next(request)

        return JSONResponse({"error": "unauthorized"}, status_code=401)


def create_mcp(settings: Settings) -> FastMCP:
    transport_security = TransportSecuritySettings(
        enable_dns_rebinding_protection=bool(settings.allowed_hosts),
        allowed_hosts=settings.allowed_hosts,
        allowed_origins=settings.allowed_origins,
    )

    mcp = FastMCP(
        "Instrument TrueFoundry Observability",
        stateless_http=True,
        json_response=True,
        streamable_http_path="/mcp",
        transport_security=transport_security,
    )
    register_tools(mcp, settings)
    return mcp


def create_app(settings: Settings | None = None) -> Starlette:
    settings = settings or load_settings()
    mcp = create_mcp(settings)

    async def healthz(_: Request) -> JSONResponse:
        return JSONResponse(
            {
                "status": "ok",
                "service": "instrument-truefoundry-mcp",
                "truefoundry_configured": settings.truefoundry_configured,
                "mcp_auth_configured": settings.mcp_auth_configured,
                "allowed_hosts_configured": bool(settings.allowed_hosts),
            }
        )

    mcp.custom_route("/healthz", methods=["GET"], include_in_schema=False)(healthz)
    app = mcp.streamable_http_app()
    app.add_middleware(DemoBearerAuthMiddleware, settings=settings)
    return app


app = create_app()


if __name__ == "__main__":
    settings = load_settings()
    uvicorn.run(app, host="0.0.0.0", port=settings.port)
