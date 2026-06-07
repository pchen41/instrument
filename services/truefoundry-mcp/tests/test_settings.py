import os
import unittest
from unittest.mock import patch

from settings import load_settings


class SettingsTests(unittest.TestCase):
    def test_control_plane_url_is_required_setting(self):
        with patch.dict(
            os.environ,
            {
                "TFY_CONTROL_PLANE_URL": "https://tenant.truefoundry.cloud",
            },
            clear=False,
        ):
            settings = load_settings()

        self.assertEqual(settings.tfy_control_plane_url, "https://tenant.truefoundry.cloud")

    def test_missing_control_plane_url_stays_empty(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("TFY_CONTROL_PLANE_URL", None)
            settings = load_settings()

        self.assertEqual(settings.tfy_control_plane_url, "")


if __name__ == "__main__":
    unittest.main()
