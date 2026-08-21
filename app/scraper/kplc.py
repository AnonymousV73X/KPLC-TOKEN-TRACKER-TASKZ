"""
KPLC Self-Service Portal Scraper

Isolated module: input is a meter number, output is a list of ScrapedToken records.
All portal-specific logic lives here — if KPLC changes their page, only this file needs updating.

The KPLC self-service portal typically shows the last 6-8 token purchases
for a given meter number via a search form. This module replicates that
search and parses the result table.

NOTE: The exact portal URL, form fields, and HTML structure may change.
This implementation is based on the common KPLC self-service portal pattern
and includes defensive parsing to handle structural changes gracefully.
"""

import asyncio
import logging
from datetime import datetime
from typing import Optional
from dataclasses import dataclass

import aiohttp
from bs4 import BeautifulSoup

from app.config import get_settings
from app.schemas import ScrapedToken

logger = logging.getLogger(__name__)
settings = get_settings()


@dataclass
class ScrapResult:
    """Result of a scrape attempt."""
    tokens: list[ScrapedToken]
    tariff: Optional[str]
    success: bool
    error: Optional[str] = None


async def scrape_meter_tokens(
    meter_number: str,
    account_number: Optional[str] = None,
    session: Optional[aiohttp.ClientSession] = None,
) -> ScrapResult:
    """
    Fetch and parse KPLC self-service portal for a given meter number.

    Returns a ScrapResult with parsed token records and tariff info.
    Fails gracefully — returns empty list and error message on failure.
    """
    close_session = False
    if session is None:
        session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=settings.KPLC_TIMEOUT),
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                              "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.5",
            },
        )
        close_session = True

    try:
        tokens, tariff = await _fetch_and_parse(session, meter_number, account_number)
        return ScrapResult(
            tokens=tokens,
            tariff=tariff or (tokens[0].tariff if tokens else None),
            success=True,
        )
    except Exception as exc:
        logger.warning("KPLC sync: meter %s returned error (%s)", meter_number, exc)
        return ScrapResult(tokens=[], tariff=None, success=False, error=str(exc))
    finally:
        if close_session:
            await session.close()


QA_BASIC_AUTH = "Basic cTJ3RU10Z0VENmNqWlJOdmJsSU9vUEtueENrYTpOWTQxNzRFYVZGZnJySmRkV3A1NUtKQUx2dzhh"
PUBLIC_SCOPE = (
    "geotools_public token_public accounts_public attributes_public customers_public "
    "documents_public listData_public rccs_public sectorSupplies_public selfReads_public "
    "serviceRequests_public services_public streets_public supplies_public users_public "
    "workRequests_public publicData_public juaforsure_public"
)


async def _get_kplc_bearer_token(session: aiohttp.ClientSession) -> Optional[str]:
    """Request OAuth bearer token from KPLC selfservice APIM."""
    token_urls = [
        "https://selfservice.kplc.co.ke/apidev/token",
        "https://selfservice.kplc.co.ke/api/token",
        "https://selfservice.kplc.co.ke/token",
    ]
    headers = {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Authorization": QA_BASIC_AUTH,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    }
    data = f"grant_type=client_credentials&scope={PUBLIC_SCOPE}"

    for url in token_urls:
        try:
            async with session.post(url, data=data, headers=headers, ssl=False) as resp:
                if resp.status == 200:
                    res_json = await resp.json()
                    token = res_json.get("access_token")
                    if token:
                        return token
        except Exception as e:
            logger.debug("Token request failed for %s: %s", url, e)
    return None


async def _fetch_and_parse(
    session: aiohttp.ClientSession,
    meter_number: str,
    account_number: Optional[str],
) -> tuple[list[ScrapedToken], Optional[str]]:
    """
    Attempt to scrape KPLC portal or query the APIM endpoint for token purchase history and contract info.
    Returns (tokens, tariff).
    """
    tariff: Optional[str] = None

    # Strategy 1: Try KPLC REST APIM API
    try:
        bearer = await _get_kplc_bearer_token(session)
        if bearer:
            tokens, tariff = await _query_kplc_api(session, bearer, meter_number, account_number)
            if tokens or tariff:
                return tokens, tariff
    except Exception as e:
        logger.warning("APIM query failed for meter %s: %s", meter_number, e)

    # Strategy 2: Try HTML search form scraping
    html = await _try_search(session, meter_number, account_number)
    if html:
        parsed = _parse_html(html)
        if parsed:
            return parsed, (parsed[0].tariff if parsed else None)

    return [], tariff


async def _query_kplc_api(
    session: aiohttp.ClientSession,
    bearer_token: str,
    meter_number: str,
    account_number: Optional[str],
) -> list[ScrapedToken]:
    """Query KPLC APIM endpoints for token and contract history."""
    headers = {
        "Authorization": f"Bearer {bearer_token}",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json, text/plain, */*",
    }
    base = "https://selfservice.kplc.co.ke/apidev"
    tokens: list[ScrapedToken] = []
    tariff: Optional[str] = None

    # Step 1: Query live sector supplies for this meter
    supply_url = f"{base}/sectorSupplies/4/?serialNumberMeter={meter_number}"
    try:
        async with session.get(supply_url, headers=headers, ssl=False) as resp:
            if resp.status == 200:
                data = await resp.json()
                items = data.get("data") if isinstance(data, dict) else data
                if items and isinstance(items, list) and len(items) > 0:
                    supply_info = items[0]
                    tariff = supply_info.get("descServiceRateType") or supply_info.get("descOfferedService")
                    logger.info("Found live KPLC contract for meter %s: tariff=%s, address=%s",
                                meter_number, tariff, supply_info.get("address"))
                    # If prepayment tokens are embedded in sectorSupplies
                    extracted = _parse_kplc_api_json(supply_info)
                    if extracted:
                        tokens.extend(extracted)
    except Exception as e:
        logger.debug("Sector supply lookup error: %s", e)

    # Step 2: Query other contract and bill endpoints
    endpoints = [
        f"{base}/publicData/4/newContractList?serialNumberMeter={meter_number}",
        f"{base}/services/4/{meter_number}/bills?lastPeriod=true",
        f"{base}/accounts/4/{meter_number}/bills",
    ]
    if account_number:
        endpoints.insert(0, f"{base}/publicData/4/newContractList?accountReference={account_number}")

    for url in endpoints:
        try:
            async with session.get(url, headers=headers, ssl=False) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    extracted = _parse_kplc_api_json(data)
                    if extracted:
                        tokens.extend(extracted)
                        break
        except Exception as e:
            logger.debug("API query error on %s: %s", url, e)

    return tokens, tariff


def _parse_kplc_api_json(data: dict | list) -> list[ScrapedToken]:
    """Parse JSON responses from KPLC APIM."""
    tokens: list[ScrapedToken] = []
    if isinstance(data, dict):
        items = data.get("data") or data.get("colPrepayment") or data.get("tokens") or []
        if isinstance(items, dict):
            items = [items]
    elif isinstance(data, list):
        items = data
    else:
        return []

    for item in items:
        if not isinstance(item, dict):
            continue
        # Extract token number
        tok_num = (
            item.get("token")
            or item.get("tokenNumber")
            or item.get("token_number")
            or item.get("colPrepayment")
        )
        if not tok_num and "serialNumberMeter" in item:
            for sub in item.get("colPrepayment") or []:
                if isinstance(sub, dict):
                    t = _dict_to_scraped_token(sub)
                    if t:
                        tokens.append(t)
            continue

        token_obj = _dict_to_scraped_token(item)
        if token_obj:
            tokens.append(token_obj)

    return tokens


def _dict_to_scraped_token(item: dict) -> Optional[ScrapedToken]:
    """Convert a dictionary to ScrapedToken."""
    tok_num = str(
        item.get("token")
        or item.get("tokenNumber")
        or item.get("token_number")
        or item.get("idToken")
        or ""
    ).strip().replace(" ", "").replace("-", "")

    if not tok_num or len(tok_num) < 10:
        return None

    units = None
    for k in ["units", "unit", "kwh", "unitsKwh", "totalUnits"]:
        if k in item and item[k] is not None:
            try:
                units = float(item[k])
                break
            except (ValueError, TypeError):
                pass

    amount = None
    for k in ["amount", "cost", "totalAmount", "amountPaid", "ksh"]:
        if k in item and item[k] is not None:
            try:
                amount = float(item[k])
                break
            except (ValueError, TypeError):
                pass

    purchased_at = None
    date_val = item.get("date") or item.get("purchaseDate") or item.get("created_at") or item.get("emissionDate")
    if date_val:
        if isinstance(date_val, (int, float)):
            try:
                purchased_at = datetime.fromtimestamp(date_val / 1000 if date_val > 1e11 else date_val)
            except Exception:
                pass
        elif isinstance(date_val, str):
            purchased_at = _parse_date(date_val)

    return ScrapedToken(
        token_number=tok_num,
        units=units,
        amount=amount,
        payment_mode=item.get("paymentMode") or item.get("payment_mode") or "M-PESA",
        purchased_at=purchased_at,
        tariff=item.get("tariff"),
    )


async def _try_search(
    session: aiohttp.ClientSession,
    meter_number: str,
    account_number: Optional[str],
) -> Optional[str]:
    """
    Try multiple known KPLC self-service URL/form patterns.
    Returns the response HTML on success, None on all failures.
    """
    base_url = settings.KPLC_SEARCH_URL.rstrip("/")

    # Pattern 1: Direct search GET with query param
    search_urls = [
        f"{base_url}/?meter={meter_number}",
        f"{base_url}/search?meterNumber={meter_number}",
        f"{base_url}/paybill/token-history?meter={meter_number}",
    ]

    for url in search_urls:
        try:
            async with session.get(url, ssl=False) as resp:
                if resp.status == 200:
                    text = await resp.text()
                    if _looks_like_results(text):
                        return text
                    # Might need to submit a form on this page
                    form_action = _extract_form_action(text, meter_number, account_number)
                    if form_action:
                        post_html = await _submit_form(session, base_url, form_action,
                                                       meter_number, account_number, text)
                        if post_html and _looks_like_results(post_html):
                            return post_html
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            logger.debug("Search pattern failed for %s: %s", url, e)
            continue

    # Pattern 2: POST to likely search endpoints
    post_endpoints = [
        f"{base_url}/search",
        f"{base_url}/api/tokens",
        f"{base_url}/Token/GetTokenHistory",
    ]

    for endpoint in post_endpoints:
        try:
            payload = {"meterNumber": meter_number}
            if account_number:
                payload["accountNumber"] = account_number

            async with session.post(endpoint, data=payload, ssl=False) as resp:
                if resp.status == 200:
                    text = await resp.text()
                    if _looks_like_results(text):
                        return text
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            logger.debug("POST pattern failed for %s: %s", endpoint, e)
            continue

    return None


async def _submit_form(
    session: aiohttp.ClientSession,
    base_url: str,
    action: str,
    meter_number: str,
    account_number: Optional[str],
    page_html: str,
) -> Optional[str]:
    """Submit a form found on the page."""
    try:
        url = action if action.startswith("http") else f"{base_url}/{action.lstrip('/')}"
        payload = {"meterNumber": meter_number}
        if account_number:
            payload["accountNumber"] = account_number

        # Extract any hidden fields from the form
        soup = BeautifulSoup(page_html, "lxml")
        for inp in soup.select("form input[type='hidden']"):
            name = inp.get("name")
            if name:
                payload[name] = inp.get("value", "")

        async with session.post(url, data=payload, ssl=False) as resp:
            if resp.status == 200:
                return await resp.text()
    except Exception as e:
        logger.debug("Form submission failed: %s", e)
    return None


def _extract_form_action(
    html: str, meter_number: str, account_number: Optional[str]
) -> Optional[str]:
    """Look for a search form in the page and return its action URL."""
    soup = BeautifulSoup(html, "lxml")
    form = soup.find("form")
    if form and form.get("action"):
        return form["action"]
    return None


def _looks_like_results(html: str) -> bool:
    """Heuristic: does this HTML look like it contains token purchase results?"""
    indicators = [
        "token", "units", "kwh", "meter", "purchase", "amount",
        "<table", "tokenNumber", "token_number", "Token No",
    ]
    lower = html.lower()
    matches = sum(1 for ind in indicators if ind.lower() in lower)
    return matches >= 2


def _parse_html(html: str) -> list[ScrapedToken]:
    """
    Parse token purchase records from KPLC portal HTML.

    Looks for tabular data containing token purchase information.
    Tries multiple table structures and column name patterns.
    """
    soup = BeautifulSoup(html, "lxml")
    tokens: list[ScrapedToken] = []

    # Strategy 1: Look for a data table with token info
    tokens = _parse_table(soup)
    if tokens:
        return tokens

    # Strategy 2: Look for structured list/card items
    tokens = _parse_cards(soup)
    if tokens:
        return tokens

    # Strategy 3: Regex-based extraction from any text content
    tokens = _parse_text_fallback(html)
    return tokens


def _parse_table(soup: BeautifulSoup) -> list[ScrapedToken]:
    """Parse token data from HTML tables."""
    tokens: list[ScrapedToken] = []

    for table in soup.find_all("table"):
        rows = table.find_all("tr")
        if len(rows) < 2:
            continue

        # Detect header row and map column indices
        header_cells = [cell.get_text(strip=True).lower() for cell in rows[0].find_all(["th", "td"])]
        col_map = _map_columns(header_cells)
        if not col_map:
            # Try second row as header
            if len(rows) > 2:
                header_cells = [cell.get_text(strip=True).lower() for cell in rows[1].find_all(["th", "td"])]
                col_map = _map_columns(header_cells)
                data_start = 2
            else:
                continue
        else:
            data_start = 1

        for row in rows[data_start:]:
            cells = row.find_all("td")
            if len(cells) < 2:
                continue

            cell_texts = [cell.get_text(strip=True) for cell in cells]

            token = _row_to_token(cell_texts, col_map)
            if token and token.token_number:
                tokens.append(token)

        if tokens:
            break  # Found data in this table

    return tokens


def _map_columns(headers: list[str]) -> dict[str, int]:
    """Map standard column names to their indices."""
    col_map = {}
    patterns = {
        "token": ["token", "token no", "token number", "token_number", "tokenno"],
        "units": ["units", "kwh", "unit", "kwh purchased", "units(kwh)"],
        "amount": ["amount", "ksh", "kshs", "price", "cost", "value", "total"],
        "date": ["date", "purchase date", "transaction date", "date/time", "time",
                    "purchased at", "transaction date/time", "date & time"],
        "payment_mode": ["payment", "mode", "payment mode", "pay mode", "method",
                           "payment method", "source", "channel"],
        "tariff": ["tariff", "tariff name", "rate"],
    }

    for key, aliases in patterns.items():
        for i, header in enumerate(headers):
            if any(alias in header for alias in aliases):
                col_map[key] = i
                break

    # Require at least a token column to consider this a valid table
    return col_map if "token" in col_map else {}


def _row_to_token(cell_texts: list[str], col_map: dict[str, int]) -> Optional[ScrapedToken]:
    """Convert a table row's cell texts to a ScrapedToken."""
    def get(key: str) -> str:
        idx = col_map.get(key)
        return cell_texts[idx] if idx is not None and idx < len(cell_texts) else ""

    token_number = get("token").strip()
    if not token_number:
        return None

    # Clean token number: remove spaces, dashes
    token_number = token_number.replace(" ", "").replace("-", "")
    if not token_number.isdigit() and len(token_number) < 10:
        return None

    units = _parse_float(get("units"))
    amount = _parse_float(get("amount"))
    purchased_at = _parse_date(get("date"))
    payment_mode = get("payment_mode") or None
    tariff = get("tariff") or None

    return ScrapedToken(
        token_number=token_number,
        units=units,
        amount=amount,
        payment_mode=payment_mode,
        purchased_at=purchased_at,
        tariff=tariff,
    )


def _parse_cards(soup: BeautifulSoup) -> list[ScrapedToken]:
    """Parse token data from card/list structures (non-table layouts)."""
    tokens: list[ScrapedToken] = []

    # Look for common card/container patterns
    cards = soup.select(".token-card, .transaction, .purchase-record, .history-item")
    if not cards:
        # Try generic repeating containers
        cards = soup.find_all("div", class_=lambda c: c and any(
            word in (c or "").lower() for word in ["token", "transaction", "purchase", "history"]
        ))

    for card in cards:
        text = card.get_text(separator=" | ", strip=True)
        token_number = _extract_token_from_text(text)
        if not token_number:
            continue

        tokens.append(ScrapedToken(
            token_number=token_number,
            units=_parse_float(text),
            amount=None,
            payment_mode=None,
            purchased_at=None,
            tariff=None,
        ))

    return tokens


def _parse_text_fallback(html: str) -> list[ScrapedToken]:
    """Last-resort: try to extract token numbers from raw text using regex."""
    import re

    tokens: list[ScrapedToken] = []
    # KPLC tokens are typically 20-digit numbers
    pattern = r'\b(\d{20})\b'
    seen = set()

    for match in re.finditer(pattern, html):
        num = match.group(1)
        if num not in seen:
            seen.add(num)
            tokens.append(ScrapedToken(
                token_number=num,
                units=None,
                amount=None,
                payment_mode=None,
                purchased_at=None,
                tariff=None,
            ))

    return tokens


def _extract_token_from_text(text: str) -> Optional[str]:
    """Try to find a 20-digit token number in free text."""
    import re
    match = re.search(r'\b(\d{20})\b', text)
    return match.group(1) if match else None


def _parse_float(text: str) -> Optional[float]:
    """Extract a float from text, ignoring currency symbols and commas."""
    import re
    cleaned = re.sub(r'[^\d.]', '', text.replace(',', ''))
    try:
        val = float(cleaned)
        return val if val > 0 else None
    except (ValueError, IndexError):
        return None


def _parse_date(text: str) -> Optional[datetime]:
    """
    Parse a date from text. Tries common date formats.
    KPLC typically uses DD/MM/YYYY or DD-MM-YYYY formats.
    """
    if not text or not text.strip():
        return None

    text = text.strip()
    formats = [
        "%d/%m/%Y %H:%M:%S",
        "%d/%m/%Y %H:%M",
        "%d/%m/%Y",
        "%d-%m-%Y %H:%M:%S",
        "%d-%m-%Y %H:%M",
        "%d-%m-%Y",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d",
        "%d/%m/%y %H:%M",
        "%d/%m/%y",
    ]

    for fmt in formats:
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue

    return None
