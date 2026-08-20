from datetime import datetime, timedelta, timezone
from typing import Optional
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Meter, Token, UsageSnapshot
from app.config import get_settings

settings = get_settings()
logger = __import__("logging").getLogger(__name__)


async def compute_usage(meter: Meter, db: AsyncSession) -> dict:
    """
    Compute usage stats for a meter.

    Returns dict with: usage_rate, usage_rate_mode, units_left, days_left, pay_before
    All values are estimates — no live meter read is available.
    """
    result = await db.execute(
        select(Token)
        .where(Token.meter_id == meter.id)
        .order_by(desc(Token.purchased_at))
    )
    tokens = list(result.scalars().all())

    if not tokens:
        return {
            "usage_rate": None,
            "usage_rate_mode": "auto",
            "units_left": None,
            "days_left": None,
            "pay_before": None,
        }

    now = datetime.now(timezone.utc)

    # Determine usage rate
    if meter.manual_usage_rate is not None:
        usage_rate = meter.manual_usage_rate
        mode = "manual"
    else:
        usage_rate = _calculate_auto_rate(tokens)
        mode = "auto"

    if usage_rate is None or usage_rate <= 0:
        return {
            "usage_rate": None,
            "usage_rate_mode": mode,
            "units_left": None,
            "days_left": None,
            "pay_before": None,
        }

    # Get the most recent token with purchase date and units
    latest = None
    for t in tokens:
        if t.purchased_at and t.units and t.units > 0:
            latest = t
            break

    if not latest:
        return {
            "usage_rate": usage_rate,
            "usage_rate_mode": mode,
            "units_left": None,
            "days_left": None,
            "pay_before": None,
        }

    # Make timezone-aware if needed
    purchased = latest.purchased_at
    if purchased.tzinfo is None:
        purchased = purchased.replace(tzinfo=timezone.utc)

    days_elapsed = max((now - purchased).total_seconds() / 86400.0, 0)
    units_left = max(latest.units - (days_elapsed * usage_rate), 0)
    days_left = units_left / usage_rate if usage_rate > 0 else None
    pay_before = now + timedelta(days=days_left) if days_left is not None else None

    return {
        "usage_rate": usage_rate,
        "usage_rate_mode": mode,
        "units_left": round(units_left, 2),
        "days_left": round(days_left, 1) if days_left is not None else None,
        "pay_before": pay_before,
    }


def _calculate_auto_rate(tokens: list[Token]) -> Optional[float]:
    """
    Calculate usage rate as a rolling average from recent token history.

    Uses tokens within the last USAGE_WINDOW_DAYS (default 30).
    For each consecutive pair, computes units/time and averages them.
    """
    window_days = settings.USAGE_WINDOW_DAYS
    cutoff = datetime.now(timezone.utc) - timedelta(days=window_days)

    # Filter to tokens with valid date and units within the window
    valid = []
    for t in tokens:
        if t.purchased_at and t.units and t.units > 0:
            dt = t.purchased_at
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            if dt >= cutoff:
                valid.append((dt, t.units))

    # Sort oldest first
    valid.sort(key=lambda x: x[0])

    if len(valid) < 2:
        # Not enough data points for a rate calculation
        return None

    rates = []
    for i in range(1, len(valid)):
        prev_dt, prev_units = valid[i - 1]
        curr_dt, curr_units = valid[i]
        days_between = (curr_dt - prev_dt).total_seconds() / 86400.0
        if days_between > 0:
            # Usage rate = units consumed per day
            # The previous token's units represent what was available at that time.
            # By the time the next token was purchased, most of those units were consumed.
            # So rate ≈ prev_units / days_between
            rate = prev_units / days_between
            if rate > 0:
                rates.append(rate)

    if not rates:
        return None

    # Return the median to be robust against outliers
    rates.sort()
    mid = len(rates) // 2
    if len(rates) % 2 == 0:
        return (rates[mid - 1] + rates[mid]) / 2.0
    return rates[mid]


async def save_usage_snapshot(meter_id: int, stats: dict, db: AsyncSession):
    """Persist a usage snapshot for trend charting."""
    snapshot = UsageSnapshot(
        meter_id=meter_id,
        units_left_estimate=stats.get("units_left"),
        usage_rate=stats.get("usage_rate"),
        days_left=stats.get("days_left"),
        pay_before=stats.get("pay_before"),
    )
    db.add(snapshot)
    await db.flush()
    return snapshot
