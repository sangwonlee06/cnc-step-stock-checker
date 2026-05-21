https://stepstockcalculator.com/

# STEP Stock Size Calculator

A STEP analysis app that accepts `.stp` / `.step` files and returns CNC stock
dimensions in inches or millimetres, rounded upward.

The current frontend is a Vite + React + TypeScript app in `frontend-react/`.
The FastAPI backend serves that React build for Railway/root-Docker deployment
and for the Electron desktop app. The older plain JavaScript frontend remains in
`frontend/` only as a reference/fallback.

## What It Does

- Drag-and-drop STEP upload (10 MB max by default).
- Parses exact B-Rep geometry through OpenCASCADE.
- Uses a precise OpenCASCADE axis-aligned bounding box for non-round parts.
- Renders STEP files in a same-origin Online3DViewer/OCCT viewer.
- Lets users uncheck hierarchy parts so excluded geometry does not contribute to the displayed stock size.
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
- Viewer runtime assets are self-hosted under `/static/vendor/` to avoid CDN runtime loading for confidential model workflows.

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

## Frontend Architecture

The production UI lives in `frontend-react/`:

- Vite builds the React TypeScript app into `frontend-react/dist/`.
- FastAPI serves `frontend-react/dist/index.html` when that build exists.
- Railway deployments using the root `Dockerfile` build and serve this React output.
- Electron runs `npm run frontend:build` before opening the local FastAPI app, so desktop also uses React.
- Docker Compose runs a separate nginx frontend service from the same React code and proxies `/api` to the backend service.

The legacy `frontend/` directory is intentionally kept in the repository for
reference and fallback, but it is not the primary UI path after building the
React frontend.

The self-hosted viewer runtime is copied into `frontend-react/public/static/vendor/`.
The app still loads:

```text
/static/vendor/o3dv.min.js
/static/vendor/occt-import-js/occt-import-js-worker.js
/static/vendor/occt-import-js/occt-import-js.js
/static/vendor/occt-import-js/occt-import-js.wasm
```

Those runtime files are allowed to use long-lived immutable cache headers, while
uploads, API responses, and the app shell remain conservative with `no-store`.

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

Install Electron and frontend dependencies:

```bash
npm install
npm --prefix frontend-react install
```

### Alternative with conda

```bash
conda create -n cnc-stock python=3.11 -c conda-forge pythonocc-core fastapi uvicorn python-multipart
conda activate cnc-stock
python -m pip install -r requirements.txt
npm install
npm --prefix frontend-react install
```

## Desktop Run

```bash
npm run desktop
```

The script first builds the React frontend, then Electron starts the FastAPI
backend on an available local port beginning at `8765` and opens the app window.

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

Build the React frontend first, then run the FastAPI app directly:

```bash
npm run frontend:build
uvicorn backend.app.main:app --reload --host 127.0.0.1 --port 8000
```

Then open:

```text
http://127.0.0.1:8000
```

If `frontend-react/dist/` is missing, FastAPI falls back to the legacy
`frontend/` directory. For the current React UI, always build the frontend first.

For frontend-only development, you can run Vite and proxy API calls to a local
FastAPI server:

```bash
uvicorn backend.app.main:app --reload --host 127.0.0.1 --port 8000
npm --prefix frontend-react run dev
```

Then open the Vite URL printed in the terminal. If the backend is not running on
the default Vite proxy target, update `frontend-react/vite.config.ts`.


## Local Docker / Railway-style Deploy

The root `Dockerfile` builds `frontend-react/` and copies the Vite output into
the backend image. Railway deployments that use this root `Dockerfile` therefore
serve the React frontend through FastAPI.

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

## Local Docker Compose

Docker Compose uses the dedicated `frontend-react/` Vite + React + TypeScript
frontend service.

Run the split frontend/backend stack:

```bash
docker compose up --build
```

Then open:

```text
http://127.0.0.1:8080
```

The `frontend` service serves the Vite production build with nginx and proxies
`/api` to the `backend` service, so browser uploads still use same-origin
requests.

## Core Files

- `backend/app/step_analyzer.py`: STEP parsing, bounding boxes, cylinder detection, output formatting.
- `backend/app/main.py`: FastAPI upload endpoint, security/cache headers, and static serving for the React build.
- `desktop/main.js`: Electron shell that starts the local backend and opens the React UI.
- `frontend-react/src/App.tsx`: React TypeScript upload, viewer, hierarchy selection, and result logic.
- `frontend-react/src/styles.css`: React frontend styling.
- `frontend-react/public/static/vendor/`: Self-hosted Online3DViewer/OCCT runtime assets.
- `frontend/`: Legacy plain JavaScript frontend kept for reference/fallback.
