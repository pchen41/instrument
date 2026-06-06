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
            datasource="modelMetrics",
            start_time="2026-06-06T10:00:00Z",
            end_time="2026-06-06T11:00:00Z",
            max_hours=6,
            max_limit=50,
            metric_names=["latency", "cost"],
            filters={"model": "instrument/instrument"},
            group_by=["model"],
            limit=10,
        )

        self.assertEqual(payload["datasource"], "modelMetrics")
        self.assertEqual(payload["limit"], 10)
        self.assertEqual(payload["filters"], {"model": "instrument/instrument"})
        self.assertEqual(payload["groupBy"], ["model"])

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

    def test_spans_payload_adds_trace_id_filter(self):
        payload = build_spans_payload(
            start_time="2026-06-06T10:00:00Z",
            end_time="2026-06-06T10:30:00Z",
            max_hours=6,
            max_limit=50,
            trace_id="trace-123",
            limit=5,
        )

        self.assertEqual(payload["filters"]["trace_id"], "trace-123")
        self.assertEqual(payload["limit"], 5)


if __name__ == "__main__":
    unittest.main()
