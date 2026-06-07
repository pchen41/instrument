"""FastMCP tool registration for Instrument's TrueFoundry observability server."""

from __future__ import annotations

import json
import logging
from typing import Any

from mcp.server.fastmcp import FastMCP

from query_constraints import build_metrics_payload, build_spans_payload
from redaction import redact
from settings import Settings
from truefoundry_client import TrueFoundryClient

logger = logging.getLogger("instrument_truefoundry_mcp.tools")


def _log_tool_start(tool_name: str, payload: dict[str, Any]) -> None:
    logger.info(
        "mcp_tool_start tool=%s payload=%s",
        tool_name,
        json.dumps(redact(payload, max_string_chars=300, max_items=25), sort_keys=True, default=str),
    )


def _log_tool_success(tool_name: str, data: dict[str, Any]) -> None:
    logger.info(
        "mcp_tool_success tool=%s result_keys=%s",
        tool_name,
        sorted(data.keys()),
    )


def _log_tool_error(tool_name: str, error: Exception) -> None:
    logger.exception(
        "mcp_tool_error tool=%s error_type=%s error=%s",
        tool_name,
        type(error).__name__,
        str(error) or "[empty error]",
    )


def register_tools(mcp: FastMCP, settings: Settings) -> None:
    client = TrueFoundryClient(settings)

    @mcp.tool()
    def health_check() -> dict[str, Any]:
        """Return non-secret server readiness details."""
        return {
            "status": "ok",
            "service": "instrument-truefoundry-mcp",
            "truefoundry_configured": settings.truefoundry_configured,
            "mcp_auth_configured": settings.mcp_auth_configured,
            "max_time_window_hours": settings.max_time_window_hours,
            "max_result_limit": settings.max_result_limit,
        }

    @mcp.tool()
    async def query_truefoundry_model_metrics(
        start_time: str,
        end_time: str,
        query_type: str = "distribution",
        aggregations: list[dict[str, str]] | None = None,
        filters: list[dict[str, Any]] | None = None,
        group_by: list[str] | None = None,
        limit: int | None = None,
        interval_in_seconds: int | None = None,
    ) -> dict[str, Any]:
        """Query bounded TrueFoundry model metrics for a short time window."""
        payload = build_metrics_payload(
            datasource="modelMetrics",
            start_time=start_time,
            end_time=end_time,
            max_hours=settings.max_time_window_hours,
            max_limit=settings.max_result_limit,
            query_type=query_type,
            aggregations=aggregations,
            filters=filters,
            group_by=group_by,
            limit=limit,
            interval_in_seconds=interval_in_seconds,
        )
        try:
            _log_tool_start("query_truefoundry_model_metrics", payload)
            data = await client.query_metrics(payload)
            _log_tool_success("query_truefoundry_model_metrics", data)
            return {"query": redact(payload), "result": redact(data)}
        except Exception as exc:
            _log_tool_error("query_truefoundry_model_metrics", exc)
            raise RuntimeError(str(exc) or f"{type(exc).__name__}: empty error") from exc

    @mcp.tool()
    async def query_truefoundry_mcp_metrics(
        start_time: str,
        end_time: str,
        query_type: str = "distribution",
        aggregations: list[dict[str, str]] | None = None,
        filters: list[dict[str, Any]] | None = None,
        group_by: list[str] | None = None,
        limit: int | None = None,
        interval_in_seconds: int | None = None,
    ) -> dict[str, Any]:
        """Query bounded TrueFoundry MCP metrics for a short time window."""
        payload = build_metrics_payload(
            datasource="mcpMetrics",
            start_time=start_time,
            end_time=end_time,
            max_hours=settings.max_time_window_hours,
            max_limit=settings.max_result_limit,
            query_type=query_type,
            aggregations=aggregations,
            filters=filters,
            group_by=group_by,
            limit=limit,
            interval_in_seconds=interval_in_seconds,
        )
        try:
            _log_tool_start("query_truefoundry_mcp_metrics", payload)
            data = await client.query_metrics(payload)
            _log_tool_success("query_truefoundry_mcp_metrics", data)
            return {"query": redact(payload), "result": redact(data)}
        except Exception as exc:
            _log_tool_error("query_truefoundry_mcp_metrics", exc)
            raise RuntimeError(str(exc) or f"{type(exc).__name__}: empty error") from exc

    @mcp.tool()
    async def search_truefoundry_request_logs(
        start_time: str,
        end_time: str,
        query: str | None = None,
        filters: dict[str, Any] | None = None,
        limit: int | None = None,
    ) -> dict[str, Any]:
        """Search bounded TrueFoundry request logs/spans for demo investigation evidence."""
        payload = build_spans_payload(
            start_time=start_time,
            end_time=end_time,
            max_hours=settings.max_time_window_hours,
            max_limit=settings.max_result_limit,
            tracing_project_fqn=settings.tfy_tracing_project_fqn,
            data_routing_destination=settings.tfy_data_routing_destination,
            query=query,
            filters=filters,
            limit=limit,
        )
        try:
            _log_tool_start("search_truefoundry_request_logs", payload)
            data = await client.query_spans(payload)
            _log_tool_success("search_truefoundry_request_logs", data)
            return {"query": redact(payload), "result": redact(data)}
        except Exception as exc:
            _log_tool_error("search_truefoundry_request_logs", exc)
            raise RuntimeError(str(exc) or f"{type(exc).__name__}: empty error") from exc

    @mcp.tool()
    async def get_truefoundry_trace_spans(
        trace_id: str,
        start_time: str,
        end_time: str,
        limit: int | None = None,
    ) -> dict[str, Any]:
        """Fetch bounded spans for a known TrueFoundry trace ID."""
        payload = build_spans_payload(
            start_time=start_time,
            end_time=end_time,
            max_hours=settings.max_time_window_hours,
            max_limit=settings.max_result_limit,
            tracing_project_fqn=settings.tfy_tracing_project_fqn,
            data_routing_destination=settings.tfy_data_routing_destination,
            trace_id=trace_id,
            limit=limit,
        )
        try:
            _log_tool_start("get_truefoundry_trace_spans", payload)
            data = await client.query_spans(payload)
            _log_tool_success("get_truefoundry_trace_spans", data)
            return {"query": redact(payload), "result": redact(data)}
        except Exception as exc:
            _log_tool_error("get_truefoundry_trace_spans", exc)
            raise RuntimeError(str(exc) or f"{type(exc).__name__}: empty error") from exc

    @mcp.tool()
    def get_instrument_evidence_bundle(evidence_bundle_id: str) -> dict[str, Any]:
        """Return a clear demo stub until Instrument's server-backed evidence API exists."""
        return {
            "status": "unavailable",
            "evidence_bundle_id": evidence_bundle_id,
            "reason": "Instrument evidence-bundle lookup is not wired in the demo MCP server yet.",
        }
