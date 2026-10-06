"""Focused tests for the shared disposable endpoint fence."""

import unittest

from spike_host import SPIKE_HOST, assert_spike_url


class SpikeHostTests(unittest.TestCase):
    def test_accepts_only_dedicated_spike_fqdn(self) -> None:
        assert_spike_url(f"wss://{SPIKE_HOST}")
        assert_spike_url(f"https://{SPIKE_HOST}/path")

    def test_rejects_other_hosts_and_unsafe_authority_forms(self) -> None:
        for url in (
            "wss://example.livekit.cloud",
            "wss://project-hello-r1-rtc.fly.dev",
            f"wss://{SPIKE_HOST}.evil.com",
            f"wss://evil{SPIKE_HOST}",
            f"wss://user@{SPIKE_HOST}",
            f"wss://@{SPIKE_HOST}",
            f"wss://:@{SPIKE_HOST}",
            f"wss://{SPIKE_HOST}:7880",
            f"https://{SPIKE_HOST}:443",
            f"http://{SPIKE_HOST}",
        ):
            with self.subTest(url=url):
                with self.assertRaises(RuntimeError):
                    assert_spike_url(url)


if __name__ == "__main__":
    unittest.main()
