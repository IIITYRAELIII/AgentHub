"""Real HTTP framing/closure through the HTTPS owner, with local socket routing.

The connect-only fixture substitutes plain loopback for TLS; it does not attest
public network availability. Default certificate policy and rejection are checked
separately. No installer main, native process or real update cache is used.
"""
from contextlib import closing
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import shutil
import socket
import ssl
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error

import install_release as installer


class ReleaseHTTPSTests(unittest.TestCase):
    def setUp(self):
        self.records = []
        self.finished = threading.Condition()
        self.finished_count = 0
        self.mode = "early-close"
        self.body = b"bounded response body\n" * 4096
        self.metadata = dict(tag_name="2.1.2", draft=False, prerelease=False,
                             published_at="2026-01-01T00:00:00Z", assets=[], padding="x"*12000)
        self.asset = f"https://github.com/{installer.REPOSITORY}/releases/download/2.1.2/fixture.bin"
        test = self

        class Peer(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def do_GET(self):
                test.records.append(dict(host=self.headers.get("Host"), path=self.path,
                                         connection=self.headers.get("Connection"),
                                         agent=self.headers.get("User-Agent")))
                api = self.headers["Host"] == "api.github.com"
                location = None
                status = 200
                if test.mode == "api-redirect" and api:
                    status, location = 302, "https://api.github.com/other"
                elif not api and self.headers["Host"] == "github.com":
                    location = ("https://evil.invalid/fixture" if test.mode == "foreign-redirect"
                                else "https://release-assets.githubusercontent.com/fixture")
                    status = 302
                elif test.mode == "unavailable":
                    status = 503
                body = json.dumps(test.metadata).encode() if api else test.body
                if status != 200:
                    body = b""
                self.send_response(status)
                self.send_header("Content-Length", str(len(body)))
                if location:
                    self.send_header("Location", location)
                self.end_headers()
                truncated = (test.mode == "truncated" or
                             (test.mode == "early-close" and self.headers.get("Connection") == "close"))
                if truncated and body:
                    self.wfile.write(body[:len(body)//2])
                    self.close_connection = True
                else:
                    self.wfile.write(body)
                self.wfile.flush()

            def finish(self):
                try:
                    super().finish()
                finally:
                    with test.finished:
                        test.finished_count += 1
                        test.finished.notify_all()

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Peer)
        self.server.daemon_threads = False
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()
        self.addCleanup(self.close_server)

        def local_connect(connection):
            # Only route sockets: request host, headers, response parser, redirect
            # handlers, bounds and default TLS context still belong to the owner.
            self.assertTrue(connection._context.check_hostname)
            self.assertEqual(connection._context.verify_mode, ssl.CERT_REQUIRED)
            connection.sock = socket.create_connection(self.server.server_address, timeout=connection.timeout)
        self.connect_patch = patch.object(http.client.HTTPSConnection, "connect", local_connect)
        self.connect_patch.start()
        self.addCleanup(self.connect_patch.stop)
        self.temp = tempfile.TemporaryDirectory(prefix="hub-https-")
        self.addCleanup(self.temp.cleanup)
        self.root = installer.windows_filesystem_path(Path(self.temp.name))
        identity = self.root.stat()
        def remove_owned():
            if self.root.exists():
                current = self.root.lstat()
                if ((current.st_dev, current.st_ino) != (identity.st_dev, identity.st_ino)
                        or getattr(current, "st_file_attributes", 0) & 0x400):
                    raise RuntimeError("Owned fixture changed")
                shutil.rmtree(self.root)
        self.addCleanup(remove_owned)

    def close_server(self):
        self.server.shutdown()
        self.thread.join()
        self.server.server_close()

    def assert_connections_closed(self):
        with self.finished:
            self.assertTrue(self.finished.wait_for(lambda: self.finished_count == len(self.records), timeout=3),
                            "client must close each response locally, including persistent peers")

    def test_metadata_finishes_before_local_close_without_requesting_early_peer_close(self):
        self.assertEqual(installer.release_metadata("2.1.2"), self.metadata)
        self.assertEqual(len(self.records), 1)
        self.assertEqual(self.records[0]["host"], "api.github.com")
        self.assertNotEqual(self.records[0]["connection"], "close")
        self.assertEqual(self.records[0]["agent"], "AgentHub-ReadyPackage-Installer")
        self.assert_connections_closed()

    def test_asset_redirect_reads_complete_framed_body_and_closes_both_connections(self):
        target = self.root/"asset"
        installer.download(self.asset, target, max_bytes=len(self.body))
        self.assertEqual(target.read_bytes(), self.body)
        self.assertEqual([r["host"] for r in self.records], ["github.com", "release-assets.githubusercontent.com"])
        self.assertTrue(all(r["connection"] != "close" for r in self.records))
        self.assert_connections_closed()

    def retained_redirect_refusal(self, mode, message, call):
        self.mode = mode
        retained_error = retained_traceback = None
        try:
            try:
                call()
            except ValueError as error:
                # assertRaises clears traceback frames before a later assertion.
                # Keep the original error AND traceback through the peer check.
                retained_error, retained_traceback = error, error.__traceback__
            self.assertIsNotNone(retained_error, "redirect must refuse")
            self.assertIsNotNone(retained_traceback)
            self.assertIs(retained_error.__traceback__, retained_traceback)
            self.assertEqual(str(retained_error), message)
            self.assertEqual(len(self.records), 1, "no followup or retry")
            self.assertFalse((self.root/"foreign").exists())
            self.assert_connections_closed()
        finally:
            # Close the exact held responses only AFTER the assertion. A failing
            # parent's peer must still join, without clearing/replacing traceback.
            frame = retained_traceback
            responses = {}
            while frame is not None:
                for value in list(frame.tb_frame.f_locals.values()):
                    if isinstance(value, http.client.HTTPResponse):
                        responses[id(value)] = value
                frame = frame.tb_next
            for response in responses.values():
                response.close()

    def test_api_redirect_closes_with_original_refusal_traceback_retained(self):
        self.retained_redirect_refusal("api-redirect", "Release API redirects refused",
                                       lambda: installer.release_metadata("2.1.2"))
        self.assertEqual(self.records[0]["host"], "api.github.com")

    def test_foreign_asset_redirect_closes_with_original_refusal_traceback_retained(self):
        self.retained_redirect_refusal("foreign-redirect", "Untrusted release redirect",
                                       lambda: installer.download(self.asset, self.root/"foreign"))
        self.assertEqual(self.records[0]["host"], "github.com")

    def test_unconditional_truncation_is_failure_and_never_retried(self):
        self.mode = "truncated"
        with self.assertRaises((http.client.IncompleteRead, json.JSONDecodeError)):
            installer.release_metadata("2.1.2")
        self.assertEqual(len(self.records), 1)
        self.assert_connections_closed()

    def test_budget_and_http_error_still_refuse_and_close_without_retry(self):
        self.mode = "normal"
        with self.assertRaisesRegex(ValueError, "download budget"):
            installer.download(self.asset, self.root/"budget", max_bytes=8)
        before = len(self.records)
        self.mode = "unavailable"
        with self.assertRaises(urllib.error.HTTPError) as raised:
            installer.release_metadata("2.1.2")
        self.assertEqual(len(self.records), before+1)
        try:
            self.assert_connections_closed()
        finally:
            # Parent negatives must also join their fixture after a failed
            # closure assertion; this does not make that assertion pass.
            raised.exception.close()


class CertificateFailureTests(unittest.TestCase):
    def test_certificate_failure_keeps_default_validation_and_never_falls_back(self):
        handler = installer.ReleaseHTTPSHandler()
        self.assertTrue(handler._context.check_hostname)
        self.assertEqual(handler._context.verify_mode, ssl.CERT_REQUIRED)
        with closing(socket.socket()) as sock:
            with patch("socket.create_connection", return_value=sock), patch(
                    "ssl.SSLContext.wrap_socket", side_effect=ssl.SSLCertVerificationError("fixture rejection")) as tls:
                with self.assertRaises(urllib.error.URLError):
                    installer.release_metadata("2.1.2")
                self.assertEqual(tls.call_count, 1)


if __name__ == "__main__":
    unittest.main()
