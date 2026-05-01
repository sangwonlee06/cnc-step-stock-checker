# CNC STEP Stock Checker Desktop

A desktop STEP analysis app that accepts `.stp` / `.step` files and returns CNC
stock dimensions in inches or millimetres, rounded upward.

The desktop app uses Electron for the window and starts the existing FastAPI
analysis backend locally on `127.0.0.1`. Files are processed on the user's
machine instead of a hosted server.

## What It Does

- Drag-and-drop STEP upload (1 MB max).
- Parses exact B-Rep geometry through OpenCASCADE.
- Uses a precise OpenCASCADE axis-aligned bounding box for non-round parts.
- Returns prismatic stock as:

  ```text
  X.XXX X Y.YYY X Z.ZZZ
  ```

- Returns rod stock as:

  ```text
  DIA D.DDD X L.LLL
  ```

- Adds no machining allowance or buffer.
- Toggle between **inches** (rounded up to 0.001 in) and **millimetres** (rounded up to 0.01 mm) using the IN/MM button.

## Privacy

- In desktop mode, STEP files stay on the local machine.
- Uploaded STEP files are written to a temporary file only for the current analysis.
- The temporary file is deleted immediately after the result is returned, even when analysis fails.
- The application is designed not to retain uploaded STEP files as saved jobs or history.
- The backend uses `Cache-Control: no-store` on responses to reduce browser and intermediary caching.

If you deploy behind a proxy, CDN, APM agent, or platform logging layer, make sure those services are also configured not to retain upload payloads.

## Security

The local backend applies baseline protections:

- Security headers, including CSP, frame blocking, MIME sniffing protection, referrer policy, permissions policy, and HSTS.
- Upload size limiting for STEP files.
- Per-client rate limiting on `/api/analyze`.
- No wildcard CORS by default. The frontend uses same-origin API requests.

Optional environment variables:

```text
MAX_UPLOAD_MB=1
RATE_LIMIT_REQUESTS=30
RATE_LIMIT_WINDOW_SECONDS=300
TRUST_PROXY_HEADERS=true
ALLOWED_ORIGINS=https://your-domain.com,https://www.your-domain.com
```

Set `ALLOWED_ORIGINS` only if another origin needs browser access to the API.

## Cylinder Detection

Rod classification is intentionally strict:

- At least one true OpenCASCADE cylindrical face must exist.
- Cylindrical, conical, toroidal, and spherical faces must share one central axis when present.
- Planar faces must be perpendicular to that axis, so they act as end faces.
- Faceted near-cylinders, filleted rectangular blocks, and shapes with side flats are rejected as prismatic.

This avoids the common false positive where corner fillets or near-round polygons look cylindrical from a bounding box alone.

## Setup

OpenCASCADE Python wheels generally support Python 3.10-3.12. Python 3.14 is too new for the CAD dependency used here.

Create a Python virtual environment and install backend dependencies:

```bash
cd cnc-step-stock-checker
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

Do not use the system `python3` here unless it resolves to Python 3.12 or lower. On this Mac, `python3` resolves to Python 3.14 and will not install `cadquery-ocp`.

If `python3.12` is not available on your machine, install Python 3.12 from python.org, Homebrew, pyenv, or another package manager first.

If the OpenCASCADE wheel does not install cleanly on macOS, use the conda option below.

Install Electron dependencies:

```bash
npm install
```

### Alternative with conda

```bash
conda create -n cnc-stock python=3.11 -c conda-forge pythonocc-core fastapi uvicorn python-multipart
conda activate cnc-stock
python -m pip install -r requirements.txt
npm install
```

## Desktop Run

```bash
npm run desktop
```

The Electron app starts the FastAPI backend on an available local port beginning
at `8765`, then opens the app window.

If the Python executable is not auto-detected, set `PYTHON` explicitly:

```bash
PYTHON=/path/to/python3.12 npm run desktop
```

## Desktop Package

Create an Electron build:

```bash
npm run dist
```

Current packaging note: the Electron package includes the app code, but it does
not bundle a Python runtime or Python site packages. The machine running the
packaged app still needs Python 3.12 and the dependencies from `requirements.txt`
installed, or `PYTHON` must point to a compatible environment.

## Local Web Run

You can still run the FastAPI web app directly:

```bash
uvicorn backend.app.main:app --reload --host 127.0.0.1 --port 8000
```

Then open:

```text
http://127.0.0.1:8000
```

## Local Docker

Build the production image from the repository root:

```bash
docker build -t cnc-step-stock-checker:local .
```

Run it locally:

```bash
docker run --rm \
  -p 8080:8080 \
  -e PORT=8080 \
  cnc-step-stock-checker:local
```

Then open:

```text
http://127.0.0.1:8080
```

The container uses Python 3.12 and starts the ASGI app at:

```text
backend.app.main:app
```

## Core Files

- `backend/app/step_analyzer.py`: STEP parsing, bounding boxes, cylinder detection, output formatting.
- `backend/app/main.py`: FastAPI upload endpoint.
- `desktop/main.js`: Electron shell that starts the local backend and opens the app window.
- `frontend/index.html`: Drag-and-drop UI.
- `frontend/app.js`: Upload handling and result rendering.
- `frontend/styles.css`: Minimal responsive styling.
