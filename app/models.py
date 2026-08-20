from sqlalchemy import (Column, Integer, String, Float, DateTime, ForeignKey, Boolean,
    Text, UniqueConstraint)
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from app.database import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    # Credentials are optional — accounts are auto-created from meter number
    email = Column(String(255), unique=True, nullable=True, index=True)
    username = Column(String(150), unique=True, nullable=True, index=True)
    password_hash = Column(String(255), nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    telegram_chat_id = Column(Integer, nullable=True, unique=True)
    notification_threshold_days = Column(Float, nullable=False, default=1.0)

    # relationships
    meter = relationship("Meter", back_populates="user", uselist=False,
                         cascade="all, delete-orphan")


class Meter(Base):
    __tablename__ = "meters"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), unique=True, nullable=False)
    meter_number = Column(String(50), nullable=False, unique=True, index=True)
    account_number = Column(String(50), nullable=True)
    tariff = Column(String(100), nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    # usage overrides
    manual_usage_rate = Column(Float, nullable=True)  # None = AUTO mode

    # notification tracking
    last_alert_sent_at = Column(DateTime, nullable=True)
    last_scrape_at = Column(DateTime, nullable=True)

    # relationships
    user = relationship("User", back_populates="meter")
    tokens = relationship("Token", back_populates="meter",
                          order_by="Token.purchased_at.desc()",
                          cascade="all, delete-orphan")
    usage_snapshots = relationship("UsageSnapshot", back_populates="meter",
                                   cascade="all, delete-orphan")


class Token(Base):
    __tablename__ = "tokens"
    __table_args__ = (
        UniqueConstraint("meter_id", "token_number", name="uq_meter_token"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    meter_id = Column(Integer, ForeignKey("meters.id"), nullable=False, index=True)
    token_number = Column(String(50), nullable=False)  # dedup key
    units = Column(Float, nullable=True)
    amount = Column(Float, nullable=True)
    payment_mode = Column(String(100), nullable=True)
    purchased_at = Column(DateTime, nullable=True)
    payer_label = Column(String(100), nullable=True)
    source = Column(String(20), nullable=False, default="daily_scrape")
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    # relationships
    meter = relationship("Meter", back_populates="tokens")


class UsageSnapshot(Base):
    __tablename__ = "usage_snapshots"

    id = Column(Integer, primary_key=True, autoincrement=True)
    meter_id = Column(Integer, ForeignKey("meters.id"), nullable=False, index=True)
    computed_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    units_left_estimate = Column(Float, nullable=True)
    usage_rate = Column(Float, nullable=True)
    days_left = Column(Float, nullable=True)
    pay_before = Column(DateTime, nullable=True)

    # relationships
    meter = relationship("Meter", back_populates="usage_snapshots")


class TelegramLinkToken(Base):
    """Short-lived tokens for linking a Telegram chat_id to a user account."""
    __tablename__ = "telegram_link_tokens"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    token = Column(String(64), unique=True, nullable=False, index=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    expires_at = Column(DateTime, nullable=False)
    used = Column(Boolean, default=False)
