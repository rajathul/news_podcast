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

from audio_podcast_backend import (
    ensure_audio_for_feed,
    get_all_audio_statuses,
    get_audio_status,
)


USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
REQUEST_TIMEOUT_SECONDS = 10
NAMESPACES = {
    "media": "https://search.yahoo.com/mrss/",
    "dc": "https://purl.org/dc/elements/1.1/",
    "content": "http://purl.org/rss/1.0/modules/content/",
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
    import re
    
    # Try media namespace sources first - check all media: elements
    for media_elem in item.findall(".//media:*", NAMESPACES):
        if media_elem.attrib.get("url"):
            url = media_elem.attrib["url"]
            media_type = media_elem.attrib.get("type", "")
            # Accept any media content, prioritize images
            if media_type.startswith("image") or "jpg" in url or "png" in url or "jpeg" in url or not media_type:
                return url

    # Look for images in description content
    description = item.findtext("description", default="")
    if description:
        img_matches = re.findall(r'<img[^>]+src=["\']([^"\']+)["\']', description, re.IGNORECASE)
        for img_url in img_matches:
            return img_url

    # Check for content:encoded which often contains full HTML
    content_encoded = item.find("content:encoded", NAMESPACES)
    if content_encoded is not None and content_encoded.text:
        img_matches = re.findall(r'<img[^>]+src=["\']([^"\']+)["\']', content_encoded.text, re.IGNORECASE)
        for img_url in img_matches:
            return img_url

    # Check all enclosure tags
    for enclosure in item.findall("enclosure"):
        url = enclosure.attrib.get("url", "")
        enc_type = enclosure.attrib.get("type", "")
        if enc_type.startswith("image") or any(ext in url.lower() for ext in ['.jpg', '.jpeg', '.png', '.gif', '.webp']):
            return url

    # Look for any element that might contain an image URL
    for child in item.iter():
        # Check attributes for image URLs
        for attr_name, attr_value in child.attrib.items():
            if attr_value and any(ext in attr_value.lower() for ext in ['jpg', 'jpeg', 'png', 'gif', 'webp']):
                if attr_value.startswith('http'):
                    return attr_value

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

        image_url = _extract_image(item)
        
        # If no image found, create a placeholder using a more reliable service
        if not image_url:
            # Use Picsum Photos which is more reliable and doesn't require text
            import hashlib
            article_hash = hashlib.md5(f"{title}{link}".encode()).hexdigest()[:6]
            # Generate a seed based on the article for consistent images
            seed = int(article_hash, 16) % 1000
            image_url = f"https://picsum.photos/400/300?random={seed}"
        
        # Debug: Uncomment to see image extraction results
        # print(f"DEBUG: Article '{title[:50]}...' -> Image: {image_url}")
        
        articles.append(
            {
                "title": title,
                "description": description,
                "link": link,
                "published": published,
                "author": author,
                "categories": categories,
                "image": image_url,
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
    audio_job = await ensure_audio_for_feed(feed_url, title, items)
    return {"source": feed_url, "title": title, "items": items, "audio": audio_job}


@app.get("/api/audio/status")
async def audio_status(feed: Optional[str] = Query(None)) -> Dict[str, Any]:
    if feed:
        return await get_audio_status(feed.strip())
    return {"items": await get_all_audio_statuses()}


@app.get("/healthz")
async def healthz() -> Dict[str, str]:
    return {"status": "ok"}
