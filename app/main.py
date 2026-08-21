"""
TASKZ - KPLC Prepaid Token Tracker & Blackout Alerter

FastAPI application entry point. Wires together:
- Database initialization
- Auth, meter, dashboard, settings routes
- APScheduler (in-process) for daily polling
- Telegram bot (optional, background)
- Static frontend files

Run: uvicorn app.main:app --host 0.0.0.0 --port 8000
"""

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from app.config import get_settings
from app.database import init_db
from app.services.scheduler import start_scheduler, stop_scheduler
from app.telegram_bot import start_bot, stop_bot
from app.routes import auth, meter, dashboard
from app.routes import settings as settings_routes

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan: startup and shutdown hooks."""
    # --- Startup ---
    logger.info("TASKZ starting up...")
    await init_db()
    logger.info("Database initialized")

    # Start in-process scheduler
    start_scheduler()

    # Start Telegram bot (optional — only if token is configured)
    if settings.TELEGRAM_BOT_TOKEN:
        asyncio.create_task(start_bot())
        logger.info("Telegram bot starting...")
    else:
        logger.info("Telegram bot not configured (no TELEGRAM_BOT_TOKEN)")

    logger.info("TASKZ ready")

    yield

    # --- Shutdown ---
    logger.info("TASKZ shutting down...")
    stop_scheduler()
    stop_bot()
    logger.info("TASKZ stopped")


app = FastAPI(
    title=settings.APP_NAME,
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url="/api/redoc",
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# API routes
app.include_router(auth.router)
app.include_router(meter.router)
app.include_router(dashboard.router)
app.include_router(settings_routes.router)


# --- Static files (frontend) ---
# Serve the SPA: all non-API routes fall through to index.html
import os

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")


@app.get("/api/health")
async def health():
    return {"status": "ok", "app": "TASKZ"}


# Mount static files last (catch-all)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/{full_path:path}")
async def serve_spa(full_path: str):
    """Serve the frontend SPA — any non-API route returns index.html."""
    index = os.path.join(STATIC_DIR, "index.html")
    if os.path.exists(index):
        return FileResponse(index)
    return {"detail": "Frontend not built. Place index.html in app/static/"}
