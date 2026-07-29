from __future__ import annotations

import unittest

from AgentHub.install import apply_rollout_image_cleanup_choice


class RolloutImageCleanupChoiceTests(unittest.TestCase):
    def test_missing_choice_does_not_create_a_decision(self) -> None:
        config = {"profile": "journal"}

        result = apply_rollout_image_cleanup_choice(config, None)

        self.assertIs(result, config)
        self.assertNotIn("codexRolloutContext", result)

    def test_enabled_choice_records_default_interval(self) -> None:
        result = apply_rollout_image_cleanup_choice({}, "enabled")

        self.assertEqual(
            result["codexRolloutContext"],
            {"enabled": True, "scanIntervalSeconds": 900},
        )

    def test_disabled_choice_preserves_existing_tuning(self) -> None:
        result = apply_rollout_image_cleanup_choice(
            {
                "codexRolloutContext": {
                    "enabled": True,
                    "scanIntervalSeconds": 1200,
                    "keepRecentImages": 6,
                }
            },
            "disabled",
        )

        self.assertEqual(
            result["codexRolloutContext"],
            {
                "enabled": False,
                "scanIntervalSeconds": 1200,
                "keepRecentImages": 6,
            },
        )


if __name__ == "__main__":
    unittest.main()
