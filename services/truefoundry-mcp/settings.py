"""Environment-backed settings for the demo MCP server."""

from __future__ import annotations

import os
from dataclasses import dataclass


def _bool_env(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _int_env(name: str, default: int) -> int:
    value = os.getenv(name)
    if not value:
        return default
    try:
        return int(value)
    except ValueError:
        return default


def _csv_env(name: str) -> list[str]:
    value = os.getenv(name, "")
    return [item.strip() for item in value.split(",") if item.strip()]


@dataclass(frozen=True)
class Settings:
    tfy_control_plane_url: str
    tfy_api_token: str | None
    tfy_data_routing_destination: str | None
    tfy_tracing_project_fqn: str | None
    mcp_auth_token: str | None
    allow_unauthenticated_mcp: bool
    max_time_window_hours: int
    max_result_limit: int
    host: str
    port: int
    allowed_hosts: list[str]
    allowed_origins: list[str]
    log_level: str

    @property
    def truefoundry_configured(self) -> bool:
        return bool(self.tfy_control_plane_url and self.tfy_api_token)

    @property
    def mcp_auth_configured(self) -> bool:
        return bool(self.mcp_auth_token)


def load_settings() -> Settings:
    render_hostname = os.getenv("RENDER_EXTERNAL_HOSTNAME")
    allowed_hosts = _csv_env("MCP_ALLOWED_HOSTS")
    if render_hostname and render_hostname not in allowed_hosts:
        allowed_hosts.append(render_hostname)

    return Settings(
        tfy_control_plane_url=os.getenv("TFY_CONTROL_PLANE_URL", "").rstrip("/"),
        tfy_api_token=os.getenv("TFY_API_TOKEN"),
        tfy_data_routing_destination=os.getenv("TFY_DATA_ROUTING_DESTINATION"),
        tfy_tracing_project_fqn=os.getenv("TFY_TRACING_PROJECT_FQN"),
        mcp_auth_token=os.getenv("MCP_AUTH_TOKEN"),
        allow_unauthenticated_mcp=_bool_env("ALLOW_UNAUTHENTICATED_MCP", False),
        max_time_window_hours=_int_env("MAX_TIME_WINDOW_HOURS", 6),
        max_result_limit=_int_env("MAX_RESULT_LIMIT", 50),
        host=os.getenv("HOST", "0.0.0.0"),
        port=_int_env("PORT", 8000),
        allowed_hosts=allowed_hosts,
        allowed_origins=_csv_env("MCP_ALLOWED_ORIGINS"),
        log_level=os.getenv("LOG_LEVEL", "INFO").upper(),
    )
