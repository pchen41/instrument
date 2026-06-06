"""Bounds and payload builders for demo TrueFoundry tools."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


ALLOWED_FILTER_KEYS = {
    "environment",
    "error_code",
    "integration_fqn",
    "mcp_server",
    "model",
    "model_name",
    "provider",
    "request_id",
    "service",
    "status",
    "status_code",
    "tool_name",
    "trace_id",
    "workflow",
}

ALLOWED_GROUP_BY = {
    "environment",
    "error_code",
    "integration_fqn",
    "mcp_server",
    "model",
    "model_name",
    "provider",
    "service",
    "status",
    "status_code",
    "tool_name",
    "workflow",
}


def parse_timestamp(value: str) -> datetime:
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = f"{normalized[:-1]}+00:00"
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def bounded_limit(limit: int | None, max_limit: int) -> int:
    if limit is None:
        return min(20, max_limit)
    return max(1, min(int(limit), max_limit))


def bounded_window(
    start_time: str,
    end_time: str,
    *,
    max_hours: int,
) -> tuple[str, str]:
    start = parse_timestamp(start_time)
    end = parse_timestamp(end_time)
    if end <= start:
        raise ValueError("end_time must be after start_time")

    window_seconds = (end - start).total_seconds()
    max_seconds = max_hours * 60 * 60
    if window_seconds > max_seconds:
        raise ValueError(f"time window must be {max_hours} hours or less")

    return start.isoformat().replace("+00:00", "Z"), end.isoformat().replace("+00:00", "Z")


def clean_filters(filters: dict[str, Any] | None) -> dict[str, Any]:
    if not filters:
        return {}

    cleaned: dict[str, Any] = {}
    unsupported = sorted(set(filters) - ALLOWED_FILTER_KEYS)
    if unsupported:
        raise ValueError(f"unsupported filter keys: {', '.join(unsupported)}")

    for key, value in filters.items():
        if value is None or value == "":
            continue
        if isinstance(value, (str, int, float, bool)):
            cleaned[key] = value
        elif isinstance(value, list) and all(isinstance(item, (str, int, float, bool)) for item in value):
            cleaned[key] = value[:20]
        else:
            raise ValueError(f"filter {key} must be a scalar or list of scalars")
    return cleaned


def clean_group_by(group_by: list[str] | None) -> list[str]:
    if not group_by:
        return []
    unsupported = sorted(set(group_by) - ALLOWED_GROUP_BY)
    if unsupported:
        raise ValueError(f"unsupported group_by keys: {', '.join(unsupported)}")
    return group_by[:5]


def build_metrics_payload(
    *,
    datasource: str,
    start_time: str,
    end_time: str,
    max_hours: int,
    max_limit: int,
    metric_names: list[str] | None = None,
    filters: dict[str, Any] | None = None,
    group_by: list[str] | None = None,
    limit: int | None = None,
) -> dict[str, Any]:
    if datasource not in {"modelMetrics", "mcpMetrics"}:
        raise ValueError("datasource must be modelMetrics or mcpMetrics")

    bounded_start, bounded_end = bounded_window(start_time, end_time, max_hours=max_hours)
    return {
        "datasource": datasource,
        "startTime": bounded_start,
        "endTime": bounded_end,
        "metrics": (metric_names or [])[:10],
        "filters": clean_filters(filters),
        "groupBy": clean_group_by(group_by),
        "limit": bounded_limit(limit, max_limit),
    }


def build_spans_payload(
    *,
    start_time: str,
    end_time: str,
    max_hours: int,
    max_limit: int,
    query: str | None = None,
    trace_id: str | None = None,
    filters: dict[str, Any] | None = None,
    limit: int | None = None,
) -> dict[str, Any]:
    bounded_start, bounded_end = bounded_window(start_time, end_time, max_hours=max_hours)
    cleaned_filters = clean_filters(filters)
    if trace_id:
        cleaned_filters["trace_id"] = trace_id

    return {
        "startTime": bounded_start,
        "endTime": bounded_end,
        "query": (query or "")[:300],
        "filters": cleaned_filters,
        "limit": bounded_limit(limit, max_limit),
    }
