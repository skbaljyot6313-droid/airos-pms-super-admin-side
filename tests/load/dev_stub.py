"""
Dev stub server — harness verification ONLY.

Mimics the real login contract from backend/app/api/v1/auth.py:
  - POST /api/v1/auth/login  -> 200 AuthResponse-shaped body, but enforces
    the same 10-req/60s per-IP rate limit the real app does (in-memory).
    Any identifier/password pair is accepted.
  - GET  /health, /health/db, /ready -> 200 JSON
  - GET  /api/v1/auth/me             -> 200 when Authorization: Bearer set
  - GET  /api/v1/workspace           -> 200 when Bearer set
  - POST /api/v1/auth/refresh        -> 200 {access_token}
  - emits X-Response-Time / X-DB-Time / X-DB-Queries like the real
    AccessLogMiddleware so header parsing is exercised.

This exists so `test_concurrent_login.py` can be smoke-tested offline.
It is NOT the backend and its numbers mean nothing about production.

Run:  python dev_stub.py --port 8899
"""

from __future__ import annotations

import argparse
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_WINDOW = 60.0
_LIMIT = 10
_hits: dict[str, list[float]] = {}


def _allowed(ip: str) -> bool:
    now = time.monotonic()
    hits = [t for t in _hits.get(ip, []) if now - t < _WINDOW]
    _hits[ip] = hits
    if len(hits) >= _LIMIT:
        return False
    hits.append(now)
    return True


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: dict, db_ms: float = 3.0,
              db_queries: int = 3):
        payload = json.dumps(body).encode()
        t0 = getattr(self, "_t0", time.perf_counter())
        elapsed = (time.perf_counter() - t0) * 1000
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("X-Response-Time", f"{elapsed:.0f}ms")
        self.send_header("X-DB-Time", f"{db_ms:.0f}ms")
        self.send_header("X-DB-Queries", str(db_queries))
        self.send_header("X-Request-ID", "stub-" + self.request_id)
        self.end_headers()
        self.wfile.write(payload)

    request_id = "na"

    def do_GET(self):  # noqa: N802
        self._t0 = time.perf_counter()
        import uuid
        self.request_id = uuid.uuid4().hex[:8]
        if self.path in ("/health", "/api/v1/health"):
            self._send(200, {"status": "ok", "service": "stub",
                             "env": "stub"}, db_ms=0, db_queries=0)
        elif self.path == "/health/db":
            self._send(200, {"status": "ok", "database": "connected"},
                       db_ms=1, db_queries=1)
        elif self.path == "/ready":
            self._send(200, {"status": "ok", "database": "connected",
                             "redis": "disabled", "schema": "current"})
        elif self.path.startswith("/api/v1/"):
            if not self.headers.get("authorization", "").startswith("Bearer "):
                self._send(401, {"code": "UNAUTHENTICATED",
                                 "message": "Not authenticated."}, 1, 1)
            elif self.path == "/api/v1/auth/me":
                self._send(200, {"user": {"uid": "stub-user"},
                                 "company": {"company_uid": "stub-co"}})
            elif self.path == "/api/v1/workspace":
                self._send(200, {"properties": [], "employees": []})
            else:
                self._send(404, {"code": "NOT_FOUND"})
        else:
            self._send(404, {"code": "NOT_FOUND"})

    def do_POST(self):  # noqa: N802
        self._t0 = time.perf_counter()
        import uuid
        self.request_id = uuid.uuid4().hex[:8]
        length = int(self.headers.get("content-length", 0))
        self.rfile.read(length)
        if self.path == "/api/v1/auth/login":
            if not _allowed(self.client_address[0]):
                self._send(429, {"code": "RATE_LIMITED",
                                 "message": "Too many requests."},
                           db_ms=0, db_queries=0)
                return
            # simulate argon2-ish CPU cost so histograms aren't degenerate
            t = time.perf_counter()
            while time.perf_counter() - t < 0.002:
                pass
            self._send(200, {
                "access_token": "stub-access",
                "refresh_token": "stub-refresh",
                "token_type": "bearer",
                "user": {"uid": "stub-user", "role": "super_admin"},
                "company": {"company_uid": "stub-co"},
            }, db_ms=8.0, db_queries=4)
        elif self.path == "/api/v1/auth/refresh":
            self._send(200, {"access_token": "stub-access-2",
                             "token_type": "bearer"}, db_ms=2, db_queries=1)
        else:
            self._send(404, {"code": "NOT_FOUND"})

    def log_message(self, *a):  # quiet
        pass


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8899)
    args = ap.parse_args()
    print(f"stub on http://127.0.0.1:{args.port} "
          f"(login limit {_LIMIT}/{_WINDOW:.0f}s/IP — same as real app)")
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
