from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Optional

from supabase import create_client, Client

LOGGER = logging.getLogger("storage")
BUCKET = "podcasts"

_client: Optional[Client] = None


def _get_client() -> Client:
    global _client
    if _client is None:
        url = os.getenv("SUPABASE_URL")
        key = os.getenv("SUPABASE_KEY")
        if not url or not key:
            raise RuntimeError("SUPABASE_URL and SUPABASE_KEY environment variables must be set.")
        _client = create_client(url, key)
    return _client


def upload_file(local_path: Path, destination_name: str) -> str:
    """Upload a local file to the podcasts bucket. Returns the public CDN URL."""
    client = _get_client()
    with open(local_path, "rb") as f:
        data = f.read()
    mime = _mime_for(local_path.suffix)
    # Remove existing file first to allow overwrite (upsert)
    try:
        client.storage.from_(BUCKET).remove([destination_name])
    except Exception:
        pass
    client.storage.from_(BUCKET).upload(
        path=destination_name,
        file=data,
        file_options={"content-type": mime},
    )
    url = client.storage.from_(BUCKET).get_public_url(destination_name)
    LOGGER.info("Uploaded %s → %s", destination_name, url)
    return url


def upload_json(data: dict, destination_name: str) -> None:
    """Upload a dict as a JSON file to the podcasts bucket."""
    client = _get_client()
    payload = json.dumps(data).encode()
    try:
        client.storage.from_(BUCKET).remove([destination_name])
    except Exception:
        pass
    client.storage.from_(BUCKET).upload(
        path=destination_name,
        file=payload,
        file_options={"content-type": "application/json"},
    )
    LOGGER.info("Uploaded JSON → %s", destination_name)


def download_json(destination_name: str) -> Optional[dict]:
    """Download a JSON file from the bucket. Returns None if not found."""
    client = _get_client()
    try:
        data = client.storage.from_(BUCKET).download(destination_name)
        return json.loads(data)
    except Exception:
        LOGGER.debug("Could not download %s from Supabase", destination_name)
        return None


def _mime_for(suffix: str) -> str:
    return {
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".flac": "audio/flac",
        ".ogg": "audio/ogg",
    }.get(suffix.lower(), "application/octet-stream")
