from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .routers import auth, campus, classes, collab, courses, exercises, features, orgs, projects, tutor


def create_app() -> FastAPI:
    s = get_settings()
    app = FastAPI(
        title="TPacket API",
        version="0.1.0",
        description="Plateforme pédagogique réseau — API REST. Documentation OpenAPI : /api/docs",
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=s.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["content-type", "x-csrf-token"],
    )
    app.state.campus_rooms = {}
    app.state.campus_recent = {}

    @app.middleware("http")
    async def security_headers(request, call_next):
        resp = await call_next(request)
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("Referrer-Policy", "same-origin")
        resp.headers.setdefault("X-Frame-Options", "DENY")
        return resp

    @app.get("/api/health", tags=["ops"])
    def health():
        return {"status": "ok"}

    for r in (auth.router, orgs.router, projects.router, exercises.router, courses.router, classes.router, collab.router, tutor.router, features.router, campus.router):
        app.include_router(r)
    return app


app = create_app()
