"""Meter registration route."""

from fastapi import APIRouter, Depends, HTTPException, status, BackgroundTasks
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import get_db
from app.models import User, Meter
from app.schemas import MeterRegister, MeterOut
from app.auth import get_current_user
from app.services.scheduler import backfill_and_schedule

router = APIRouter(prefix="/api/meter", tags=["meter"])


@router.post("/register", response_model=MeterOut, status_code=status.HTTP_201_CREATED)
async def register_meter(
    payload: MeterRegister,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # One meter per user — check existing
    existing = await db.execute(select(Meter).where(Meter.user_id == current_user.id))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Account already has a meter registered. "
                            "One meter per account.")

    meter = Meter(
        user_id=current_user.id,
        meter_number=payload.meter_number.strip(),
        account_number=payload.account_number.strip() if payload.account_number else None,
    )
    db.add(meter)
    await db.flush()

    # Kick off one-time backfill in background, then schedule daily polling
    background_tasks.add_task(backfill_and_schedule, meter.id)

    await db.refresh(meter)
    return meter


@router.get("", response_model=MeterOut)
async def get_meter(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(Meter).where(Meter.user_id == current_user.id))
    meter = result.scalar_one_or_none()
    if not meter:
        raise HTTPException(status_code=404, detail="No meter registered for this account")
    return meter
