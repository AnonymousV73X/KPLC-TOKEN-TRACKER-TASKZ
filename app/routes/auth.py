"""Auth routes: meter-based auto-session (no registration or password required)."""

from fastapi import APIRouter, Depends, BackgroundTasks
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import User, Meter
from app.schemas import MeterSessionRequest, TokenResponse, UserOut
from app.auth import create_access_token, get_current_user
from app.services.scheduler import backfill_and_schedule

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/meter-session", response_model=TokenResponse)
async def meter_session(
    payload: MeterSessionRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    """
    Enter a meter number → get a session token back.
    If this meter number hasn't been seen before, a new account + meter row is
    auto-created and an initial token backfill is kicked off in the background.
    Returning users get their existing session token refreshed instantly.
    """
    meter_number = payload.meter_number.strip()

    # Check if this meter already exists
    result = await db.execute(select(Meter).where(Meter.meter_number == meter_number))
    existing_meter = result.scalar_one_or_none()

    if existing_meter:
        # Returning user — issue a fresh token for the linked user
        access_token = create_access_token({"sub": str(existing_meter.user_id)})
        return TokenResponse(access_token=access_token, is_new=False)

    # New meter — auto-create a user account and meter row
    user = User()  # no email/password needed
    db.add(user)
    await db.flush()  # get user.id

    meter = Meter(
        user_id=user.id,
        meter_number=meter_number,
        account_number=payload.account_number.strip() if payload.account_number else None,
    )
    db.add(meter)
    await db.flush()  # get meter.id

    # Kick off backfill in background (scrape KPLC portal for token history)
    background_tasks.add_task(backfill_and_schedule, meter.id)

    access_token = create_access_token({"sub": str(user.id)})
    return TokenResponse(access_token=access_token, is_new=True)


@router.get("/me", response_model=UserOut)
async def me(current_user: User = Depends(get_current_user)):
    """Return the current session's user info."""
    return current_user
