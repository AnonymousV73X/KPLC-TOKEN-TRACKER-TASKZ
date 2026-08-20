"""Telegram notification service - minimal, notification-only.

Sends outbound alerts to stored chat_ids.
No command handling beyond the /start linking flow (handled by the bot module).
"""

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import User, Meter, TelegramLinkToken
from app.config import get_settings

settings = get_settings()
logger = logging.getLogger(__name__)

_bot = None


def _get_bot():
    """Lazily initialize and return the telegram Bot instance (for sending only)."""
    global _bot
    if _bot is None and settings.TELEGRAM_BOT_TOKEN:
        from telegram import Bot
        _bot = Bot(token=settings.TELEGRAM_BOT_TOKEN)
    return _bot


def get_bot_username() -> Optional[str]:
    """Get the bot's username for link generation."""
    bot = _get_bot()
    return bot.username if bot else None


async def generate_link_token(user_id: int, db: AsyncSession) -> tuple[str, int]:
    """Generate a short-lived token for Telegram account linking."""
    import secrets

    # Invalidate existing unused tokens for this user
    existing = await db.execute(
        select(TelegramLinkToken).where(
            TelegramLinkToken.user_id == user_id,
            TelegramLinkToken.used == False,
        )
    )
    for old in existing.scalars().all():
        old.used = True

    token_str = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    expires = now + timedelta(minutes=settings.TELEGRAM_LINK_TOKEN_EXPIRE_MINUTES)

    link = TelegramLinkToken(
        user_id=user_id,
        token=token_str,
        expires_at=expires,
    )
    db.add(link)
    await db.flush()

    return token_str, int(settings.TELEGRAM_LINK_TOKEN_EXPIRE_MINUTES * 60)


async def consume_link_token(token_str: str, chat_id: int, db: AsyncSession) -> Optional[int]:
    """Consume a link token: associate the given chat_id with the token's user."""
    now = datetime.now(timezone.utc)
    result = await db.execute(
        select(TelegramLinkToken).where(
            TelegramLinkToken.token == token_str,
            TelegramLinkToken.used == False,
            TelegramLinkToken.expires_at > now,
        )
    )
    link = result.scalar_one_or_none()
    if not link:
        return None

    link.used = True

    user_result = await db.execute(select(User).where(User.id == link.user_id))
    user = user_result.scalar_one_or_none()
    if user:
        user.telegram_chat_id = chat_id
        await db.flush()
        return user.id

    return None


async def send_alert(user: User, stats: dict, meter: Meter) -> bool:
    """Send a Telegram alert to a user about low meter units."""
    bot = _get_bot()
    if not bot or not user.telegram_chat_id:
        return False

    days_left = stats.get("days_left")
    units_left = stats.get("units_left")
    pay_before = stats.get("pay_before")

    if days_left is None:
        return False

    if pay_before:
        eat = timezone(timedelta(hours=3))
        pay_str = pay_before.astimezone(eat).strftime("%d %b %Y, %H:%M")
    else:
        pay_str = "Unable to calculate"

    units_str = f"{units_left:.1f} kWh" if units_left is not None else "Unknown"
    days_str = f"{days_left:.1f} days" if days_left is not None else "Unknown"

    message = (
        f"\u26a1 <b>TASKZ \u2014 Low Units Alert</b>\n\n"
        f"Meter: <code>{meter.meter_number}</code>\n"
        f"Estimated units left: <b>{units_str}</b>\n"
        f"Estimated days left: <b>{days_str}</b>\n"
        f"Pay before: <b>{pay_str} (EAT)</b>\n\n"
        f"\u26a0\ufe0f These are estimates based on purchase history, not a live meter reading.\n"
        f"Top up soon to avoid disconnection."
    )

    try:
        await bot.send_message(
            chat_id=user.telegram_chat_id,
            text=message,
            parse_mode="HTML",
        )
        logger.info("Alert sent to user %s for meter %s", user.id, meter.meter_number)
        return True
    except Exception as e:
        logger.error("Failed to send Telegram alert to user %s: %s", user.id, e)
        return False
