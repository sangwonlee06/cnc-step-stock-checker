from __future__ import annotations

import os
import tempfile
import time
from collections import defaultdict, deque
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .step_analyzer import CADKernelUnavailable, StepAnalysisError, analyze_step_file


ROOT = Path(__file__).resolve().parents[2]
FRONTEND_DIR = ROOT / "frontend"
MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_MB", "10")) * 1024 * 1024
RATE_LIMIT_REQUESTS = int(os.getenv("RATE_LIMIT_REQUESTS", "30"))
RATE_LIMIT_WINDOW_SECONDS = int(os.getenv("RATE_LIMIT_WINDOW_SECONDS", "300"))
TRUST_PROXY_HEADERS = os.getenv("TRUST_PROXY_HEADERS", "true").lower() in {
    "1",
    "true",
    "yes",
}

_rate_limit_buckets: defaultdict[str, deque[float]] = defaultdict(deque)


def _split_csv_env(name: str) -> list[str]:
    return [value.strip() for value in os.getenv(name, "").split(",") if value.strip()]


def _client_ip(request: Request) -> str:
    if TRUST_PROXY_HEADERS:
        forwarded_for = request.headers.get("x-forwarded-for")
        if forwarded_for:
            return forwarded_for.split(",", 1)[0].strip()

        real_ip = request.headers.get("x-real-ip")
        if real_ip:
            return real_ip.strip()

    return request.client.host if request.client else "unknown"


def _rate_limited(ip_address: str) -> bool:
    now = time.monotonic()
    bucket = _rate_limit_buckets[ip_address]
    cutoff = now - RATE_LIMIT_WINDOW_SECONDS

    while bucket and bucket[0] <= cutoff:
        bucket.popleft()

    if len(bucket) >= RATE_LIMIT_REQUESTS:
        return True

    bucket.append(now)
    return False


def _apply_security_headers(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = (
        "camera=(), microphone=(), geolocation=(), payment=()"
    )
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self'; "
        "connect-src 'self'; "
        "img-src 'self' data:; "
        "object-src 'none'; "
        "base-uri 'self'; "
        "form-action 'self'; "
        "frame-ancestors 'none'"
    )
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"

app = FastAPI(title="CNC STEP Stock Checker")

allowed_origins = _split_csv_env("ALLOWED_ORIGINS")
if allowed_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
        allow_credentials=False,
    )


@app.middleware("http")
async def security_middleware(request: Request, call_next) -> Response:
    if request.url.path == "/api/analyze":
        content_length = request.headers.get("content-length")
        request_size = int(content_length) if content_length and content_length.isdigit() else 0
        if request_size > MAX_UPLOAD_BYTES:
            response = JSONResponse(
                status_code=413,
                content={
                    "detail": (
                        f"Upload must be {MAX_UPLOAD_BYTES // (1024 * 1024)} "
                        "MB or smaller."
                    )
                },
            )
            _apply_security_headers(response)
            return response

        ip_address = _client_ip(request)
        if _rate_limited(ip_address):
            response = JSONResponse(
                status_code=429,
                content={"detail": "Too many analysis requests. Please wait and try again."},
            )
            response.headers["Retry-After"] = str(RATE_LIMIT_WINDOW_SECONDS)
            _apply_security_headers(response)
            return response

    response = await call_next(request)
    _apply_security_headers(response)
    return response


@app.get("/")
def index() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "index.html")


@app.get("/favicon.ico")
def favicon() -> Response:
    return Response(status_code=204)


app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


@app.post("/api/analyze")
async def analyze(file: UploadFile = File(...)) -> dict:
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in {".stp", ".step"}:
        raise HTTPException(status_code=400, detail="Upload a .stp or .step file.")

    bytes_written = 0
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp_path = Path(tmp.name)
        while chunk := await file.read(1024 * 1024):
            bytes_written += len(chunk)
            if bytes_written > MAX_UPLOAD_BYTES:
                tmp_path.unlink(missing_ok=True)
                raise HTTPException(
                    status_code=413,
                    detail=(
                        f"Upload must be {MAX_UPLOAD_BYTES // (1024 * 1024)} "
                        "MB or smaller."
                    ),
                )
            tmp.write(chunk)

    try:
        return analyze_step_file(tmp_path)
    except CADKernelUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except StepAnalysisError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    finally:
        await file.close()
        tmp_path.unlink(missing_ok=True)
