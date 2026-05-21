from fastapi.testclient import TestClient

from backend.app import main as app_main


def test_security_headers_are_applied() -> None:
    client = TestClient(app_main.app)

    response = client.get("/")

    assert response.status_code == 200
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"
    csp = response.headers["content-security-policy"]
    assert "frame-ancestors 'none'" in csp
    assert "'unsafe-eval'" in csp
    assert "worker-src 'self';" in csp
    assert "connect-src 'self';" in csp
    assert "https://cdn.jsdelivr.net" not in csp
    assert "https://static.cloudflareinsights.com" not in csp
    assert "https://cloudflareinsights.com" not in csp
    assert response.headers["cache-control"] == "no-store"


def test_oversized_request_is_rejected_before_parsing() -> None:
    client = TestClient(app_main.app)

    response = client.post(
        "/api/analyze",
        content=b"x",
        headers={"content-length": str(app_main.MAX_UPLOAD_BYTES + 1)},
    )

    assert response.status_code == 413
    assert "Upload must be" in response.json()["detail"]


def test_rate_limiter_blocks_after_limit(monkeypatch) -> None:
    monkeypatch.setattr(app_main, "RATE_LIMIT_REQUESTS", 2)
    monkeypatch.setattr(app_main, "RATE_LIMIT_WINDOW_SECONDS", 300)
    app_main._rate_limit_buckets.clear()

    assert app_main._rate_limited("203.0.113.10") is False
    assert app_main._rate_limited("203.0.113.10") is False
    assert app_main._rate_limited("203.0.113.10") is True
