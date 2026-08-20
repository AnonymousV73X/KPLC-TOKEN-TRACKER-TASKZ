"""Pydantic schemas for request/response validation."""

from pydantic import BaseModel, EmailStr, Field
from datetime import datetime
from typing import Optional


# ---- Auth ----

class UserRegister(BaseModel):
    email: EmailStr
    username: str = Field(min_length=3, max_length=150)
    password: str = Field(min_length=6, max_length=128)


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserOut(BaseModel):
    id: int
    email: str
    username: str
    telegram_chat_id: Optional[int] = None
    notification_threshold_days: float
    created_at: datetime

    model_config = {"from_attributes": True}


# ---- Meter ----

class MeterRegister(BaseModel):
    meter_number: str = Field(min_length=1, max_length=50)
    account_number: Optional[str] = Field(default=None, max_length=50)


class MeterOut(BaseModel):
    id: int
    meter_number: str
    account_number: Optional[str]
    tariff: Optional[str]
    created_at: datetime
    manual_usage_rate: Optional[float]
    last_scrape_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


# ---- Token (purchase record) ----

class TokenOut(BaseModel):
    id: int
    token_number: str
    units: Optional[float]
    amount: Optional[float]
    payment_mode: Optional[str]
    purchased_at: Optional[datetime]
    payer_label: Optional[str]
    source: str

    model_config = {"from_attributes": True}


class TokenPayerUpdate(BaseModel):
    payer_label: Optional[str] = None


# ---- Dashboard ----

class DashboardState(BaseModel):
    meter_number: str
    tariff: Optional[str]
    units_left_estimate: Optional[float]
    usage_rate: Optional[float]
    usage_rate_mode: str  # "auto" or "manual"
    days_left: Optional[float]
    pay_before: Optional[datetime]
    last_token: Optional[TokenOut]
    total_tokens_count: int
    telegram_linked: bool
    last_scrape_at: Optional[datetime]


class UsageSnapshotOut(BaseModel):
    computed_at: datetime
    units_left_estimate: Optional[float]
    usage_rate: Optional[float]
    days_left: Optional[float]
    pay_before: Optional[datetime]

    model_config = {"from_attributes": True}


# ---- Settings ----

class SettingsUpdate(BaseModel):
    manual_usage_rate: Optional[float] = Field(default=None, ge=0)
    notification_threshold_days: Optional[float] = Field(default=None, ge=0)


class TelegramLinkResponse(BaseModel):
    link_token: str
    bot_username: Optional[str]
    expires_in_seconds: int


# ---- Scraper (internal) ----

class ScrapedToken(BaseModel):
    """Raw record from the KPLC portal before DB insertion."""
    token_number: str
    units: Optional[float]
    amount: Optional[float]
    payment_mode: Optional[str]
    purchased_at: Optional[datetime]
    tariff: Optional[str] = None
