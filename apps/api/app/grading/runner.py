"""Runs the TypeScript engine's bundled grader (packages/engine/dist/grader.mjs) in a subprocess.

The browser and the server execute the very same simulation code; the server never trusts
a score computed by the client. The subprocess gets an empty environment, a CPU-time limit,
a V8 heap cap and a wall-clock timeout. In production the API container itself runs as an
unprivileged user without outbound network access (see docker-compose.yml).
"""

import json
import os
import subprocess
import sys
import threading
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException

from ..config import get_settings
from ..security import RateLimiter

# Bounded pool of grader subprocesses: requests beyond it queue instead of exhausting CPU and threads.
_slots = threading.BoundedSemaphore(max(1, get_settings().grader_concurrency))

# Per-user limits for the endpoints that start the grader (keyed by user id).
check_limiter = RateLimiter(get_settings().checks_per_minute, 60)
submit_limiter = RateLimiter(get_settings().submissions_per_minute, 60)

GRADER_BUSY = "grader busy"


def limit_checks(user_id: str) -> None:
    if not check_limiter.hit(user_id):
        raise HTTPException(429, "too_many_requests")


def limit_submissions(user_id: str) -> None:
    if not submit_limiter.hit(user_id):
        raise HTTPException(429, "too_many_requests")


@dataclass
class GradeOutcome:
    ok: bool
    report: dict[str, Any] | None = None
    error: str | None = None


def _limits(cpu_s: int):
    def apply():  # pragma: no cover - runs in the child
        import resource

        resource.setrlimit(resource.RLIMIT_CPU, (cpu_s, cpu_s))
        resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))

    return apply


def run_grader(project: dict[str, Any], rubric: dict[str, Any], wait_s: float | None = None) -> GradeOutcome:
    """Runs the grader once a slot is free. `wait_s=None` waits indefinitely (background jobs);
    otherwise gives up after `wait_s` seconds and returns GRADER_BUSY."""
    acquired = _slots.acquire() if wait_s is None else _slots.acquire(timeout=wait_s)
    if not acquired:
        return GradeOutcome(False, error=GRADER_BUSY)
    try:
        return _run(project, rubric)
    finally:
        _slots.release()


def _run(project: dict[str, Any], rubric: dict[str, Any]) -> GradeOutcome:
    s = get_settings()
    if not os.path.exists(s.grader_path):
        return GradeOutcome(False, error="grader bundle missing: run `npm run build -w @netlab/engine`")
    payload = json.dumps({"project": project, "rubric": rubric}).encode()
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin")}
    if sys.platform == "win32" and "SYSTEMROOT" in os.environ:
        env["SYSTEMROOT"] = os.environ["SYSTEMROOT"]  # Node's Windows crypto initialization needs this.
    try:
        proc = subprocess.run(
            [s.node_bin, f"--max-old-space-size={s.grader_max_heap_mb}", s.grader_path],
            input=payload,
            capture_output=True,
            timeout=s.grader_timeout_s,
            env=env,
            preexec_fn=_limits(int(s.grader_timeout_s)) if sys.platform != "win32" else None,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return GradeOutcome(False, error="grading timed out")
    try:
        out = json.loads(proc.stdout.decode() or "{}")
    except json.JSONDecodeError:
        return GradeOutcome(False, error=f"grader crashed (exit {proc.returncode})")
    if not isinstance(out, dict) or not out.get("ok"):
        err = out.get("error", "grader error") if isinstance(out, dict) else "grader error"
        return GradeOutcome(False, error=str(err)[:500])
    if not isinstance(out.get("report"), dict):
        return GradeOutcome(False, error="grader returned no report")
    return GradeOutcome(True, report=out["report"])


def student_view(report: dict[str, Any], reveal_hidden: bool) -> dict[str, Any]:
    """Removes hidden tests (name, message, points) from what a student can see."""
    if reveal_hidden:
        return report
    visible = [r for r in report["results"] if not r.get("hidden")]
    hidden = [r for r in report["results"] if r.get("hidden")]
    return {
        **report,
        "results": visible,
        "hidden_summary": {"count": len(hidden), "passed": sum(1 for r in hidden if r["passed"])},
    }
