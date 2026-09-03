"""APScheduler-based background jobs.

All scheduled logic lives here:
- Daily poll: scrape each meter, diff with DB, insert new tokens, recompute usage
- Notification check: alert users whose days_left is below threshold
- Backfill: one-time scrape on meter registration

Runs in-process inside the FastAPI app. No Celery/Redis.
"""

import asyncio
import logging
import random
from datetime import datetime, timedelta, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.database import async_session_factory
from app.models import Meter, Token, User, UsageSnapshot
from app.scraper.kplc import scrape_meter_tokens
from app.services.usage import compute_usage, save_usage_snapshot
from app.services.notification import send_alert
from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

scheduler = AsyncIOScheduler()


def start_scheduler():
    """Start the APScheduler instance. Called once at FastAPI startup."""
    if not scheduler.running:
        # Recurring job: runs every SCRAPE_INTERVAL_HOURS (default 12h, i.e.
        # 00:00 and 12:00 UTC), processes all meters with jittered per-meter
        # execution so they don't all hit KPLC at the exact same second.
        scheduler.add_job(
            poll_all_meters,
            trigger=CronTrigger(hour=f"*/{settings.SCRAPE_INTERVAL_HOURS}", minute=0),
            id="periodic_poll",
            name="Periodic meter poll & usage recompute",
            replace_existing=True,
        )
        scheduler.start()
        logger.info(
            "Scheduler started: meter poll every %d hours (UTC)",
            settings.SCRAPE_INTERVAL_HOURS,
        )


def stop_scheduler():
    """Gracefully stop the scheduler."""
    if scheduler.running:
        scheduler.shutdown(wait=False)
        logger.info("Scheduler stopped")


async def backfill_and_schedule(meter_id: int):
    """
    One-time backfill: scrape the KPLC portal for a newly registered meter
    and seed the database with whatever history is visible.
    Called as a background task after meter registration.
    """
    async with async_session_factory() as db:
        try:
            await db.execute(select(Meter).where(Meter.id == meter_id))
            result = await db.execute(select(Meter).where(Meter.id == meter_id))
            meter = result.scalar_one_or_none()
            if not meter:
                logger.error("Backfill: meter %d not found", meter_id)
                return

            logger.info("Starting backfill for meter %s", meter.meter_number)
            await _poll_single_meter(meter, db, source="backfill_scrape")

            # Compute initial usage stats
            stats = await compute_usage(meter, db)
            await save_usage_snapshot(meter.id, stats, db)
            await db.commit()
            logger.info("Backfill complete for meter %s", meter.meter_number)
        except Exception as e:
            logger.error("Backfill failed for meter %d: %s", meter_id, e, exc_info=True)
            await db.rollback()


async def poll_all_meters():
    """
    Poll all registered meters: scrape, diff, insert new tokens, recompute usage,
    and check notification thresholds.
    Meters are processed with jitter to avoid all hitting KPLC simultaneously.
    Runs every SCRAPE_INTERVAL_HOURS (see start_scheduler).
    """
    logger.info("Periodic poll cycle started")
    async with async_session_factory() as db:
        try:
            result = await db.execute(select(Meter))
            meters = list(result.scalars().all())

            if not meters:
                logger.info("No meters registered, skipping daily poll")
                return

            # Jitter: spread meters across the scrape window
            window_seconds = settings.SCRAPE_WINDOW_HOURS * 3600
            n = len(meters)

            for i, meter in enumerate(meters):
                # Calculate stagger delay
                if n > 1:
                    delay = (i / (n - 1)) * window_seconds * random.uniform(0.8, 1.0)
                else:
                    delay = 0

                await asyncio.sleep(min(delay, 60))  # Cap per-meter delay at 60s for daily runs

                try:
                    await _poll_single_meter(meter, db, source="periodic_scrape")
                    meter.last_scrape_at = datetime.now(timezone.utc)

                    # Recompute usage
                    stats = await compute_usage(meter, db)
                    await save_usage_snapshot(meter.id, stats, db)

                    # Check notification threshold
                    await _check_and_alert(meter, stats, db)

                    await db.commit()
                    logger.info("Poll complete for meter %s", meter.meter_number)
                except Exception as e:
                    logger.error("Poll failed for meter %s: %s", meter.meter_number, e)
                    await db.rollback()

        except Exception as e:
            logger.error("Periodic poll cycle error: %s", e, exc_info=True)


async def _poll_single_meter(meter: Meter, db: AsyncSession, source: str):
    """
    Scrape a single meter, diff with existing tokens, insert new ones.
    """
    scrape_result = await scrape_meter_tokens(
        meter_number=meter.meter_number,
        account_number=meter.account_number,
    )

    if not scrape_result.success:
        logger.warning("Scrape failed for meter %s: %s", meter.meter_number,
                        scrape_result.error)
        return

    # Updating tariff if found
    if scrape_result.tariff and not meter.tariff:
        meter.tariff = scrape_result.tariff

    # Getting existing token numbers for deduplication
    existing_result = await db.execute(
        select(Token.token_number).where(Token.meter_id == meter.id)
    )
    existing_tokens = set(row[0] for row in existing_result.all())

    # Insert only new tokens
    new_count = 0
    for scraped in scrape_result.tokens:
        if scraped.token_number not in existing_tokens:
            token = Token(
                meter_id=meter.id,
                token_number=scraped.token_number,
                units=scraped.units,
                amount=scraped.amount,
                payment_mode=scraped.payment_mode,
                purchased_at=scraped.purchased_at,
                source=source,
            )
            db.add(token)
            existing_tokens.add(scraped.token_number)
            new_count += 1

    if new_count > 0:
        logger.info("Inserted %d new tokens for meter %s", new_count, meter.meter_number)
    else:
        logger.debug("No new tokens for meter %s", meter.meter_number)


async def _check_and_alert(meter: Meter, stats: dict, db: AsyncSession):
    """
    Check if a meter's days_left is below the user's notification threshold.
    Send a Telegram alert if so, respecting cooldown.
    """
    days_left = stats.get("days_left")
    if days_left is None:
        return

    # Getting the user from db
    result = await db.execute(select(User).where(User.id == meter.user_id))
    user = result.scalar_one_or_none()
    if not user or not user.telegram_chat_id:
        return

    threshold = user.notification_threshold_days
    if days_left > threshold:
        return

    # Checking cooldown
    cooldown = timedelta(hours=settings.ALERT_COOLDOWN_HOURS)
    now = datetime.now(timezone.utc)
    if meter.last_alert_sent_at and (now - meter.last_alert_sent_at) < cooldown:
        logger.debug("Alert cooldown active for meter %s", meter.meter_number)
        return

    # Send alert
    sent = await send_alert(user, stats, meter)
    if sent:
        meter.last_alert_sent_at = now
        logger.info("Alert sent for meter %s (days_left=%.1f, threshold=%.1f)",
                    meter.meter_number, days_left, threshold)
