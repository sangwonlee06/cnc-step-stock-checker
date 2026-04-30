# CNC STEP Stock Checker

A small FastAPI web tool that accepts `.stp` / `.step` files and returns CNC stock dimensions in inches, rounded upward to the nearest `0.001`.

## What It Does

- Drag-and-drop STEP upload.
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

## Privacy

- Uploaded STEP files are written to a temporary file only for the current analysis.
- The temporary file is deleted immediately after the result is returned, even when analysis fails.
- The application is designed not to retain uploaded STEP files as saved jobs or history.
- The backend uses `Cache-Control: no-store` on responses to reduce browser and intermediary caching.

If you deploy behind a proxy, CDN, APM agent, or platform logging layer, make sure those services are also configured not to retain upload payloads.

## Cylinder Detection

Rod classification is intentionally strict:

- At least one true OpenCASCADE cylindrical face must exist.
- Cylindrical, conical, toroidal, and spherical faces must share one central axis when present.
- Planar faces must be perpendicular to that axis, so they act as end faces.
- Faceted near-cylinders, filleted rectangular blocks, and shapes with side flats are rejected as prismatic.

This avoids the common false positive where corner fillets or near-round polygons look cylindrical from a bounding box alone.

## Local Setup

OpenCASCADE Python wheels generally support Python 3.10-3.12. Python 3.14 is too new for the CAD dependency used here.

Create a virtual environment and install dependencies:

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

### Alternative with conda

```bash
conda create -n cnc-stock python=3.11 -c conda-forge pythonocc-core fastapi uvicorn python-multipart
conda activate cnc-stock
python -m uvicorn backend.app.main:app --reload --host 127.0.0.1 --port 8000
```

## Local Run

```bash
uvicorn backend.app.main:app --reload --host 127.0.0.1 --port 8000
```

Then open:

```text
http://127.0.0.1:8000
```

If port `8000` is already in use, run on a different port:

```bash
python -m uvicorn backend.app.main:app --reload --host 127.0.0.1 --port 8001
```

To check what is already bound to port `8000` on macOS:

```bash
lsof -nP -iTCP:8000 -sTCP:LISTEN
```

## Deployment

For deployment, point your process manager or hosting platform at the ASGI app:

```text
backend.app.main:app
```

Typical production command:

```bash
uvicorn backend.app.main:app --host 0.0.0.0 --port 8000
```

Use your platform's assigned port if it injects one through environment variables.

## Core Files

- `backend/app/step_analyzer.py`: STEP parsing, bounding boxes, cylinder detection, output formatting.
- `backend/app/main.py`: FastAPI upload endpoint.
- `frontend/index.html`: Drag-and-drop UI.
- `frontend/app.js`: Upload handling and result rendering.
- `frontend/styles.css`: Minimal responsive styling.
