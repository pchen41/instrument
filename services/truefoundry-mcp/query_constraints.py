"""Bounds and payload builders for demo TrueFoundry tools."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


MCP_FILTER_KEYS = {
    "conversationID",
    "latencyMs",
    "mcpServerName",
    "method",
    "team",
    "toolName",
    "userEmail",
    "virtualAccount",
}

MCP_GROUP_BY = {
    "conversationID",
    "createdBySubjectType",
    "mcpServerName",
    "method",
    "team",
    "toolName",
    "userEmail",
    "virtualaccount",
}

MODEL_FILTER_KEYS = {
    "createdBySubjectType",
    "errorCode",
    "latencyMs",
    "modelName",
    "providerAccountType",
    "providerModelName",
    "requestType",
    "team",
    "userEmail",
    "virtualAccount",
    "virtualModelName",
}

MODEL_GROUP_BY = {
    "createdBySubjectType",
    "errorCode",
    "modelName",
    "providerAccountType",
    "providerModelName",
    "requestType",
    "team",
    "userEmail",
    "virtualModel",
    "virtualaccount",
}

ALLOWED_AGGREGATIONS = {
    "avg",
    "count",
    "countDistinct",
    "max",
    "min",
    "p50",
    "p75",
    "p90",
    "p99",
    "sum",
}

MCP_AGGREGATION_COLUMNS = {
    "latencyMs",
    "mcpServerName",
    "method",
    "toolName",
}

MODEL_AGGREGATION_COLUMNS = {
    "costInUSD",
    "inputTokens",
    "interTokenLatencyMs",
    "latencyMs",
    "modelName",
    "outputTokens",
    "timePerOutputTokenLatencyMs",
    "timeToFirstTokenMs",
}

ALLOWED_OPERATORS = {
    "ARRAY_HAS_ANY",
    "ARRAY_HAS_NONE",
    "BETWEEN",
    "EQUAL",
    "GREATER_THAN",
    "GREATER_THAN_EQUAL",
    "IN",
    "IS_NULL",
    "LESS_THAN",
    "LESS_THAN_EQUAL",
    "NOT_EQUAL",
    "NOT_IN",
    "STRING_CONTAINS",
    "STRING_ENDS_WITH",
    "STRING_STARTS_WITH",
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


def _field_set(datasource: str) -> set[str]:
    return MODEL_FILTER_KEYS if datasource == "modelMetrics" else MCP_FILTER_KEYS


def _group_by_set(datasource: str) -> set[str]:
    return MODEL_GROUP_BY if datasource == "modelMetrics" else MCP_GROUP_BY


def _aggregation_columns(datasource: str) -> set[str]:
    return MODEL_AGGREGATION_COLUMNS if datasource == "modelMetrics" else MCP_AGGREGATION_COLUMNS


def clean_filters(
    filters: dict[str, Any] | list[dict[str, Any]] | None,
    *,
    datasource: str = "mcpMetrics",
) -> list[dict[str, Any]]:
    if not filters:
        return []

    if isinstance(filters, dict):
        filter_items = [
            {"fieldName": key, "operator": "IN", "value": value if isinstance(value, list) else [value]}
            for key, value in filters.items()
        ]
    else:
        filter_items = filters

    cleaned: list[dict[str, Any]] = []
    for item in filter_items[:10]:
        field_name = item.get("fieldName")
        metadata_key = item.get("metadataKey")
        operator = item.get("operator")

        if not field_name and not metadata_key:
            raise ValueError("filter must include fieldName or metadataKey")
        if field_name and field_name not in _field_set(datasource):
            raise ValueError(f"unsupported filter fieldName: {field_name}")
        if operator not in ALLOWED_OPERATORS:
            raise ValueError(f"unsupported filter operator: {operator}")

        value = item.get("value")
        if value is None or value == "":
            continue
        if isinstance(value, (str, int, float, bool)):
            cleaned.append({key: item[key] for key in ("fieldName", "metadataKey", "operator") if key in item} | {"value": value})
        elif isinstance(value, list) and all(isinstance(item, (str, int, float, bool)) for item in value):
            cleaned.append({key: item[key] for key in ("fieldName", "metadataKey", "operator") if key in item} | {"value": value[:20]})
        else:
            raise ValueError("filter value must be a scalar or list of scalars")
    return cleaned


def clean_group_by(group_by: list[str] | None, *, datasource: str = "mcpMetrics") -> list[str]:
    if not group_by:
        return []
    unsupported = [
        item
        for item in group_by
        if item not in _group_by_set(datasource) and not item.startswith("metadata.")
    ]
    if unsupported:
        raise ValueError(f"unsupported group_by keys: {', '.join(unsupported)}")
    return group_by[:5]


def clean_aggregations(
    aggregations: list[dict[str, str]] | None,
    *,
    datasource: str = "mcpMetrics",
) -> list[dict[str, str]]:
    if not aggregations:
        return [{"type": "count", "column": "method"}]

    cleaned = []
    for item in aggregations[:5]:
        aggregation_type = item.get("type")
        column = item.get("column")
        if aggregation_type not in ALLOWED_AGGREGATIONS:
            raise ValueError(f"unsupported aggregation type: {aggregation_type}")
        if column not in _aggregation_columns(datasource):
            raise ValueError(f"unsupported aggregation column: {column}")
        cleaned.append({"type": aggregation_type, "column": column})
    return cleaned


def build_metrics_payload(
    *,
    datasource: str,
    start_time: str,
    end_time: str,
    max_hours: int,
    max_limit: int,
    query_type: str = "distribution",
    aggregations: list[dict[str, str]] | None = None,
    filters: dict[str, Any] | list[dict[str, Any]] | None = None,
    group_by: list[str] | None = None,
    limit: int | None = None,
    interval_in_seconds: int | None = None,
) -> dict[str, Any]:
    if datasource not in {"modelMetrics", "mcpMetrics"}:
        raise ValueError("datasource must be modelMetrics or mcpMetrics")
    if query_type not in {"distribution", "timeseries"}:
        raise ValueError("type must be distribution or timeseries")

    bounded_start, bounded_end = bounded_window(start_time, end_time, max_hours=max_hours)
    payload: dict[str, Any] = {
        "startTs": bounded_start,
        "endTs": bounded_end,
        "datasource": datasource,
        "type": query_type,
        "aggregations": clean_aggregations(aggregations, datasource=datasource),
        "filters": clean_filters(filters, datasource=datasource),
        "groupBy": clean_group_by(group_by, datasource=datasource),
        "limit": bounded_limit(limit, max_limit),
    }

    if query_type == "timeseries":
        payload["intervalInSeconds"] = interval_in_seconds or 3600

    return payload


def build_spans_payload(
    *,
    start_time: str,
    end_time: str,
    max_hours: int,
    max_limit: int,
    tracing_project_fqn: str | None = None,
    data_routing_destination: str | None = None,
    query: str | None = None,
    trace_id: str | None = None,
    filters: dict[str, Any] | None = None,
    limit: int | None = None,
) -> dict[str, Any]:
    bounded_start, bounded_end = bounded_window(start_time, end_time, max_hours=max_hours)
    cleaned_filters = clean_filters(filters)
    if trace_id:
        cleaned_filters.append({"spanFieldName": "traceId", "operator": "IN", "value": [trace_id]})

    payload: dict[str, Any] = {
        "startTime": bounded_start,
        "endTime": bounded_end,
        "applicationNames": ["tfy-llm-gateway"],
        "filters": cleaned_filters,
        "limit": bounded_limit(limit, max_limit),
        "sortDirection": "desc",
    }

    if tracing_project_fqn:
        payload["tracingProjectFqn"] = tracing_project_fqn
    if data_routing_destination:
        payload["dataRoutingDestination"] = data_routing_destination
    if query:
        payload["filters"].append(
            {"spanFieldName": "spanName", "operator": "STRING_CONTAINS", "value": query[:100]}
        )

    return payload
