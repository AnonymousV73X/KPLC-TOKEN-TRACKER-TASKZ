"""Settings API routes: manual rate override, notification threshold, Telegram linking."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import User, Meter
from app.schemas import SettingsUpdate, TelegramLinkResponse
from app.auth import get_current_user
from app.services.notification import generate_link_token, get_bot_username

router = APIRouter(prefix="/api/settings", tags=["settings"])


@router.get("")
async def get_settings(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Get current user settings."""
    meter_result = await db.execute(select(Meter).where(Meter.user_id == current_user.id))
    meter = meter_result.scalar_one_or_none()

    return {
        "manual_usage_rate": meter.manual_usage_rate if meter else None,
        "usage_rate_mode": "manual" if (meter and meter.manual_usage_rate) else "auto",
        "notification_threshold_days": current_user.notification_threshold_days,
        "telegram_linked": current_user.telegram_chat_id is not None,
        "telegram_chat_id": current_user.telegram_chat_id,
    }


@router.patch("")
async def update_settings(
    payload: SettingsUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Update user settings: manual usage rate and/or notification threshold."""
    meter_result = await db.execute(select(Meter).where(Meter.user_id == current_user.id))
    meter = meter_result.scalar_one_or_none()
    if not meter:
        raise HTTPException(status_code=404, detail="No meter registered")

    if payload.manual_usage_rate is not None:
        meter.manual_usage_rate = payload.manual_usage_rate

    if payload.notification_threshold_days is not None:
        current_user.notification_threshold_days = payload.notification_threshold_days

    await db.flush()

    return {
        "manual_usage_rate": meter.manual_usage_rate,
        "usage_rate_mode": "manual" if meter.manual_usage_rate else "auto",
        "notification_threshold_days": current_user.notification_threshold_days,
        "telegram_linked": current_user.telegram_chat_id is not None,
    }


@router.post("/telegram/link", response_model=TelegramLinkResponse)
async def create_telegram_link(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> TelegramLinkResponse:
    """Generate a short-lived link token for Telegram account linking."""
    token_str, expires_in = await generate_link_token(current_user.id, db)
    bot_username = get_bot_username()
    return TelegramLinkResponse(
        link_token=token_str,
        bot_username=bot_username,
        expires_in_seconds=expires_in,
    )


@router.delete("/telegram/link")
async def unlink_telegram(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Unlink Telegram account."""
    current_user.telegram_chat_id = None
    await db.flush()
    return {"detail": "Telegram unlinked"}
