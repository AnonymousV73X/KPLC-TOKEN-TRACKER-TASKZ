"""Dashboard API routes: current state, token history, usage snapshots."""

from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, desc, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.models import User, Meter, Token, UsageSnapshot
from app.schemas import (DashboardState, TokenOut, TokenPayerUpdate, UsageSnapshotOut)
from app.auth import get_current_user
from app.services.usage import compute_usage, save_usage_snapshot
from app.services.scheduler import _poll_single_meter

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


@router.post("/refresh")
async def refresh_kplc_data(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Trigger an immediate live fetch/scrape of tokens from KPLC for the current meter."""
    meter_result = await db.execute(select(Meter).where(Meter.user_id == current_user.id))
    meter = meter_result.scalar_one_or_none()
    if not meter:
        raise HTTPException(status_code=404, detail="No meter registered")

    try:
        await _poll_single_meter(meter, db, source="manual_fetch")
        meter.last_scrape_at = datetime.now(timezone.utc)
        stats = await compute_usage(meter, db)
        await save_usage_snapshot(meter.id, stats, db)
        await db.commit()
    except Exception as e:
        await db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to fetch from KPLC: {str(e)}")

    return {"status": "ok", "message": "KPLC data updated successfully", "last_scrape_at": meter.last_scrape_at}



@router.get("")
async def get_dashboard(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> DashboardState:
    """Return the full dashboard state for the current user's meter."""
    # Eager-load tokens to avoid lazy loading in async context
    meter_result = await db.execute(
        select(Meter)
        .where(Meter.user_id == current_user.id)
        .options(selectinload(Meter.tokens))
    )
    meter = meter_result.scalar_one_or_none()
    if not meter:
        raise HTTPException(status_code=404, detail="No meter registered")

    stats = await compute_usage(meter, db)
    await save_usage_snapshot(meter.id, stats, db)
    await db.flush()

    # Get last token from the eager-loaded list (already ordered desc)
    last_token = meter.tokens[0] if meter.tokens else None

    count_result = await db.execute(
        select(func.count(Token.id)).where(Token.meter_id == meter.id)
    )
    total_tokens = count_result.scalar() or 0

    return DashboardState(
        meter_number=meter.meter_number,
        tariff=meter.tariff,
        units_left_estimate=stats.get("units_left"),
        usage_rate=stats.get("usage_rate"),
        usage_rate_mode=stats.get("usage_rate_mode", "auto"),
        days_left=stats.get("days_left"),
        pay_before=stats.get("pay_before"),
        last_token=TokenOut.model_validate(last_token) if last_token else None,
        total_tokens_count=total_tokens,
        telegram_linked=current_user.telegram_chat_id is not None,
        last_scrape_at=meter.last_scrape_at,
    )


@router.get("/tokens", response_model=list[TokenOut])
async def get_token_history(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[TokenOut]:
    """Paginated token purchase history."""
    meter_result = await db.execute(select(Meter).where(Meter.user_id == current_user.id))
    meter = meter_result.scalar_one_or_none()
    if not meter:
        raise HTTPException(status_code=404, detail="No meter registered")

    offset = (page - 1) * per_page
    result = await db.execute(
        select(Token)
        .where(Token.meter_id == meter.id)
        .order_by(desc(Token.purchased_at))
        .offset(offset)
        .limit(per_page)
    )
    return [TokenOut.model_validate(t) for t in result.scalars().all()]


@router.get("/snapshots", response_model=list[UsageSnapshotOut])
async def get_usage_snapshots(
    days: int = Query(30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[UsageSnapshotOut]:
    """Usage snapshots over time for charting."""
    meter_result = await db.execute(select(Meter).where(Meter.user_id == current_user.id))
    meter = meter_result.scalar_one_or_none()
    if not meter:
        raise HTTPException(status_code=404, detail="No meter registered")

    since = datetime.now(timezone.utc) - timedelta(days=days)
    result = await db.execute(
        select(UsageSnapshot)
        .where(
            UsageSnapshot.meter_id == meter.id,
            UsageSnapshot.computed_at >= since,
        )
        .order_by(UsageSnapshot.computed_at.asc())
    )
    return [UsageSnapshotOut.model_validate(s) for s in result.scalars().all()]


@router.patch("/tokens/{token_id}/payer", response_model=TokenOut)
async def update_payer_label(
    token_id: int,
    payload: TokenPayerUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> TokenOut:
    """Set or clear the payer label on a token."""
    meter_result = await db.execute(select(Meter).where(Meter.user_id == current_user.id))
    meter = meter_result.scalar_one_or_none()
    if not meter:
        raise HTTPException(status_code=404, detail="No meter registered")

    result = await db.execute(
        select(Token).where(Token.id == token_id, Token.meter_id == meter.id)
    )
    token = result.scalar_one_or_none()
    if not token:
        raise HTTPException(status_code=404, detail="Token not found")

    token.payer_label = payload.payer_label
    await db.flush()
    await db.refresh(token)
    return TokenOut.model_validate(token)
