"""Meter routes — GET current meter info. Registration is handled via /api/auth/meter-session."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import get_db
from app.models import User, Meter
from app.schemas import MeterOut
from app.auth import get_current_user

router = APIRouter(prefix="/api/meter", tags=["meter"])


@router.get("", response_model=MeterOut)
async def get_meter(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return the meter linked to the current session."""
    result = await db.execute(select(Meter).where(Meter.user_id == current_user.id))
    meter = result.scalar_one_or_none()
    if not meter:
        raise HTTPException(status_code=404, detail="No meter registered for this session")
    return meter
