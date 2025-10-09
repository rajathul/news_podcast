from __future__ import annotations

import re
from datetime import datetime, timezone
from html import unescape
from typing import Any, Dict, List, Optional, Tuple
from xml.etree import ElementTree as ET

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.requests import Request


USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
REQUEST_TIMEOUT_SECONDS = 10
NAMESPACES = {
    "media": "http://search.yahoo.com/mrss/",
    "dc": "http://purl.org/dc/elements/1.1/",
}


app = FastAPI(title="News Feed Viewer", description="Blend multiple RSS feeds into a single, polished stream.", version="1.1.0")

templates = Jinja2Templates(directory="templates")
app.mount("/static", StaticFiles(directory="static"), name="static")


def _strip_html(value: Optional[str]) -> str:
    """
    Remove HTML tags from the feed snippet while preserving basic punctuation.
    """
    if not value:
        return ""

    # Remove HTML tags and normalise whitespace.
    text = re.sub(r"<[^>]+>", "", value)
    text = re.sub(r"\s+", " ", text)
    return unescape(text).strip()


def _parse_datetime(date_text: Optional[str]) -> Optional[str]:
    if not date_text:
        return None

    for fmt in (
        "%a, %d %b %Y %H:%M:%S %z",
        "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%d %H:%M:%S",
    ):
        try:
            parsed = datetime.strptime(date_text, fmt)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc).isoformat()
        except ValueError:
            continue
    return None


def _extract_image(item: ET.Element) -> Optional[str]:
    # Try media namespace sources first.
    media_content = item.find("media:content", NAMESPACES)
    if media_content is not None and media_content.attrib.get("url"):
        return media_content.attrib["url"]

    media_thumbnail = item.find("media:thumbnail", NAMESPACES)
    if media_thumbnail is not None and media_thumbnail.attrib.get("url"):
        return media_thumbnail.attrib["url"]

    # Fall back to standard enclosure tags.
    enclosure = item.find("enclosure")
    if enclosure is not None:
        if enclosure.attrib.get("type", "").startswith("image"):
            return enclosure.attrib.get("url")

    return None


async def fetch_articles(feed_url: str) -> Tuple[str, List[Dict[str, Any]]]:
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS, follow_redirects=True) as client:
            response = await client.get(feed_url, headers={"User-Agent": USER_AGENT})
            response.raise_for_status()
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Unable to fetch feed: {exc}") from exc

    try:
        root = ET.fromstring(response.text)
    except ET.ParseError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to parse feed XML: {exc}") from exc

    channel = root.find("channel")
    if channel is None:
        raise HTTPException(status_code=500, detail="Unexpected feed format: missing channel element.")

    channel_title = _strip_html(channel.findtext("title", default="")) or feed_url

    articles: List[Dict[str, Any]] = []
    for item in channel.findall("item"):
        title = _strip_html(item.findtext("title", default="Untitled"))
        description = _strip_html(item.findtext("description", default=""))
        link = item.findtext("link", default="").strip()
        published = _parse_datetime(item.findtext("pubDate"))
        author = _strip_html(item.findtext("dc:creator", default="") or item.findtext("author"))
        categories = [
            _strip_html(cat.text) for cat in item.findall("category") if cat.text
        ]

        articles.append(
            {
                "title": title,
                "description": description,
                "link": link,
                "published": published,
                "author": author,
                "categories": categories,
                "image": _extract_image(item),
            }
        )

    return channel_title, articles


@app.get("/", response_class=HTMLResponse)
async def home(request: Request) -> HTMLResponse:
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/api/articles")
async def get_articles(feed: str = Query(..., description="RSS feed URL to fetch.")) -> Dict[str, Any]:
    feed_url = feed.strip()
    if not feed_url:
        raise HTTPException(status_code=400, detail="Feed must be provided.")
    if not feed_url.lower().startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Feed must be a valid HTTP or HTTPS URL.")

    title, items = await fetch_articles(feed_url)
    return {"source": feed_url, "title": title, "items": items}


@app.get("/healthz")
async def healthz() -> Dict[str, str]:
    return {"status": "ok"}
