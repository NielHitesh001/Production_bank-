#!/usr/bin/env python3
"""
================================================================================
 WORLD MONEY FINANCIAL DATA REFRESH DAEMON
--------------------------------------------------------------------------------
 A 24/7 background service that builds and continuously maintains a structured
 financial data workspace mapping sovereign states, central banks,
 currencies, and interbank payment rails (SWIFT, Fedwire, CHIPS, TARGET2,
 SEPA, UPI, CIPS, PIX, FedNow, CHAPS...).

 DESIGN CONTRACT
 ----------------
 1. Structural markdown (headings, tables, wikilinks) is 100% deterministic —
    derived purely from source data — so it is safe to fully regenerate on
    every cycle. This is what lets one template function scale to 200+
    countries without anyone hand-authoring 200 files.
 2. Fast-changing facts (FX rate, rail operating status, policy rate) live
    inside named markers:  <!-- LIVE:NAME:START --> ... <!-- LIVE:NAME:END -->
    Only the text between a marker pair is replaced on each tick.
 3. Everything below the sentinel heading "## \U0001F4DD Notes" is the user's.
    It is read from the existing file (if any) and re-appended verbatim,
    untouched, forever. The daemon never edits below that line.
 4. Country coverage is NOT hardcoded. At startup the vault builder pulls the
     live list of 195 sovereign states from the maintained mledoze/countries
     dataset. If the network is unavailable it falls back to a small embedded
     seed so the script still runs (degraded, offline mode) rather than dying.
 5. Central banks and payment rails ARE curated by hand (there is no clean
    free API for policy mandates / clearing-system operating hours), but the
    curated set is small and auto-stubs are generated for anything missing,
    so the graph never has a dangling wikilink.

 USAGE
 -----
   pip install requests
   python3 obsidian_finance_daemon.py --vault-path ./FinanceVault --once   # single build
   python3 obsidian_finance_daemon.py --vault-path ./FinanceVault         # run forever
================================================================================
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import logging
import os
import re
import signal
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Callable, Optional

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None  # type: ignore

try:
    import requests
except ImportError:
    requests = None  # network features degrade gracefully; cache/curated data still works


# ==============================================================================
# 1. CONFIGURATION
# ==============================================================================

@dataclass
class Config:
    vault_path: Path = Path("./FinanceVault")
    log_level: str = "INFO"
    workers: int = 8
    dashboard_port: int = 0

    # per-job refresh intervals, seconds
    interval_country_metadata: int = 24 * 3600      # daily — capitals, regions rarely change
    interval_fx_rates: int = 15 * 60                 # every 15 min
    interval_rail_status: int = 60                   # every 60s — it's a clock computation, cheap
    interval_policy_rates: int = 6 * 3600             # every 6h — curated data, rarely updates

    http_timeout: int = 10
    http_retries: int = 3
    http_backoff_base: float = 1.5

    @property
    def system_dir(self) -> Path:
        return self.vault_path / "_system"

    @property
    def cache_dir(self) -> Path:
        return self.system_dir / "cache"

    @property
    def log_dir(self) -> Path:
        return self.system_dir / "logs"

    @property
    def state_file(self) -> Path:
        return self.system_dir / "state.json"

    @property
    def graph_export_file(self) -> Path:
        return self.system_dir / "exports" / "world-money-graph.v1.json"


# ==============================================================================
# 2. LOGGING
# ==============================================================================

def setup_logging(cfg: Config) -> logging.Logger:
    cfg.log_dir.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("finance_daemon")
    logger.setLevel(getattr(logging, cfg.log_level.upper(), logging.INFO))
    logger.handlers.clear()

    fmt = logging.Formatter("%(asctime)s | %(levelname)-7s | %(name)s | %(message)s")

    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(fmt)
    logger.addHandler(console)

    file_handler = RotatingFileHandler(
        cfg.log_dir / "daemon.log", maxBytes=5_000_000, backupCount=5
    )
    file_handler.setFormatter(fmt)
    logger.addHandler(file_handler)
    return logger


log = logging.getLogger("finance_daemon")


# ==============================================================================
# 3. HTTP WITH RETRY/BACKOFF  (thin wrapper, no extra dependency)
# ==============================================================================

# Some public APIs (FRED among them) reject requests carrying the default
# bare "python-requests/x.y" User-Agent. A descriptive UA avoids that class
# of spurious 403s and is generally good API citizenship.
USER_AGENT = "WorldMoneyFinanceDaemon/1.0 (+https://github.com/NielHitesh001/World_money)"


def http_get_json(url: str, cfg: Config, params: Optional[dict] = None) -> Optional[dict]:
    if requests is None:
        log.warning("`requests` not installed — skipping live fetch for %s", url)
        return None
    last_exc = None
    for attempt in range(1, cfg.http_retries + 1):
        try:
            resp = requests.get(url, params=params, timeout=cfg.http_timeout,
                                 headers={"User-Agent": USER_AGENT})
            resp.raise_for_status()
            return resp.json()
        except Exception as exc:  # noqa: BLE001 — daemon must never crash on a bad fetch
            last_exc = exc
            wait = cfg.http_backoff_base ** attempt
            log.warning("fetch failed (%s/%s) %s: %s — retrying in %.1fs",
                        attempt, cfg.http_retries, url, exc, wait)
            time.sleep(wait)
    log.error("giving up on %s after %s attempts: %s", url, cfg.http_retries, last_exc)
    return None


# ==============================================================================
# 4. CURATED DATASETS
#    Small, hand-verified sets for entities where no reliable free API exists.
#    Everything not listed here gets a clean auto-generated stub instead of
#    a dangling link — the graph is always internally consistent.
# ==============================================================================

CURATED_CENTRAL_BANKS: dict[str, dict] = {
    "USA": {"name": "Federal Reserve System", "code": "FED", "est": 1913,
            "policy_rate": 5.33, "mandate": "Dual mandate: price stability & max employment",
            "digital_currency": "Exploring (no launch)"},
    "GBR": {"name": "Bank of England", "code": "BOE", "est": 1694,
            "policy_rate": 5.00, "mandate": "Price stability (2% CPI) + financial stability",
            "digital_currency": "Digital Pound — design phase"},
    "DEU": {"name": "Deutsche Bundesbank", "code": "BBK", "est": 1957,
            "policy_rate": 3.65, "mandate": "Price stability within Eurosystem (ECB-aligned)",
            "digital_currency": "Digital Euro — Eurosystem project"},
    "FRA": {"name": "Banque de France", "code": "BDF", "est": 1800,
            "policy_rate": 3.65, "mandate": "Price stability within Eurosystem (ECB-aligned)",
            "digital_currency": "Digital Euro — Eurosystem project"},
    "JPN": {"name": "Bank of Japan", "code": "BOJ", "est": 1882,
            "policy_rate": 0.25, "mandate": "Price stability (2% target)",
            "digital_currency": "Pilot programme completed"},
    "CHN": {"name": "People's Bank of China", "code": "PBOC", "est": 1948,
            "policy_rate": 3.10, "mandate": "Currency stability, growth, employment",
            "digital_currency": "e-CNY — live nationwide rollout"},
    "IND": {"name": "Reserve Bank of India", "code": "RBI", "est": 1935,
            "policy_rate": 6.50, "mandate": "Inflation targeting (4% +/-2%)",
            "digital_currency": "e₹ (Digital Rupee) — pilot live"},
    "BRA": {"name": "Banco Central do Brasil", "code": "BCB", "est": 1964,
            "policy_rate": 10.50, "mandate": "Inflation targeting",
            "digital_currency": "DREX — pilot phase"},
    "CAN": {"name": "Bank of Canada", "code": "BOC", "est": 1935,
            "policy_rate": 4.25, "mandate": "Inflation targeting (2%)",
            "digital_currency": "Research paused"},
    "AUS": {"name": "Reserve Bank of Australia", "code": "RBA", "est": 1960,
            "policy_rate": 4.35, "mandate": "Inflation targeting (2-3%) + full employment",
            "digital_currency": "eAUD — pilot completed"},
    "CHE": {"name": "Swiss National Bank", "code": "SNB", "est": 1907,
            "policy_rate": 1.25, "mandate": "Price stability, exchange-rate consideration",
            "digital_currency": "Wholesale CBDC pilot"},
    "RUS": {"name": "Central Bank of Russia", "code": "CBR", "est": 1990,
            "policy_rate": 18.00, "mandate": "Inflation targeting",
            "digital_currency": "Digital Ruble — live rollout"},
    "ZAF": {"name": "South African Reserve Bank", "code": "SARB", "est": 1921,
            "policy_rate": 8.00, "mandate": "Price stability (3-6% CPI)",
            "digital_currency": "Project Khokha — wholesale trial"},
    "KOR": {"name": "Bank of Korea", "code": "BOK", "est": 1950,
            "policy_rate": 3.25, "mandate": "Price stability (2%)",
            "digital_currency": "Pilot with commercial banks"},
    "MEX": {"name": "Banco de México", "code": "BANXICO", "est": 1925,
            "policy_rate": 10.75, "mandate": "Price stability",
            "digital_currency": "DCEP — planning stage"},
    "SGP": {"name": "Monetary Authority of Singapore", "code": "MAS", "est": 1971,
            "policy_rate": 3.50, "mandate": "Exchange-rate centred monetary policy",
            "digital_currency": "Project Orchid — wholesale live"},
    "ARE": {"name": "Central Bank of the UAE", "code": "CBUAE", "est": 1980,
            "policy_rate": 5.40, "mandate": "Currency peg (USD) stability",
            "digital_currency": "Digital Dirham — issuance underway"},
    "SAU": {"name": "Saudi Central Bank", "code": "SAMA", "est": 1952,
            "policy_rate": 5.50, "mandate": "Currency peg (USD) stability",
            "digital_currency": "Project Aber (cross-border, joint w/ UAE)"},
    "TUR": {"name": "Central Bank of the Republic of Türkiye", "code": "CBRT", "est": 1930,
            "policy_rate": 46.00, "mandate": "Price stability",
            "digital_currency": "Digital Lira — pilot"},
    "IDN": {"name": "Bank Indonesia", "code": "BI", "est": 1953,
            "policy_rate": 6.00, "mandate": "Rupiah stability",
            "digital_currency": "Digital Rupiah — research"},
    "NGA": {"name": "Central Bank of Nigeria", "code": "CBN", "est": 1958,
            "policy_rate": 27.25, "mandate": "Price & monetary stability",
            "digital_currency": "eNaira — live"},
    "EGY": {"name": "Central Bank of Egypt", "code": "CBE", "est": 1961,
            "policy_rate": 27.25, "mandate": "Price stability",
            "digital_currency": "Under study"},
    "ITA": {"name": "Banca d'Italia", "code": "BDI", "est": 1893,
            "policy_rate": 3.65, "mandate": "Price stability within Eurosystem (ECB-aligned)",
            "digital_currency": "Digital Euro — Eurosystem project"},
    "ESP": {"name": "Banco de España", "code": "BDE", "est": 1782,
            "policy_rate": 3.65, "mandate": "Price stability within Eurosystem (ECB-aligned)",
            "digital_currency": "Digital Euro — Eurosystem project"},
    "NLD": {"name": "De Nederlandsche Bank", "code": "DNB", "est": 1814,
            "policy_rate": 3.65, "mandate": "Price stability within Eurosystem (ECB-aligned)",
            "digital_currency": "Digital Euro — Eurosystem project"},
    "NZL": {"name": "Reserve Bank of New Zealand", "code": "RBNZ", "est": 1934,
            "policy_rate": 5.25, "mandate": "Price stability (1-3% target) & maximum sustainable employment",
            "digital_currency": "Digital Cash — consultation stage"},
    "NOR": {"name": "Norges Bank", "code": "NB", "est": 1816,
            "policy_rate": 4.50, "mandate": "Price stability (2% target) & financial stability",
            "digital_currency": "Experimental testing phase"},
    "SWE": {"name": "Sveriges Riksbank", "code": "RB", "est": 1668,
            "policy_rate": 3.50, "mandate": "Price stability (2% CPIF target)",
            "digital_currency": "e-krona — technical pilot completed"},
    "THA": {"name": "Bank of Thailand", "code": "BOT", "est": 1942,
            "policy_rate": 2.50, "mandate": "Price stability (1-3% target) & economic growth",
            "digital_currency": "Retail CBDC pilot completed"},
    "MYS": {"name": "Bank Negara Malaysia", "code": "BNM", "est": 1959,
            "policy_rate": 3.00, "mandate": "Monetary & financial stability conducive to sustainable growth",
            "digital_currency": "Project Dunbar — wholesale exploration"},
    "PHL": {"name": "Bangko Sentral ng Pilipinas", "code": "BSP", "est": 1993,
            "policy_rate": 6.25, "mandate": "Price stability (2-4% target) & financial system health",
            "digital_currency": "Project Agila — wholesale pilot"},
    "VNM": {"name": "State Bank of Vietnam", "code": "SBV", "est": 1951,
            "policy_rate": 4.50, "mandate": "Currency value stability & economic development",
            "digital_currency": "Research & legal framework study"},
    "CHL": {"name": "Banco Central de Chile", "code": "BCCh", "est": 1925,
            "policy_rate": 5.50, "mandate": "Currency stability (3% inflation target) & payment safety",
            "digital_currency": "Exploration & technical assessment"},
}

# NOTE on the "policy_rate" figures above: they are illustrative seed values,
# clearly marked as curated/manual in the rendered tear sheet (see
# render_central_bank_md). Wire a real feed (e.g. a national statistics API,
# or a licensed data vendor) into PolicyRateSource.fetch_override() to make
# these authoritative — the template and daemon plumbing already support it.

CURATED_PAYMENT_RAILS: dict[str, dict] = {
    "SWIFT": {
        "full_name": "Society for Worldwide Interbank Financial Telecommunication",
        "type": "Messaging network (not settlement)", "scope": "Global (200+ countries)",
        "operator": "SWIFT SC (Belgium, cooperative)",
        "hours": {"tz": "UTC", "open": 0, "close": 24, "days": "7"},  # 24/7 messaging
        "settles_in": [],
        "notes": "Carries payment *instructions*; actual settlement happens on domestic RTGS systems.",
    },
    "FEDWIRE": {
        "full_name": "Fedwire Funds Service", "type": "RTGS",
        "scope": "United States", "operator": "Federal Reserve Banks",
        "hours": {"tz": "America/New_York", "open": 21, "close": 19, "days": "Mon-Fri", "wraps": True},
        "settles_in": ["USA"], "notes": "Near-22-hour daily window (9pm prior day–7pm ET), closed weekends.",
    },
    "CHIPS": {
        "full_name": "Clearing House Interbank Payments System", "type": "Net settlement",
        "scope": "United States (large-value)", "operator": "The Clearing House",
        "hours": {"tz": "America/New_York", "open": 0, "close": 17, "days": "Mon-Fri"},
        "settles_in": ["USA"], "notes": "Handles the bulk of USD cross-border interbank payment value.",
    },
    "FEDNOW": {
        "full_name": "FedNow Service", "type": "Instant payment (RTGS, retail)",
        "scope": "United States", "operator": "Federal Reserve Banks",
        "hours": {"tz": "UTC", "open": 0, "close": 24, "days": "7"},
        "settles_in": ["USA"], "notes": "24/7/365 instant settlement, launched 2023.",
    },
    "TARGET2": {
        "full_name": "Trans-European Automated Real-time Gross settlement Express Transfer",
        "type": "RTGS", "scope": "Eurozone", "operator": "Eurosystem (ECB)",
        "hours": {"tz": "Europe/Frankfurt", "open": 7, "close": 18, "days": "Mon-Fri"},
        "settles_in": ["DEU", "FRA", "ITA", "ESP", "NLD"], "notes": "Backbone RTGS for the euro.",
    },
    "SEPA_INSTANT": {
        "full_name": "SEPA Instant Credit Transfer", "type": "Instant payment (retail)",
        "scope": "EU/EEA", "operator": "EPC (European Payments Council)",
        "hours": {"tz": "UTC", "open": 0, "close": 24, "days": "7"},
        "settles_in": ["DEU", "FRA", "ITA", "ESP", "NLD"], "notes": "10-second max settlement, 24/7.",
    },
    "CHAPS": {
        "full_name": "Clearing House Automated Payment System", "type": "RTGS",
        "scope": "United Kingdom", "operator": "Bank of England",
        "hours": {"tz": "Europe/London", "open": 6, "close": 18, "days": "Mon-Fri"},
        "settles_in": ["GBR"], "notes": "UK high-value same-day settlement system.",
    },
    "UPI": {
        "full_name": "Unified Payments Interface", "type": "Instant payment (retail)",
        "scope": "India", "operator": "NPCI (National Payments Corporation of India)",
        "hours": {"tz": "UTC", "open": 0, "close": 24, "days": "7"},
        "settles_in": ["IND"], "notes": "World's highest-volume real-time retail payment rail.",
    },
    "CIPS": {
        "full_name": "Cross-Border Interbank Payment System", "type": "RTGS/hybrid",
        "scope": "China (RMB cross-border)", "operator": "PBOC",
        "hours": {"tz": "Asia/Shanghai", "open": 9, "close": 20, "days": "Mon-Fri"},
        "settles_in": ["CHN"], "notes": "China's SWIFT-alternative for RMB internationalisation.",
    },
    "PIX": {
        "full_name": "Pix", "type": "Instant payment (retail)",
        "scope": "Brazil", "operator": "Banco Central do Brasil",
        "hours": {"tz": "UTC", "open": 0, "close": 24, "days": "7"},
        "settles_in": ["BRA"], "notes": "Central-bank-operated instant rail; mass retail adoption.",
    },
    "SPEI": {
        "full_name": "Sistema de Pagos Electrónicos Interbancarios", "type": "Instant payment / RTGS hybrid",
        "scope": "Mexico", "operator": "Banco de México (Banxico)",
        "hours": {"tz": "UTC", "open": 0, "close": 24, "days": "7"},
        "settles_in": ["MEX"], "notes": "24/7 domestic real-time interbank electronic payment rail.",
    },
    "PROMPTPAY": {
        "full_name": "PromptPay Real-Time Payments", "type": "Instant payment (retail & merchant)",
        "scope": "Thailand", "operator": "National ITMX / Bank of Thailand",
        "hours": {"tz": "UTC", "open": 0, "close": 24, "days": "7"},
        "settles_in": ["THA"], "notes": "High-penetration national instant payment ecosystem in Southeast Asia.",
    },
    "FAST": {
        "full_name": "Fast And Secure Transfers (FAST)", "type": "Instant payment (retail & corporate)",
        "scope": "Singapore", "operator": "Banking Computer Services / MAS",
        "hours": {"tz": "UTC", "open": 0, "close": 24, "days": "7"},
        "settles_in": ["SGP"], "notes": "24/7 instant SGD funds transfer rail between participating financial institutions.",
    },
    "SARIE": {
        "full_name": "Saudi Arabian Interbank Express", "type": "RTGS & Instant IPS",
        "scope": "Saudi Arabia", "operator": "Saudi Central Bank (SAMA)",
        "hours": {"tz": "Asia/Riyadh", "open": 0, "close": 24, "days": "7"},
        "settles_in": ["SAU"], "notes": "Core interbank payments backbone for the Kingdom of Saudi Arabia.",
    },
    "NPP": {
        "full_name": "New Payments Platform (NPP / PayID)", "type": "Instant payment (retail & wholesale)",
        "scope": "Australia", "operator": "Australian Payments Plus / RBA",
        "hours": {"tz": "UTC", "open": 0, "close": 24, "days": "7"},
        "settles_in": ["AUS"], "notes": "Data-rich, ISO 20022 24/7 real-time gross settlement infrastructure.",
    },
    "T2S": {
        "full_name": "TARGET2-Securities", "type": "Securities Settlement / DvP",
        "scope": "Eurozone / Pan-European", "operator": "Eurosystem (ECB)",
        "hours": {"tz": "Europe/Frankfurt", "open": 0, "close": 24, "days": "Mon-Fri"},
        "settles_in": ["DEU", "FRA", "ITA", "ESP", "NLD"], "notes": "Centralised Delivery-versus-Payment (DvP) platform across 20+ European CSDs.",
    },
}

# Small offline fallback in case the country API is unreachable — enough to
# keep the daemon useful (and the demo runnable) with zero network access.
FALLBACK_COUNTRIES: list[dict] = [
    {"name": "United States", "cca2": "US", "cca3": "USA", "region": "Americas",
     "subregion": "North America", "capital": ["Washington, D.C."], "currency": "USD"},
    {"name": "United Kingdom", "cca2": "GB", "cca3": "GBR", "region": "Europe",
     "subregion": "Northern Europe", "capital": ["London"], "currency": "GBP"},
    {"name": "Germany", "cca2": "DE", "cca3": "DEU", "region": "Europe",
     "subregion": "Western Europe", "capital": ["Berlin"], "currency": "EUR"},
    {"name": "India", "cca2": "IN", "cca3": "IND", "region": "Asia",
     "subregion": "Southern Asia", "capital": ["New Delhi"], "currency": "INR"},
    {"name": "China", "cca2": "CN", "cca3": "CHN", "region": "Asia",
     "subregion": "Eastern Asia", "capital": ["Beijing"], "currency": "CNY"},
    {"name": "Japan", "cca2": "JP", "cca3": "JPN", "region": "Asia",
     "subregion": "Eastern Asia", "capital": ["Tokyo"], "currency": "JPY"},
    {"name": "Brazil", "cca2": "BR", "cca3": "BRA", "region": "Americas",
     "subregion": "South America", "capital": ["Brasília"], "currency": "BRL"},
]


# ==============================================================================
# 5. DATA SOURCES  (network-backed, each with graceful degradation + on-disk cache)
# ==============================================================================

class CachedSource:
    """Base class: read-through disk cache so a network blip never blanks data
    that was already fetched, and repeated runs don't hammer public APIs."""

    def __init__(self, cfg: Config, cache_name: str):
        self.cfg = cfg
        self.cache_file = cfg.cache_dir / cache_name
        self.cfg.cache_dir.mkdir(parents=True, exist_ok=True)

    def _load_cache(self) -> Optional[dict]:
        if self.cache_file.exists():
            try:
                return json.loads(self.cache_file.read_text())
            except json.JSONDecodeError:
                return None
        return None

    def _save_cache(self, data: dict) -> None:
        self.cache_file.write_text(json.dumps(data, indent=2, default=str))


class CountrySource(CachedSource):
    """Sovereign-state metadata sourced from a maintained public dataset."""

    API_URL = "https://raw.githubusercontent.com/mledoze/countries/master/countries.json"

    def __init__(self, cfg: Config):
        super().__init__(cfg, "countries.json")

    def fetch(self) -> list[dict]:
        raw = http_get_json(self.API_URL, self.cfg)
        if isinstance(raw, list):
            sovereigns = [c for c in raw if c.get("independent") or c.get("unMember") or c.get("cca3") == "PSE"]
            normalized = [self._normalize(c) for c in sovereigns]
            normalized = [c for c in normalized if c["cca3"]]
            self._save_cache({"countries": normalized, "fetched_at": _utcnow_iso()})
            log.info("CountrySource: fetched %s countries live", len(normalized))
            return normalized
        if raw:
            log.warning("CountrySource: unexpected API response shape — using cache or fallback")

        cached = self._load_cache()
        if cached:
            log.warning("CountrySource: live fetch failed, using cache (%s countries)",
                        len(cached["countries"]))
            return cached["countries"]

        log.warning("CountrySource: no network, no cache — using embedded fallback seed (%s countries)",
                    len(FALLBACK_COUNTRIES))
        return FALLBACK_COUNTRIES

    @staticmethod
    def _normalize(c: dict) -> dict:
        currencies = c.get("currencies") or {}
        currency_code = next(iter(currencies), "N/A")
        currency_data = currencies.get(currency_code) or {}
        return {
            "name": (c.get("name") or {}).get("common", "Unknown"),
            "cca2": c.get("cca2", ""),
            "cca3": c.get("cca3", ""),
            "region": c.get("region", "Unknown"),
            "subregion": c.get("subregion", "Unknown"),
            "capital": c.get("capital") or ["N/A"],
            "currency": currency_code,
            "currency_name": currency_data.get("name", "Unknown currency"),
            "currency_symbol": currency_data.get("symbol", ""),
            # NOTE: the upstream mledoze/countries.json feed dropped the
            # "population" field entirely (as of 2026 it's not present for
            # any country). Leave this unset here — defaulting to 0 would
            # silently render as a real (and wrong) population of zero for
            # every country. PopulationSource merges in real figures where
            # available; render_country_md shows "N/A" otherwise.
            "population": c.get("population"),
        }


class PopulationSource(CachedSource):
    """Population figures, keyed by cca3.

    mledoze/countries.json (our primary CountrySource feed) dropped the
    'population' field upstream, so it's backfilled separately here from
    restcountries.com — a free, no-key public API — with the same
    cache-then-fallback contract as every other live source in this file.
    A failed fetch simply means population stays unknown (rendered as
    "N/A"), never a fabricated 0.
    """

    API_URL = "https://restcountries.com/v3.1/all"

    def __init__(self, cfg: Config):
        super().__init__(cfg, "population.json")

    def fetch(self) -> dict[str, int]:
        raw = http_get_json(self.API_URL, self.cfg, params={"fields": "cca3,population"})
        if isinstance(raw, list):
            data = {
                entry["cca3"]: entry["population"]
                for entry in raw
                if entry.get("cca3") and isinstance(entry.get("population"), int)
            }
            if data:
                self._save_cache({"population": data, "fetched_at": _utcnow_iso()})
                log.info("PopulationSource: refreshed population for %s countries", len(data))
                return data
        cached = self._load_cache()
        if cached:
            log.warning("PopulationSource: live fetch failed, serving cached data from %s",
                        cached.get("fetched_at"))
            return cached.get("population", {})
        log.warning("PopulationSource: no live or cached population data available")
        return {}


class FXSource(CachedSource):
    """Live FX cross-rates, base USD. Uses frankfurter.app — free, no key,
    backed by ECB reference rates."""

    API_URL = "https://api.frankfurter.app/latest"

    def __init__(self, cfg: Config):
        super().__init__(cfg, "fx_rates.json")

    def fetch(self) -> dict:
        raw = http_get_json(self.API_URL, self.cfg, params={"from": "USD"})
        if raw and "rates" in raw:
            data = {"base": "USD", "rates": raw["rates"], "date": raw.get("date"),
                     "fetched_at": _utcnow_iso()}
            self._save_cache(data)
            log.info("FXSource: refreshed %s rates", len(raw["rates"]))
            return data
        cached = self._load_cache()
        if cached:
            log.warning("FXSource: live fetch failed, serving cached rates from %s",
                        cached.get("fetched_at"))
            return cached
        log.warning("FXSource: no rates available yet")
        return {"base": "USD", "rates": {}, "date": None, "fetched_at": None}


class PolicyRateSource(CachedSource):
    """Live policy-rate overrides with cached fallback.

    FRED provides public series for the US effective federal funds rate and
    the ECB deposit facility rate. Additional series can be added here.
    """

    API_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv"
    SERIES = {
        "DFF": ("USA", "FRED DFF"),
        "ECBDFR": ("DEU", "FRED ECBDFR"),
    }
    ECB_COUNTRIES = ("FRA", "ITA", "ESP", "NLD")

    def __init__(self, cfg: Config):
        super().__init__(cfg, "policy_rates.json")

    def fetch(self) -> dict[str, dict]:
        data = {}
        api_key = os.environ.get("FRED_API_KEY")
        if requests is not None:
            for series_id, (country, source_name) in self.SERIES.items():
                try:
                    params = {"id": series_id}
                    if api_key and api_key != "your_fred_api_key_here":
                        params["api_key"] = api_key
                    response = requests.get(
                        self.API_URL, params=params, timeout=self.cfg.http_timeout,
                        headers={"User-Agent": USER_AGENT},
                    )
                    response.raise_for_status()
                    rows = csv.DictReader(io.StringIO(response.text))
                    for row in reversed(list(rows)):
                        value = row.get(series_id, "")
                        if value and value != ".":
                            rate = {
                                "policy_rate": float(value),
                                "policy_rate_source": source_name,
                                "policy_rate_as_of": row.get("observation_date"),
                            }
                            data[country] = rate
                            if series_id == "ECBDFR":
                                data.update({member: dict(rate) for member in self.ECB_COUNTRIES})
                            break
                except Exception as exc:  # noqa: BLE001 — use cache on feed failure
                    log.warning("PolicyRateSource: %s fetch failed: %s", series_id, exc)

            if data:
                self._save_cache({"rates": data, "fetched_at": _utcnow_iso()})
                log.info("PolicyRateSource: refreshed %s policy rates", len(data))
                return data

        cached = self._load_cache()
        if cached:
            log.warning("PolicyRateSource: serving cached policy rates")
            return cached.get("rates", {})
        log.warning("PolicyRateSource: no live or cached rates available")
        return {}


class RailStatusCalculator:
    """No API needed — 'live' status is a pure function of current time vs.
    each rail's documented operating window. This is what drives the
    dynamic 🟢/🔴 indicators."""

    @staticmethod
    def is_open(rail: dict) -> tuple[bool, str]:
        hours = rail["hours"]
        if hours.get("days") == "7" and hours["open"] == 0 and hours["close"] == 24:
            return True, "24/7"

        if ZoneInfo is None:
            return True, "unknown (zoneinfo unavailable)"

        try:
            tz = ZoneInfo(hours["tz"])
        except Exception:
            return True, "unknown (bad timezone)"

        now = datetime.now(tz)
        if hours.get("days") == "Mon-Fri" and now.weekday() >= 5:
            return False, f"closed — weekend ({hours['tz']})"

        open_h, close_h = hours["open"], hours["close"]
        wraps = hours.get("wraps", False)
        hour = now.hour
        if wraps:
            is_open = hour >= open_h or hour < close_h
        else:
            is_open = open_h <= hour < close_h

        window = f"{open_h:02d}:00\u2013{close_h:02d}:00 {hours['tz']}"
        return is_open, window


# ==============================================================================
# 6. MANAGED FILE WRITER  — the "don't overwrite my notes" contract
# ==============================================================================

NOTES_SENTINEL = "## \U0001F4DD Notes"
LIVE_BLOCK_RE = re.compile(
    r"<!-- LIVE:(?P<name>[\w-]+):START -->.*?<!-- LIVE:(?P<end_name>[\w-]+):END -->",
    re.DOTALL,
)


def render_live_block(name: str, content: str) -> str:
    return f"<!-- LIVE:{name}:START -->\n{content.strip()}\n<!-- LIVE:{name}:END -->"


class ManagedFileWriter:
    """Splits any existing file at NOTES_SENTINEL. Regenerates everything
    above it from fresh template output; copies everything below it,
    unchanged, forever. Skips the disk write entirely if content is
                    byte-identical (keeps downstream file watchers quiet).

    IMPORTANT: multiple jobs (countries, fx, policy-rates...) can target the
    same file concurrently from different worker threads. Without a lock, a
    read can land mid-write, see a truncated file with no Notes sentinel,
    and silently drop the user's notes. Every read-modify-write on a given
    path is therefore serialized through a per-path lock."""

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self._locks: dict[Path, threading.Lock] = {}
        self._locks_guard = threading.Lock()

    def _lock_for(self, path: Path) -> threading.Lock:
        with self._locks_guard:
            if path not in self._locks:
                self._locks[path] = threading.Lock()
            return self._locks[path]

    def write(self, path: Path, generated_body: str) -> bool:
        """Returns True if the file was actually written (i.e. changed).
        Thread-safe per path: the read-notes / compare / write sequence is
        atomic with respect to any other job writing the same file."""
        path.parent.mkdir(parents=True, exist_ok=True)

        with self._lock_for(path):
            existing = None
            if path.exists():
                existing = path.read_text(encoding="utf-8")
                idx = existing.find(NOTES_SENTINEL)
                user_notes = existing[idx + len(NOTES_SENTINEL):].lstrip("\n") if idx != -1 else "\n> Add your own notes below this line — the daemon never touches this section.\n"
            else:
                user_notes = "\n> Add your own notes below this line — the daemon never touches this section.\n"

            full_content = generated_body.rstrip() + "\n\n" + NOTES_SENTINEL + "\n" + user_notes

            if existing is not None and existing == full_content:
                return False  # no change — don't touch mtime, don't trigger re-index

            tmp_path = path.with_suffix(path.suffix + ".tmp")
            tmp_path.write_text(full_content, encoding="utf-8")
            tmp_path.replace(path)  # atomic on POSIX — no reader ever sees a partial file
            return True

    @staticmethod
    def _extract_user_notes(path: Path) -> str:
        if not path.exists():
            return "\n> Add your own notes below this line — the daemon never touches this section.\n"
        text = path.read_text(encoding="utf-8")
        idx = text.find(NOTES_SENTINEL)
        if idx == -1:
            return "\n> Add your own notes below this line — the daemon never touches this section.\n"
        return text[idx + len(NOTES_SENTINEL):].lstrip("\n")


def _hash(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def write_json_atomic(path: Path, data: dict) -> None:
    """Write an export without exposing a partially written JSON document."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")
    tmp_path.replace(path)


def status_emoji(ok: bool) -> str:
    return "\U0001F7E2" if ok else "\U0001F534"


def slugify(name: str) -> str:
    return re.sub(r"[^\w\- ]", "", name).strip().replace(" ", "-")


# ==============================================================================
# 7. TEMPLATE RENDERERS  — "tear sheet" markdown, Dataview-ready frontmatter
# ==============================================================================

def render_country_md(country: dict, fx: dict, cb_entry: Optional[dict]) -> str:
    cca3, name, currency = country["cca3"], country["name"], country["currency"]
    rate = fx.get("rates", {}).get(currency)
    rate_str = f"{rate:.4f}" if isinstance(rate, (int, float)) else "N/A"
    cb_link = f"[[{cca3}-central-bank|Central Bank of {name}]]" if cb_entry else \
              f"[[{cca3}-central-bank|Central Bank of {name} (stub)]]"

    frontmatter = _frontmatter({
        "type": "country",
        "iso2": country["cca2"],
        "iso3": cca3,
        "region": country["region"],
        "subregion": country["subregion"],
        "currency": currency,
        "central_bank": f"{cca3}-central-bank",
        "population": country.get("population") if country.get("population") is not None else "N/A",
        "tags": ["finance/country", f"region/{slugify(country['region']).lower()}"],
        "last_updated": _utcnow_iso(),
    })

    live_fx = render_live_block("FXRATE", (
        f"| Metric | Value |\n|---|---|\n"
        f"| USD → {currency} | `{rate_str}` |\n"
        f"| Source | ECB reference rate (via frankfurter.app) |\n"
        f"| As of | {fx.get('date', 'N/A')} |"
    ))

    body = f"""{frontmatter}
# \U0001F3E6 {name} — Financial Tear Sheet

> [!info] Quick Facts
> **Region:** {country['region']} / {country['subregion']}
> **Capital:** {', '.join(country['capital'])}
> **Currency:** {currency}
> **Central Bank:** {cb_link}

## \U0001F4B1 FX Snapshot
{live_fx}

## \U0001F3DB\uFE0F Monetary Authority
- {cb_link}

## \U0001F517 Connected Payment Rails
{_rails_for_country(cca3)}

## \U0001F5FA\uFE0F Graph Context
- Region MOC: [[{slugify(country['region'])}-MOC]]
- All entities of this type: `dataview` query in [[Countries-MOC]]
"""
    return body


def render_currency_md(code: str, countries: list[dict], fx: dict) -> str:
    rate = fx.get("rates", {}).get(code)
    rate_str = f"{rate:.4f}" if isinstance(rate, (int, float)) else "N/A"
    currency_name = next(
        (country.get("currency_name") for country in countries if country.get("currency_name")),
        "Unknown currency",
    )
    currency_symbol = next(
        (country.get("currency_symbol") for country in countries if country.get("currency_symbol")),
        "",
    )
    country_links = "\n".join(
        f"- [[{country['cca3']}-country|{country['name']}]]"
        for country in sorted(countries, key=lambda item: item["name"])
    )
    frontmatter = _frontmatter({
        "type": "currency",
        "currency_code": code,
        "currency_name": currency_name,
        "currency_symbol": currency_symbol,
        "country_count": len(countries),
        "tags": ["finance/currency"],
        "last_updated": _utcnow_iso(),
    })
    live_fx = render_live_block("FXRATE", (
        f"| Metric | Value |\n|---|---|\n"
        f"| USD -> {code} | `{rate_str}` |\n"
        f"| Source | ECB reference rate (via frankfurter.app) |\n"
        f"| As of | {fx.get('date', 'N/A')} |"
    ))
    return f"""{frontmatter}
# {currency_name} ({code}) Currency Hub

## FX Snapshot
{live_fx}

## Countries Using {code}
{country_links}

## Graph Context
- All currencies: see [[Currencies-MOC]]
"""


def render_central_bank_md(cca3: str, country_name: str, cb: dict) -> str:
    is_curated = cb.get("_curated", False)
    frontmatter = _frontmatter({
        "type": "central-bank",
        "country": cca3,
        "code": cb.get("code", "N/A"),
        "established": cb.get("est", "unknown"),
        "policy_rate_source": cb.get("policy_rate_source", "curated/manual"),
        "policy_rate_as_of": cb.get("policy_rate_as_of", "N/A"),
        "tags": ["finance/central-bank"],
        "data_quality": "curated" if is_curated else "auto-stub",
        "last_updated": _utcnow_iso(),
    })

    live_rate = render_live_block("POLICY-RATE", (
        f"| Metric | Value |\n|---|---|\n"
        f"| Policy Rate | `{cb.get('policy_rate', 'N/A')}%` |\n"
        f"| Rate Source | {cb.get('policy_rate_source', 'curated/manual')} |\n"
        f"| Rate As Of | {cb.get('policy_rate_as_of', 'N/A')} |\n"
        f"| Mandate | {cb.get('mandate', 'Not yet catalogued')} |\n"
        f"| CBDC Status | {cb.get('digital_currency', 'Not yet catalogued')} |\n"
        f"| Data quality | {'\U0001F7E2 curated' if is_curated else '\U0001F7E1 auto-stub — needs enrichment'} |"
    ))

    warning = "" if is_curated else (
        "\n> [!warning] Auto-generated stub\n"
        "> This entity has not been manually curated yet. Policy rate and mandate "
        "are placeholders — extend `CURATED_CENTRAL_BANKS` in the daemon to enrich it.\n"
    )

    body = f"""{frontmatter}
# \U0001F3DB\uFE0F {cb.get('name', f'Central Bank of {country_name}')}
{warning}
## \U0001F4CA Policy Snapshot
{live_rate}

## \U0001F517 Graph Context
- Sovereign: [[{cca3}-country|{country_name}]]
- All central banks: see [[Central-Banks-MOC]]
"""
    return body


def render_payment_rail_md(key: str, rail: dict) -> str:
    is_open, window = RailStatusCalculator.is_open(rail)
    frontmatter = _frontmatter({
        "type": "payment-rail",
        "scope": rail["scope"],
        "rail_type": rail["type"],
        "operator": rail["operator"],
        "tags": ["finance/payment-rail"],
        "last_updated": _utcnow_iso(),
    })

    live_status = render_live_block("STATUS", (
        f"| Metric | Value |\n|---|---|\n"
        f"| Status | {status_emoji(is_open)} {'OPEN' if is_open else 'CLOSED'} |\n"
        f"| Operating window | {window} |\n"
        f"| Checked at | {_utcnow_iso()} |"
    ))

    linked_countries = "\n".join(
        f"- [[{iso3}-country|{iso3}]]" for iso3 in rail.get("settles_in", [])
    ) or "- (global / not country-scoped)"

    body = f"""{frontmatter}
# \U0001F50C {rail['full_name']} ({key})

## \u26A1 Live Status
{live_status}

## \u2139\uFE0F Overview
- **Type:** {rail['type']}
- **Scope:** {rail['scope']}
- **Operator:** {rail['operator']}
- **Notes:** {rail['notes']}

## \U0001F517 Settles Currency For
{linked_countries}
"""
    return body


def render_moc_md(title: str, dataview_query: str, description: str) -> str:
    frontmatter = _frontmatter({"type": "moc", "tags": ["finance/moc"], "last_updated": _utcnow_iso()})
    body = f"""{frontmatter}
# \U0001F5FA\uFE0F {title}

{description}

```dataview
{dataview_query}
```
"""
    return body


def _rails_for_country(cca3: str) -> str:
    matches = [k for k, r in CURATED_PAYMENT_RAILS.items() if cca3 in r.get("settles_in", [])]
    matches.append("SWIFT")  # every country rides SWIFT for messaging
    seen = sorted(set(matches))
    return "\n".join(f"- [[{k}-rail|{CURATED_PAYMENT_RAILS.get(k, {}).get('full_name', k)}]]" for k in seen)


def _frontmatter(fields: dict) -> str:
    lines = ["---"]
    for k, v in fields.items():
        if isinstance(v, list):
            lines.append(f"{k}:")
            for item in v:
                lines.append(f"  - {item}")
        else:
            lines.append(f"{k}: {json.dumps(v) if isinstance(v, str) else v}")
    lines.append("---")
    return "\n".join(lines)


# ==============================================================================
# 8. VAULT BUILDER  — orchestrates one full generation cycle
# ==============================================================================

class VaultBuilder:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.writer = ManagedFileWriter(cfg)
        self.country_source = CountrySource(cfg)
        self.population_source = PopulationSource(cfg)
        self.fx_source = FXSource(cfg)
        self.policy_source = PolicyRateSource(cfg)
        self._countries_cache: list[dict] = []
        self._countries_lock = threading.Lock()

    def _set_countries(self, countries: list[dict]) -> None:
        with self._countries_lock:
            self._countries_cache = countries

    def _get_countries(self) -> list[dict]:
        with self._countries_lock:
            if self._countries_cache:
                return self._countries_cache
        return self.country_source.fetch()

    def ensure_dirs(self) -> None:
        for sub in ("00-MOC", "10-Countries", "20-Central-Banks", "30-Payment-Rails", "40-Currencies"):
            (self.cfg.vault_path / sub).mkdir(parents=True, exist_ok=True)

    # ---- jobs, each is independently schedulable -----------------------

    def job_countries(self) -> None:
        countries = self.country_source.fetch()
        population = self.population_source.fetch()
        for c in countries:
            pop = population.get(c["cca3"])
            if pop is not None:
                c["population"] = pop
        self._set_countries(countries)

        changed = 0
        fx = self.fx_source._load_cache() or {"rates": {}}
        for c in countries:
            cb = CURATED_CENTRAL_BANKS.get(c["cca3"])
            body = render_country_md(c, fx, cb)
            path = self.cfg.vault_path / "10-Countries" / f"{c['cca3']}-country.md"
            if self.writer.write(path, body):
                changed += 1

        # Only cascade full rebuilds if country data actually changed
        if changed > 0 or not (self.cfg.vault_path / "00-MOC" / "Countries-MOC.md").exists():
            self._build_central_banks()
            self._build_currencies()
            self._build_moc()
            self._export_graph()
        log.info("job_countries: %s/%s files updated", changed, len(countries))

    def job_fx(self) -> None:
        fx = self.fx_source.fetch()
        countries = self._get_countries()
        changed = 0
        for c in countries:
            cb = CURATED_CENTRAL_BANKS.get(c["cca3"])
            body = render_country_md(c, fx, cb)
            path = self.cfg.vault_path / "10-Countries" / f"{c['cca3']}-country.md"
            if self.writer.write(path, body):
                changed += 1

        if changed > 0:
            self._build_currencies()
            self._export_graph(fx)
        log.info("job_fx: %s/%s country files refreshed with new rates", changed, len(countries))

    def job_rail_status(self) -> None:
        changed = 0
        for key, rail in CURATED_PAYMENT_RAILS.items():
            body = render_payment_rail_md(key, rail)
            path = self.cfg.vault_path / "30-Payment-Rails" / f"{key}-rail.md"
            if self.writer.write(path, body):
                changed += 1
        if changed > 0:
            self._export_graph()
        log.info("job_rail_status: %s/%s rail files refreshed", changed, len(CURATED_PAYMENT_RAILS))

    def job_policy_rates(self) -> None:
        self._build_central_banks(self.policy_source.fetch())
        self._export_graph()

    # ---- internal helpers -----------------------------------------------

    def _build_central_banks(self, policy_rates: Optional[dict[str, dict]] = None) -> None:
        countries = self._get_countries()
        policy_rates = policy_rates or self.policy_source._load_cache() or {}
        changed = 0
        for c in countries:
            cca3, name = c["cca3"], c["name"]
            cb = dict(CURATED_CENTRAL_BANKS.get(cca3, {}))
            cb.update(policy_rates.get(cca3, {}))
            cb["_curated"] = cca3 in CURATED_CENTRAL_BANKS
            if not cb.get("name"):
                cb["name"] = f"Central Bank of {name}"
            body = render_central_bank_md(cca3, name, cb)
            path = self.cfg.vault_path / "20-Central-Banks" / f"{cca3}-central-bank.md"
            if self.writer.write(path, body):
                changed += 1
        log.info("_build_central_banks: %s/%s files updated", changed, len(countries))

    def _build_currencies(self) -> None:
        countries = self._get_countries()
        fx = self.fx_source._load_cache() or {"rates": {}}
        grouped: dict[str, list[dict]] = {}
        for country in countries:
            code = country.get("currency", "N/A")
            if code and code != "N/A":
                grouped.setdefault(code, []).append(country)

        changed = 0
        for code, currency_countries in grouped.items():
            body = render_currency_md(code, currency_countries, fx)
            path = self.cfg.vault_path / "40-Currencies" / f"{code}-currency.md"
            if self.writer.write(path, body):
                changed += 1
        log.info("_build_currencies: %s/%s files updated", changed, len(grouped))

    def _build_moc(self) -> None:
        countries = self._get_countries()
        mocs = {
            "00-MOC/Countries-MOC.md": render_moc_md(
                "Countries — Map of Content",
                'TABLE region, currency, central_bank FROM "10-Countries" SORT region ASC',
                "Every sovereign state currently tracked. Auto-refreshed daily.",
            ),
            "00-MOC/Central-Banks-MOC.md": render_moc_md(
                "Central Banks — Map of Content",
                'TABLE code, data_quality FROM "20-Central-Banks" SORT data_quality ASC',
                "Curated entries surface above auto-stubs (sorted by data_quality).",
            ),
            "00-MOC/Payment-Rails-MOC.md": render_moc_md(
                "Payment Rails — Map of Content",
                'TABLE scope, rail_type, operator FROM "30-Payment-Rails"',
                "Global messaging & settlement infrastructure, with live open/closed status.",
            ),
            "00-MOC/Currencies-MOC.md": render_moc_md(
                "Currencies — Map of Content",
                'TABLE currency_code, country_count FROM "40-Currencies" SORT currency_code ASC',
                "FX cross-rate hubs grouped from the tracked country dataset.",
            ),
            "00-MOC/Global-Financial-System.md": render_moc_md(
                "\U0001F30D Global Financial System — Root MOC",
                'TABLE type, tags FROM "" WHERE type != null LIMIT 20',
                "Top of the graph. Start here: [[Countries-MOC]] · "
                "[[Central-Banks-MOC]] · [[Payment-Rails-MOC]]",
            ),
        }
        regions = sorted({country["region"] for country in countries if country.get("region")})
        for region in regions:
            mocs[f"00-MOC/{slugify(region)}-MOC.md"] = render_moc_md(
                f"{region} — Map of Content",
                f'TABLE name, iso3, currency FROM "10-Countries" WHERE region = "{region}" SORT name ASC',
                f"Countries in the {region} region.",
            )
        for rel_path, body in mocs.items():
            self.writer.write(self.cfg.vault_path / rel_path, body)

    def _export_graph(self, fx: Optional[dict] = None) -> None:
        """Export the dashboard contract from the same entities as the vault."""
        countries = sorted(self._get_countries(), key=lambda country: country["cca3"])
        fx = fx or self.fx_source._load_cache() or {"rates": {}, "fetched_at": None}
        policy_rates = self.policy_source._load_cache() or {}
        rates_by_country = policy_rates.get("rates", {})
        nodes: list[dict] = []
        links: list[dict] = []

        for country in countries:
            iso3 = country["cca3"]
            currency = country.get("currency", "N/A")
            central_bank = CURATED_CENTRAL_BANKS.get(iso3, {})
            rate = rates_by_country.get(iso3, {})
            nodes.extend((
                {
                    "id": f"country:{iso3}", "type": "country", "label": country["name"],
                    "data_quality": "source", "attributes": {
                        "iso2": country.get("cca2"), "iso3": iso3,
                        "region": country.get("region"), "population": country.get("population"),
                    },
                },
                {
                    "id": f"central-bank:{iso3}", "type": "central-bank",
                    "label": central_bank.get("name", f"Central Bank of {country['name']}"),
                    "data_quality": "curated" if central_bank else "auto-stub",
                    "attributes": {"country": iso3, "policy_rate": rate.get("policy_rate")},
                },
            ))
            links.append({"source": f"country:{iso3}", "target": f"central-bank:{iso3}", "type": "governed-by"})
            if currency and currency != "N/A":
                links.append({"source": f"country:{iso3}", "target": f"currency:{currency}", "type": "uses"})

        for currency in sorted({country.get("currency") for country in countries if country.get("currency") not in (None, "N/A")}):
            users = [country for country in countries if country.get("currency") == currency]
            nodes.append({
                "id": f"currency:{currency}", "type": "currency", "label": currency,
                "data_quality": "source", "attributes": {
                    "usd_rate": fx.get("rates", {}).get(currency), "country_count": len(users),
                },
            })

        for key, rail in sorted(CURATED_PAYMENT_RAILS.items()):
            is_open, window = RailStatusCalculator.is_open(rail)
            nodes.append({
                "id": f"payment-rail:{key}", "type": "payment-rail", "label": rail["full_name"],
                "data_quality": "curated", "attributes": {
                    "code": key, "is_open": is_open, "operating_window": window,
                    "operator": rail["operator"], "scope": rail["scope"],
                },
            })
            for iso3 in rail.get("settles_in", []):
                if any(country["cca3"] == iso3 for country in countries):
                    links.append({"source": f"payment-rail:{key}", "target": f"country:{iso3}", "type": "settles-for"})

        write_json_atomic(self.cfg.graph_export_file, {
            "schema_version": "1.0",
            "generated_at": _utcnow_iso(),
            "sources": {"fx_as_of": fx.get("date"), "fx_fetched_at": fx.get("fetched_at")},
            "nodes": nodes,
            "links": links,
        })


# ==============================================================================
# 9. DAEMON RUNNER  — signal-safe scheduler loop
# ==============================================================================

@dataclass
class Job:
    name: str
    interval: int
    func: Callable[[], None]
    next_run: float = field(default_factory=time.time)


class DashboardDataServer:
    """Serve only the generated graph contract on localhost for the dashboard."""

    def __init__(self, export_file: Path, port: int):
        self.export_file = export_file

        class Handler(BaseHTTPRequestHandler):
            def do_GET(handler) -> None:  # noqa: N802 - required stdlib hook name
                if handler.path != "/world-money-graph.v1.json" or not export_file.exists():
                    handler.send_error(404)
                    return
                body = export_file.read_bytes()
                handler.send_response(200)
                handler.send_header("Content-Type", "application/json; charset=utf-8")
                handler.send_header("Access-Control-Allow-Origin", "*")
                handler.send_header("Cache-Control", "no-store")
                handler.send_header("Content-Length", str(len(body)))
                handler.end_headers()
                handler.wfile.write(body)

            def log_message(handler, _format: str, *_args: object) -> None:
                return

        self.server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}/world-money-graph.v1.json"

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


class DaemonRunner:
    def __init__(self, cfg: Config, builder: VaultBuilder):
        self.cfg = cfg
        self.builder = builder
        self._stop = threading.Event()
        self.dashboard_server: Optional[DashboardDataServer] = None
        self.jobs = [
            Job("countries", cfg.interval_country_metadata, builder.job_countries),
            Job("fx", cfg.interval_fx_rates, builder.job_fx),
            Job("rail_status", cfg.interval_rail_status, builder.job_rail_status),
            Job("policy_rates", cfg.interval_policy_rates, builder.job_policy_rates),
        ]
        signal.signal(signal.SIGINT, self._handle_signal)
        signal.signal(signal.SIGTERM, self._handle_signal)

    def _handle_signal(self, signum, _frame) -> None:
        log.info("received signal %s — shutting down after current cycle", signum)
        self._stop.set()

    def run_once_all(self) -> None:
        """Run every job a single time, in parallel, then return. For cron users."""
        with ThreadPoolExecutor(max_workers=self.cfg.workers) as pool:
            futures = {pool.submit(j.func): j.name for j in self.jobs}
            for fut in as_completed(futures):
                name = futures[fut]
                try:
                    fut.result()
                except Exception:
                    log.exception("job '%s' raised an exception", name)
        self._persist_state()

    def run_forever(self) -> None:
        log.info("daemon starting — vault at %s", self.cfg.vault_path.resolve())
        if self.cfg.dashboard_port:
            self.dashboard_server = DashboardDataServer(self.cfg.graph_export_file, self.cfg.dashboard_port)
            self.dashboard_server.start()
            log.info("dashboard contract available at %s", self.dashboard_server.url)
        self.run_once_all()  # always build once immediately on startup
        while not self._stop.is_set():
            now = time.time()
            due = [j for j in self.jobs if j.next_run <= now]
            if due:
                with ThreadPoolExecutor(max_workers=self.cfg.workers) as pool:
                    futures = {pool.submit(j.func): j for j in due}
                    for fut in as_completed(futures):
                        job = futures[fut]
                        try:
                            fut.result()
                        except Exception:
                            log.exception("job '%s' raised an exception", job.name)
                        job.next_run = time.time() + job.interval
                self._persist_state()

            sleep_for = min((j.next_run for j in self.jobs), default=now + 5) - time.time()
            self._stop.wait(timeout=max(1.0, min(sleep_for, 30.0)))
        if self.dashboard_server:
            self.dashboard_server.stop()
        log.info("daemon stopped cleanly")

    def _persist_state(self) -> None:
        self.cfg.system_dir.mkdir(parents=True, exist_ok=True)
        state = {
            "last_cycle_utc": _utcnow_iso(),
            "jobs": {j.name: {"interval_s": j.interval, "next_run_utc":
                     datetime.fromtimestamp(j.next_run, tz=timezone.utc).isoformat()}
                     for j in self.jobs},
        }
        self.cfg.state_file.write_text(json.dumps(state, indent=2))


# ==============================================================================
# 10. CLI ENTRYPOINT
# ==============================================================================

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="World Money Financial Data Refresh Daemon")
    p.add_argument("--vault-path", type=Path, default=Path("./FinanceVault"))
    p.add_argument("--once", action="store_true", help="run a single build cycle and exit (cron-friendly)")
    p.add_argument("--workers", type=int, default=8)
    p.add_argument("--dashboard-port", type=int, default=0,
                   help="serve the graph export on localhost (0 disables it)")
    p.add_argument("--log-level", default="INFO")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    cfg = Config(vault_path=args.vault_path, workers=args.workers, dashboard_port=args.dashboard_port,
                 log_level=args.log_level)
    cfg.vault_path.mkdir(parents=True, exist_ok=True)
    setup_logging(cfg)

    builder = VaultBuilder(cfg)
    builder.ensure_dirs()
    runner = DaemonRunner(cfg, builder)

    if args.once:
        runner.run_once_all()
        log.info("single build cycle complete — vault ready at %s", cfg.vault_path.resolve())
    else:
        runner.run_forever()


if __name__ == "__main__":
    main()
