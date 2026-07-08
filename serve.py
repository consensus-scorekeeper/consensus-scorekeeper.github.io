#!/usr/bin/env python3
"""Local dev server for the Consensus Scorekeeper.

Run: python serve.py [port]
Default port: 8000. Then open http://localhost:8000/index.html in a browser.
Serving from http:// (instead of file://) lets fetch() reach consensustrivia.com
through CORS proxies, which `file://` blocks as a null origin.
"""
import http.server
import sys
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
ROOT = Path(__file__).resolve().parent
PROXY_PREFIX = "/proxy/"
ALLOWED_HOSTS = {
    "www.consensustrivia.com", "consensustrivia.com",
    # Gradwrite serves packs with open CORS, so the browser normally fetches
    # them directly — this proxy is only its fallback path.
    "www.gradwritetrivia.org", "gradwritetrivia.org",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def do_GET(self):
        if self.path.startswith(PROXY_PREFIX):
            self._proxy()
            return
        super().do_GET()

    def _proxy(self):
        raw = self.path[len(PROXY_PREFIX):]
        decoded = urllib.parse.unquote(raw)
        parsed = urllib.parse.urlsplit(decoded)
        if parsed.scheme not in ("http", "https") or parsed.hostname not in ALLOWED_HOSTS:
            self.send_error(403, "Host not allowed")
            return
        # Re-encode path/query so spaces and other unsafe chars are valid for urlopen
        safe_url = urllib.parse.urlunsplit((
            parsed.scheme,
            parsed.netloc,
            urllib.parse.quote(parsed.path, safe="/"),
            urllib.parse.quote(parsed.query, safe="=&"),
            "",
        ))
        try:
            req = urllib.request.Request(safe_url, headers={"User-Agent": "consensus-stats-local-proxy"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                self.send_response(resp.status)
                ctype = resp.headers.get("Content-Type", "application/octet-stream")
                clen = resp.headers.get("Content-Length")
                self.send_header("Content-Type", ctype)
                if clen:
                    self.send_header("Content-Length", clen)
                self.end_headers()
                while True:
                    chunk = resp.read(64 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except Exception as e:
            try:
                self.send_error(502, f"Proxy error: {e}")
            except Exception:
                pass


class Server(http.server.ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        url = f"http://localhost:{PORT}/index.html"
        print(f"Serving {ROOT} at {url}")
        print("Press Ctrl+C to stop.")
        try:
            webbrowser.open(url)
        except Exception:
            pass
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down.")


if __name__ == "__main__":
    main()
