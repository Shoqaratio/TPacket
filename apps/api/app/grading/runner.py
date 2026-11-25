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
from dataclasses import dataclass
from typing import Any

from ..config import get_settings


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


def run_grader(project: dict[str, Any], rubric: dict[str, Any]) -> GradeOutcome:
    s = get_settings()
    if not os.path.exists(s.grader_path):
        return GradeOutcome(False, error="grader bundle missing: run `npm run build -w @netlab/engine`")
    payload = json.dumps({"project": project, "rubric": rubric}).encode()
    try:
        proc = subprocess.run(
            [s.node_bin, f"--max-old-space-size={s.grader_max_heap_mb}", s.grader_path],
            input=payload,
            capture_output=True,
            timeout=s.grader_timeout_s,
            env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")},
            preexec_fn=_limits(int(s.grader_timeout_s)) if sys.platform != "win32" else None,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return GradeOutcome(False, error="grading timed out")
    try:
        out = json.loads(proc.stdout.decode() or "{}")
    except json.JSONDecodeError:
        return GradeOutcome(False, error=f"grader crashed (exit {proc.returncode})")
    if not out.get("ok"):
        return GradeOutcome(False, error=str(out.get("error", "grader error"))[:500])
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
