# Contributing Guide

## Table of Contents

- [Branching Strategy](#branching-strategy)
- [Branch Naming](#branch-naming)
- [Commit Messages](#commit-messages)
- [Pull Request Process](#pull-request-process)
- [Development Setup](#development-setup)

---

## Branching Strategy

This project follows a **GitFlow-inspired** trunk-based model with two long-lived branches:

| Branch    | Purpose                              | Deploys to  |
|-----------|--------------------------------------|-------------|
| `main`    | Stable, production-ready code        | Production  |
| `develop` | Integration branch for active work   | Staging     |

**All development work starts from `develop`.** The `main` branch is only updated via pull requests from `develop` (or hotfix branches in emergencies). Direct commits to either `main` or `develop` are not permitted.

```
main
 └── develop
      ├── feat/add-obb-export
      ├── fix/cylinder-detection-edge-case
      └── chore/upgrade-fastapi
```

---

## Branch Naming

Branch names must follow this pattern:

```
<type>/<short-description>
```

Use hyphens to separate words in the description. Keep it concise (3–5 words max).

| Type       | Use for                                                  |
|------------|----------------------------------------------------------|
| `feat/`    | A new feature or user-facing enhancement                 |
| `fix/`     | A bug fix                                                |
| `chore/`   | Maintenance tasks (dependency updates, config changes)   |
| `refactor/`| Code restructuring with no behavior change               |
| `test/`    | Adding or updating tests                                 |
| `docs/`    | Documentation changes only                               |
| `ci/`      | CI/CD pipeline changes                                   |

**Examples:**

```bash
git checkout develop
git checkout -b feat/step-file-batch-upload
git checkout -b fix/obb-calculation-overflow
git checkout -b chore/upgrade-cadquery-ocp
git checkout -b docs/update-api-reference
```

---

## Commit Messages

This project uses the **[Conventional Commits](https://www.conventionalcommits.org/)** specification.

### Format

```
<type>(<scope>): <short summary>

[optional body]

[optional footer(s)]
```

- **type**: same types as branch naming (`feat`, `fix`, `chore`, `refactor`, `test`, `docs`, `ci`)
- **scope**: the area of the codebase affected (optional but encouraged) — e.g., `backend`, `frontend`, `analyzer`, `docker`
- **summary**: imperative mood, present tense, no period, max ~72 characters

### Examples

```
feat(analyzer): add oriented bounding box for tighter stock dimensions

fix(backend): clamp OBB dimensions to AABB minimum to prevent oversizing

chore(deps): upgrade fastapi to 0.115.6

test(analyzer): add edge case coverage for near-flat cylinder detection

ci: add docker layer caching to deploy workflow
```

### Breaking Changes

Append `!` after the type/scope and add a `BREAKING CHANGE:` footer:

```
feat(api)!: change upload endpoint response schema

BREAKING CHANGE: `dimensions` field renamed to `stock` in the JSON response.
```

---

## Pull Request Process

1. **Branch off `develop`**

   ```bash
   git checkout develop
   git pull origin develop
   git checkout -b feat/your-feature
   ```

2. **Make your changes**, committing in logical, atomic units.

3. **Push your branch** and open a PR targeting `develop`:

   ```bash
   git push -u origin feat/your-feature
   ```

4. **PR requirements before merge:**
   - CI passes (tests + Docker build)
   - At least one approving review
   - No unresolved review comments
   - Branch is up to date with `develop`

5. **Merging to `main`** is done via a PR from `develop` → `main` and triggers a production deploy. This should only happen at deliberate release points.

### PR Title

PR titles must also follow Conventional Commits format — they become the squash-merge commit message on `develop`.

---

## Development Setup

### Backend

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
python -m pytest tests/ -v
```

### Running locally

```bash
# Backend only (API at http://localhost:8080)
uvicorn backend.app.main:app --reload --port 8080

# Desktop app (Electron + backend)
npm install
npm run desktop
```

### Docker

```bash
docker build -t cnc-step-stock-checker:local .
docker run --rm -p 8080:8080 cnc-step-stock-checker:local
```
