"""
Related matching worker (local FastAPI) — no service keys.

Cloudflare Worker (logged-in session) calls POST /v1/enqueue.
This process pulls the catalog, runs MiniLM, pushes suggestions back
using a per-job callback token (created by the Worker, not a user secret).

Run:
  pip install -r requirements.txt
  uvicorn app:app --host 0.0.0.0 --port 8788

Expose with cloudflared if needed, then set Worker var RELATED_BACKEND_URL.
"""

from __future__ import annotations

import os
import threading
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import urlparse

import httpx
from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from semantic_engine import compute_related_suggestions

DEFAULT_THRESHOLD = float(os.environ.get("RELATED_THRESHOLD", "0.50"))
DEFAULT_TOP_K = int(os.environ.get("RELATED_TOP_K", "10"))
MODEL_PATH = os.environ.get("MODEL_PATH", "").strip() or None
ALLOWED_HOSTS = {
    h.strip().lower()
    for h in os.environ.get(
        "ALLOWED_WORKER_HOSTS",
        "cleanup23.tabletoptools.cc",
    ).split(",")
    if h.strip()
}

_jobs_lock = threading.Lock()
_jobs: dict[str, dict[str, Any]] = {}


class EnqueueBody(BaseModel):
    job_id: str = Field(min_length=4, max_length=64)
    worker_base: str = Field(min_length=8, max_length=200)
    callback_token: str = Field(min_length=8, max_length=128)
    threshold: float | None = None
    top_k: int | None = None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    print(f"Related worker ready · allowed hosts: {sorted(ALLOWED_HOSTS)}")
    yield


app = FastAPI(title="Cleanup Related Worker", version="1.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


def _set_job(job_id: str, **fields: Any) -> None:
    with _jobs_lock:
        cur = _jobs.get(job_id) or {}
        cur.update(fields)
        _jobs[job_id] = cur


def _check_worker_base(worker_base: str) -> str:
    base = worker_base.rstrip("/")
    parsed = urlparse(base)
    if parsed.scheme not in ("https", "http"):
        raise HTTPException(400, "worker_base must be http(s)")
    host = (parsed.hostname or "").lower()
    if host not in ALLOWED_HOSTS and host not in {"127.0.0.1", "localhost"}:
        raise HTTPException(400, f"worker host not allowed: {host}")
    return base


@app.get("/health")
def health():
    return {"ok": True, "allowed_hosts": sorted(ALLOWED_HOSTS)}


@app.get("/v1/jobs/{job_id}")
def job_status(job_id: str):
    with _jobs_lock:
        return _jobs.get(job_id) or {"status": "unknown"}


def _post_status(client: httpx.Client, base: str, job_id: str, token: str, body: dict) -> None:
    client.put(
        f"{base}/api/related-callback/{job_id}/status",
        params={"token": token},
        json=body,
        timeout=60.0,
    )


def _run_job(job_id: str, worker_base: str, token: str, threshold: float, top_k: int) -> None:
    base = worker_base.rstrip("/")
    _set_job(job_id, status="running", progress=0, detail="starting")

    try:
        with httpx.Client(timeout=180.0) as client:
            _post_status(
                client,
                base,
                job_id,
                token,
                {"status": "running", "progress": 0.02, "detail": "Fetching catalog…"},
            )
            cat = client.get(
                f"{base}/api/related-callback/{job_id}/catalog",
                params={"token": token},
                timeout=180.0,
            )
            if cat.status_code != 200:
                raise RuntimeError(f"catalog fetch failed: {cat.status_code} {cat.text[:240]}")
            products = (cat.json() or {}).get("products") or []
            _set_job(job_id, n_products=len(products))

            def on_prog(msg: str) -> None:
                # Map engine stages roughly onto 5%–90%
                detail = msg.replace("[Related] ", "")
                progress = 0.1
                if detail.startswith("1/"):
                    progress = 0.08
                elif detail.startswith("2/"):
                    progress = 0.15
                elif detail.startswith("3/"):
                    progress = 0.35
                elif detail.startswith("4/"):
                    # try parse bar percent
                    progress = 0.45
                    if "%" in detail:
                        try:
                            pct = float(detail.split("%")[0].split()[-1])
                            progress = 0.45 + 0.45 * (pct / 100.0)
                        except ValueError:
                            pass
                elif detail.startswith("Done"):
                    progress = 0.92
                _set_job(job_id, detail=detail, progress=progress)
                try:
                    _post_status(
                        client,
                        base,
                        job_id,
                        token,
                        {"status": "running", "progress": progress, "detail": detail[:240]},
                    )
                except Exception:
                    pass

            _post_status(
                client,
                base,
                job_id,
                token,
                {
                    "status": "running",
                    "progress": 0.1,
                    "detail": f"Embedding {len(products):,} products…",
                },
            )
            suggestions = compute_related_suggestions(
                products,
                threshold=threshold,
                top_k=top_k,
                model_path=MODEL_PATH,
                progress_cb=on_prog,
            )

            _post_status(
                client,
                base,
                job_id,
                token,
                {
                    "status": "running",
                    "progress": 0.93,
                    "detail": f"Uploading {len(suggestions):,} suggestions…",
                },
            )
            # Clear + upload
            client.delete(
                f"{base}/api/related-callback/{job_id}/semantic",
                params={"token": token},
                timeout=60.0,
            )
            chunk = 400
            for i in range(0, len(suggestions), chunk):
                slice_ = suggestions[i : i + chunk]
                res = client.post(
                    f"{base}/api/related-callback/{job_id}/semantic",
                    params={"token": token},
                    json={"items": slice_},
                    timeout=120.0,
                )
                if res.status_code >= 300:
                    raise RuntimeError(f"upload failed: {res.status_code} {res.text[:240]}")
                done = min(i + chunk, len(suggestions))
                progress = 0.93 + 0.06 * (done / max(len(suggestions), 1))
                _post_status(
                    client,
                    base,
                    job_id,
                    token,
                    {
                        "status": "running",
                        "progress": progress,
                        "detail": f"Uploaded {done:,}/{len(suggestions):,} suggestions",
                    },
                )

            _post_status(
                client,
                base,
                job_id,
                token,
                {
                    "status": "done",
                    "progress": 1,
                    "detail": "complete",
                    "n_suggestions": len(suggestions),
                },
            )
            _set_job(job_id, status="done", progress=1, n_suggestions=len(suggestions))
    except Exception as exc:  # noqa: BLE001
        err = str(exc)
        _set_job(job_id, status="failed", error=err)
        try:
            with httpx.Client(timeout=30.0) as client:
                _post_status(
                    client,
                    base,
                    job_id,
                    token,
                    {"status": "failed", "progress": 0, "detail": err[:240], "error": err[:500]},
                )
        except Exception:
            pass


@app.post("/v1/enqueue")
def enqueue(body: EnqueueBody, background_tasks: BackgroundTasks):
    base = _check_worker_base(body.worker_base)
    thr = float(body.threshold) if body.threshold is not None else DEFAULT_THRESHOLD
    top_k = int(body.top_k) if body.top_k is not None else DEFAULT_TOP_K
    thr = max(0.1, min(thr, 0.99))
    top_k = max(1, min(top_k, 20))

    _set_job(body.job_id, status="queued", progress=0, detail="queued")

    def _bg():
        _run_job(body.job_id, base, body.callback_token, thr, top_k)

    background_tasks.add_task(_bg)
    return {"ok": True, "status": "queued", "job_id": body.job_id}
