"""Optional generative assistant behind TPacket Tutor.

Disabled unless NETLAB_AI_URL is set (any OpenAI-compatible /chat/completions endpoint: a hosted
API, Ollama, vLLM…). The platform works fully without it: the deterministic diagnosis runs in the
browser. When an assignment forbids the tutor, the request is refused server-side; during graded
work the model is instructed never to give the full solution.
"""

import asyncio
import json
import urllib.request

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..deps import current_user
from ..models import User
from ..security import RateLimiter
from .classes import _assignment

router = APIRouter(prefix="/api/tutor", tags=["tutor"])
limiter = RateLimiter(30, 3600)


class AskIn(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    diagnosis: str = Field(default="", max_length=4000)
    assignment_id: str | None = None
    locale: str = Field(default="fr", pattern="^(fr|en)$")


@router.get("/ai/status")
def status(u: User = Depends(current_user)):
    return {"enabled": bool(get_settings().ai_url)}


def _call(url: str, key: str | None, model: str, messages: list[dict]) -> str:
    req = urllib.request.Request(
        url.rstrip("/") + "/chat/completions",
        data=json.dumps({"model": model, "messages": messages, "temperature": 0.2, "max_tokens": 400}).encode(),
        headers={"content-type": "application/json", **({"authorization": f"Bearer {key}"} if key else {})},
    )
    with urllib.request.urlopen(req, timeout=30) as r:  # noqa: S310 - URL comes from server configuration only
        data = json.loads(r.read())
    return data["choices"][0]["message"]["content"]


@router.post("/ai")
async def ask(body: AskIn, u: User = Depends(current_user), db: Session = Depends(get_db)):
    s = get_settings()
    if not s.ai_url:
        raise HTTPException(404, "ai_disabled")
    graded = False
    if body.assignment_id:
        a, _, staff = _assignment(db, u, body.assignment_id)
        if not a.allow_tutor and not staff:
            raise HTTPException(403, "tutor_disabled")
        graded = not staff
    if not limiter.hit(u.id):
        raise HTTPException(429, "too_many_requests")
    lang = "français" if body.locale == "fr" else "English"
    system = (
        f"Tu es TPacket Tutor, assistant pédagogique réseau pour des étudiants de BTS SIO. Réponds en {lang}, "
        "brièvement, par questions guidées et indices progressifs. Appuie-toi sur le diagnostic fourni (calculé par le simulateur). "
        + ("Le travail est noté : ne donne JAMAIS la configuration complète ni la solution, seulement des pistes." if graded else "")
    )
    messages = [{"role": "system", "content": system}, {"role": "user", "content": f"Diagnostic du simulateur :\n{body.diagnosis}\n\nQuestion : {body.question}"}]
    try:
        answer = await asyncio.to_thread(_call, s.ai_url, s.ai_key, s.ai_model, messages)
    except Exception:  # noqa: BLE001
        raise HTTPException(502, "ai_unavailable") from None
    return {"answer": answer[:4000]}
