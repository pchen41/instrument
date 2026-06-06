import unittest

from redaction import redact, truncate_text


class RedactionTests(unittest.TestCase):
    def test_redacts_sensitive_and_prompt_like_keys(self):
        value = {
            "authorization": "Bearer secret",
            "nested": {
                "api_key": "secret",
                "prompt": "private prompt",
                "safe": "visible",
            },
        }

        result = redact(value)

        self.assertEqual(result["authorization"], "[redacted]")
        self.assertEqual(result["nested"]["api_key"], "[redacted]")
        self.assertEqual(result["nested"]["prompt"], "[redacted]")
        self.assertEqual(result["nested"]["safe"], "visible")

    def test_truncates_long_text(self):
        result = truncate_text("a" * 20, max_chars=5)
        self.assertEqual(result, "aaaaa...[truncated 15 chars]")

    def test_limits_long_lists(self):
        result = redact(list(range(5)), max_items=3)
        self.assertEqual(result, [0, 1, 2, {"truncated_items": 2}])


if __name__ == "__main__":
    unittest.main()
