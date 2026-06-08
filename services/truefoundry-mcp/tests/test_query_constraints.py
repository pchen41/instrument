import unittest

from query_constraints import (
    bounded_limit,
    build_metrics_payload,
    build_spans_payload,
    clean_filters,
)


class QueryConstraintTests(unittest.TestCase):
    def test_bounded_limit_clamps_to_max(self):
        self.assertEqual(bounded_limit(500, 50), 50)
        self.assertEqual(bounded_limit(0, 50), 1)
        self.assertEqual(bounded_limit(None, 50), 20)

    def test_metrics_payload_bounds_window_and_filters(self):
        payload = build_metrics_payload(
            datasource="mcpMetrics",
            start_time="2026-06-06T10:00:00Z",
            end_time="2026-06-06T11:00:00Z",
            max_hours=6,
            max_limit=50,
            aggregations=[
                {"type": "count", "column": "method"},
                {"type": "p99", "column": "latencyMs"},
            ],
            filters=[{"fieldName": "method", "operator": "IN", "value": ["tools/list"]}],
            group_by=["method"],
            limit=10,
        )

        self.assertEqual(payload["datasource"], "mcpMetrics")
        self.assertEqual(payload["type"], "distribution")
        self.assertEqual(payload["startTs"], "2026-06-06T10:00:00Z")
        self.assertEqual(payload["limit"], 10)
        self.assertEqual(
            payload["aggregations"],
            [
                {"type": "count", "column": "method"},
                {"type": "p99", "column": "latencyMs"},
            ],
        )
        self.assertEqual(payload["filters"], [{"fieldName": "method", "operator": "IN", "value": ["tools/list"]}])
        self.assertEqual(payload["groupBy"], ["method"])

    def test_rejects_overlong_window(self):
        with self.assertRaises(ValueError):
            build_metrics_payload(
                datasource="mcpMetrics",
                start_time="2026-06-06T00:00:00Z",
                end_time="2026-06-07T00:00:00Z",
                max_hours=6,
                max_limit=50,
            )

    def test_rejects_unsupported_filters(self):
        with self.assertRaises(ValueError):
            clean_filters({"authorization": "nope"})

    def test_model_metrics_allow_model_columns(self):
        payload = build_metrics_payload(
            datasource="modelMetrics",
            start_time="2026-06-06T10:00:00Z",
            end_time="2026-06-06T11:00:00Z",
            max_hours=6,
            max_limit=50,
            aggregations=[
                {"type": "count", "column": "modelName"},
                {"type": "sum", "column": "inputTokens"},
                {"type": "p99", "column": "latencyMs"},
            ],
            filters=[{"fieldName": "virtualModelName", "operator": "IS_NULL", "value": True}],
            group_by=["modelName"],
        )

        self.assertEqual(payload["datasource"], "modelMetrics")
        self.assertEqual(payload["groupBy"], ["modelName"])
        self.assertEqual(payload["filters"], [{"fieldName": "virtualModelName", "operator": "IS_NULL", "value": True}])

    def test_timeseries_payload_adds_interval(self):
        payload = build_metrics_payload(
            datasource="mcpMetrics",
            start_time="2026-06-06T10:00:00Z",
            end_time="2026-06-06T11:00:00Z",
            max_hours=6,
            max_limit=50,
            query_type="timeseries",
            aggregations=[{"type": "count", "column": "toolName"}],
            group_by=["toolName"],
            interval_in_seconds=300,
        )

        self.assertEqual(payload["type"], "timeseries")
        self.assertEqual(payload["intervalInSeconds"], 300)

    def test_spans_payload_adds_trace_id_filter(self):
        payload = build_spans_payload(
            start_time="2026-06-06T10:00:00Z",
            end_time="2026-06-06T10:30:00Z",
            max_hours=6,
            max_limit=50,
            tracing_project_fqn="tenant:tracing-project:tfy-default",
            data_routing_destination="default",
            trace_id="trace-123",
            limit=5,
        )

        self.assertEqual(payload["tracingProjectFqn"], "tenant:tracing-project:tfy-default")
        self.assertEqual(payload["dataRoutingDestination"], "default")
        self.assertEqual(payload["applicationNames"], ["tfy-llm-gateway"])
        self.assertEqual(payload["filters"], [{"spanFieldName": "traceId", "operator": "IN", "value": ["trace-123"]}])
        self.assertEqual(payload["limit"], 5)

    def test_spans_payload_defaults_routing_destination(self):
        # With neither a tracing project FQN nor a routing destination configured,
        # the spans API requires one — default to "default" so the call succeeds.
        payload = build_spans_payload(
            start_time="2026-06-06T10:00:00Z",
            end_time="2026-06-06T10:30:00Z",
            max_hours=6,
            max_limit=50,
            limit=5,
        )

        self.assertEqual(payload["dataRoutingDestination"], "default")
        self.assertNotIn("tracingProjectFqn", payload)

    def test_spans_payload_keeps_explicit_tracing_project(self):
        # An explicitly configured tracing project FQN is respected and the routing
        # destination is NOT forced to "default".
        payload = build_spans_payload(
            start_time="2026-06-06T10:00:00Z",
            end_time="2026-06-06T10:30:00Z",
            max_hours=6,
            max_limit=50,
            tracing_project_fqn="tenant:tracing-project:tfy-default",
            limit=5,
        )

        self.assertEqual(payload["tracingProjectFqn"], "tenant:tracing-project:tfy-default")
        self.assertNotIn("dataRoutingDestination", payload)

    def test_spans_payload_keeps_explicit_routing_destination(self):
        # An explicitly configured routing destination is kept as-is and the default
        # block is a no-op (no tracingProjectFqn is injected).
        payload = build_spans_payload(
            start_time="2026-06-06T10:00:00Z",
            end_time="2026-06-06T10:30:00Z",
            max_hours=6,
            max_limit=50,
            data_routing_destination="prod",
            limit=5,
        )

        self.assertEqual(payload["dataRoutingDestination"], "prod")
        self.assertNotIn("tracingProjectFqn", payload)


if __name__ == "__main__":
    unittest.main()
