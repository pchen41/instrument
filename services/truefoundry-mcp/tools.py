"""FastMCP tool registration for Instrument's TrueFoundry observability server."""

from __future__ import annotations

from typing import Any

from mcp.server.fastmcp import FastMCP

from query_constraints import build_metrics_payload, build_spans_payload
from redaction import redact
from settings import Settings
from truefoundry_client import TrueFoundryClient


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
        metric_names: list[str] | None = None,
        filters: dict[str, Any] | None = None,
        group_by: list[str] | None = None,
        limit: int | None = None,
    ) -> dict[str, Any]:
        """Query bounded TrueFoundry model metrics for a short time window."""
        payload = build_metrics_payload(
            datasource="modelMetrics",
            start_time=start_time,
            end_time=end_time,
            max_hours=settings.max_time_window_hours,
            max_limit=settings.max_result_limit,
            metric_names=metric_names,
            filters=filters,
            group_by=group_by,
            limit=limit,
        )
        data = await client.query_metrics(payload)
        return {"query": redact(payload), "result": redact(data)}

    @mcp.tool()
    async def query_truefoundry_mcp_metrics(
        start_time: str,
        end_time: str,
        metric_names: list[str] | None = None,
        filters: dict[str, Any] | None = None,
        group_by: list[str] | None = None,
        limit: int | None = None,
    ) -> dict[str, Any]:
        """Query bounded TrueFoundry MCP metrics for a short time window."""
        payload = build_metrics_payload(
            datasource="mcpMetrics",
            start_time=start_time,
            end_time=end_time,
            max_hours=settings.max_time_window_hours,
            max_limit=settings.max_result_limit,
            metric_names=metric_names,
            filters=filters,
            group_by=group_by,
            limit=limit,
        )
        data = await client.query_metrics(payload)
        return {"query": redact(payload), "result": redact(data)}

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
            query=query,
            filters=filters,
            limit=limit,
        )
        data = await client.query_spans(payload)
        return {"query": redact(payload), "result": redact(data)}

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
            trace_id=trace_id,
            limit=limit,
        )
        data = await client.query_spans(payload)
        return {"query": redact(payload), "result": redact(data)}

    @mcp.tool()
    def get_instrument_evidence_bundle(evidence_bundle_id: str) -> dict[str, Any]:
        """Return a clear demo stub until Instrument's server-backed evidence API exists."""
        return {
            "status": "unavailable",
            "evidence_bundle_id": evidence_bundle_id,
            "reason": "Instrument evidence-bundle lookup is not wired in the demo MCP server yet.",
        }
