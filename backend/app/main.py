from __future__ import annotations

import json
import logging
import os
import tempfile
import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .step_analyzer import CADKernelUnavailable, StepAnalysisError, analyze_step_file


class _JSONFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "time": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if record.exc_info and record.exc_info[1]:
            entry["exception"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str)


_handler = logging.StreamHandler()
_handler.setFormatter(_JSONFormatter())
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    handlers=[_handler],
    force=True,
)

logger = logging.getLogger("step_stock")

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

logger.info(
    "Server configured: max_upload=%d MB, rate_limit=%d req / %d s",
    MAX_UPLOAD_BYTES // (1024 * 1024),
    RATE_LIMIT_REQUESTS,
    RATE_LIMIT_WINDOW_SECONDS,
)

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
        ip_address = _client_ip(request)

        if request_size > MAX_UPLOAD_BYTES:
            logger.warning("Upload rejected: size=%d bytes, ip=%s", request_size, ip_address)
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

        if _rate_limited(ip_address):
            logger.warning("Rate limit exceeded: ip=%s", ip_address)
            response = JSONResponse(
                status_code=429,
                content={"detail": "Too many analysis requests. Please wait and try again."},
            )
            response.headers["Retry-After"] = str(RATE_LIMIT_WINDOW_SECONDS)
            _apply_security_headers(response)
            return response

        logger.info("Analyze request: ip=%s, content_length=%d", ip_address, request_size)

    response = await call_next(request)
    _apply_security_headers(response)
    return response


@app.get("/")
def index() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "index.html")


@app.get("/googleb639f0cad68181c7.html")
def google_site_verification() -> FileResponse:
    return FileResponse(
        FRONTEND_DIR / "googleb639f0cad68181c7.html",
        media_type="text/html",
    )


@app.get("/favicon.ico")
def favicon() -> Response:
    return Response(status_code=204)


app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


@app.post("/api/analyze")
async def analyze(file: UploadFile = File(...)) -> dict:
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in {".stp", ".step"}:
        logger.warning("Invalid extension: %s", suffix)
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

    logger.info("Analyzing: filename=%s, size=%d bytes", file.filename, bytes_written)
    t0 = time.monotonic()
    try:
        result = analyze_step_file(tmp_path)
        elapsed = time.monotonic() - t0
        logger.info(
            "Analysis complete: filename=%s, classification=%s, material=%s, duration=%.3f s",
            file.filename,
            result.get("classification"),
            result.get("detected_material"),
            elapsed,
        )
        return result
    except CADKernelUnavailable as exc:
        logger.error("CAD kernel unavailable: %s", exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except StepAnalysisError as exc:
        logger.warning("Analysis failed: filename=%s, error=%s", file.filename, exc)
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    finally:
        await file.close()
        tmp_path.unlink(missing_ok=True)