from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import logging
import math
import os
import time
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple
from google import genai
from google.genai import types


LOGGER = logging.getLogger("audio_podcast_backend")

TRANSCRIPT_MODEL = "gemini-2.5-flash"
TTS_MODEL = "gemini-2.5-flash-preview-tts"
OUTPUT_DIR = Path("static/podcasts")
MAX_PROMPT_ARTICLES = 8
MAX_DIGEST_ARTICLES_PER_SECTION = 10
DIGEST_FEED_URL = "digest://daily"
DIGEST_META_PATH = OUTPUT_DIR / "digest_meta.json"
DEFAULT_SPEAKERS = (
    ("Anya", "Kore"),
    ("Liam", "Puck"),
)
DEFAULT_SAMPLE_RATE = 24000
DEFAULT_SAMPLE_WIDTH = 2
DEFAULT_CHANNELS = 1
FAKE_AUDIO_SECONDS = 8
FAKE_AUDIO_FREQUENCY = 440.0


def _env_fake_audio_flag() -> bool:
    return os.getenv("PODCAST_FAKE_AUDIO", "").strip().lower() in {"1", "true", "yes", "on"}


def _ensure_directory(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def _extract_audio_bytes(response: types.GenerateContentResponse) -> tuple[bytes, str]:
    candidate = response.candidates[0]
    if not candidate.content.parts:
        raise ValueError("No audio parts returned by TTS model.")
    part = candidate.content.parts[0]
    inline = getattr(part, "inline_data", None)
    if inline is None or not inline.data:
        raise ValueError("TTS response missing inline audio data.")
    payload = inline.data
    mime = inline.mime_type or "audio/mpeg"
    if isinstance(payload, str):
        try:
            return base64.b64decode(payload), mime
        except (ValueError, base64.binascii.Error) as exc:
            raise ValueError("Unable to decode inline audio payload.") from exc
    if isinstance(payload, (bytes, bytearray)):
        return bytes(payload), mime
    raise ValueError("Inline audio payload not in recognised format.")


def _has_wav_header(data: bytes) -> bool:
    return len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WAVE"


def _has_mp3_header(data: bytes) -> bool:
    return len(data) >= 2 and (data[:2] == b"\xff\xfb" or data[:3] == b"ID3")


def _wrap_pcm_as_wav(pcm: bytes, channels: int = DEFAULT_CHANNELS, sample_width: int = DEFAULT_SAMPLE_WIDTH, sample_rate: int = DEFAULT_SAMPLE_RATE) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(channels)
        wav_file.setsampwidth(sample_width)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm)
    return buffer.getvalue()


def _sine_wave_pcm(duration_seconds: int, sample_rate: int, frequency: float, amplitude: float = 0.32) -> bytes:
    total_samples = int(duration_seconds * sample_rate)
    max_amplitude = int((2 ** (DEFAULT_SAMPLE_WIDTH * 8 - 1)) - 1)
    scaled_amplitude = max(0, min(1, amplitude)) * max_amplitude
    frames = bytearray()
    for index in range(total_samples):
        sample = int(scaled_amplitude * math.sin(2 * math.pi * frequency * (index / sample_rate)))
        frames.extend(sample.to_bytes(DEFAULT_SAMPLE_WIDTH, byteorder="little", signed=True))
    return bytes(frames)


def _normalise_audio_bytes(audio_bytes: bytes, mime_type: str) -> tuple[bytes, str]:
    if _has_wav_header(audio_bytes):
        return audio_bytes, "audio/wav"
    if _has_mp3_header(audio_bytes):
        return audio_bytes, "audio/mpeg"

    mime_lower = (mime_type or "").lower()
    if mime_lower in {"audio/mpeg", "audio/mp3"}:
        return audio_bytes, "audio/mpeg"
    if mime_lower in {"audio/wav", "audio/x-wav"} and _has_wav_header(audio_bytes):
        return audio_bytes, "audio/wav"

    wrapped = _wrap_pcm_as_wav(audio_bytes)
    return wrapped, "audio/wav"


def _articles_digest(articles: Iterable[Dict[str, str]]) -> str:
    normalised: List[Dict[str, str]] = []
    for article in articles:
        if not isinstance(article, dict):
            continue
        normalised.append(
            {
                "title": (article.get("title") or "").strip(),
                "description": (article.get("description") or "").strip(),
                "link": (article.get("link") or "").strip(),
            }
        )
    encoded = json.dumps(normalised, sort_keys=True, ensure_ascii=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _articles_prompt_snippet(articles: List[Dict[str, str]], limit: int = MAX_PROMPT_ARTICLES) -> str:
    lines = []
    for idx, article in enumerate(articles[:limit], start=1):
        title = (article.get("title") or "").strip()
        desc = (article.get("description") or "").strip()
        lines.append(f"{idx}. {title}\nSummary: {desc}")
    return "\n\n".join(lines)


@dataclass
class AudioJob:
    feed_url: str
    channel_title: str
    content_hash: str
    articles: List[Dict[str, str]]
    status: str = "pending"
    audio_path: Optional[Path] = None
    audio_url: Optional[str] = None
    audio_mime_type: Optional[str] = None
    transcript: Optional[str] = None
    error: Optional[str] = None
    updated_at: float = field(default_factory=time.time)
    task: Optional[asyncio.Task] = None
    sections: Optional[List[Tuple[str, List[Dict[str, str]]]]] = None

    def to_dict(self) -> Dict[str, Optional[str]]:
        return {
            "feed": self.feed_url,
            "status": self.status,
            "audio_url": self.audio_url,
            "mime_type": self.audio_mime_type,
            "transcript": self.transcript,
            "error": self.error,
            "updated_at": self.updated_at,
        }


class AudioPodcastManager:
    def __init__(
        self,
        output_dir: Path = OUTPUT_DIR,
        transcript_model: str = TRANSCRIPT_MODEL,
        tts_model: str = TTS_MODEL,
        speakers: Iterable[tuple[str, str]] = DEFAULT_SPEAKERS,
        use_fake_audio: Optional[bool] = None,
    ) -> None:
        self.output_dir = _ensure_directory(Path(output_dir))
        self.transcript_model = transcript_model
        self.tts_model = tts_model
        self.speakers = tuple(speakers)
        self._jobs: Dict[str, AudioJob] = {}
        self._jobs_lock = asyncio.Lock()
        self._client: Optional[genai.Client] = None
        self._explicit_fake_audio = use_fake_audio

    def _using_fake_audio(self) -> bool:
        if self._explicit_fake_audio is not None:
            return bool(self._explicit_fake_audio)
        return _env_fake_audio_flag()

    def _client_guard(self) -> genai.Client:
        if self._client is None:
            if genai is None:
                raise RuntimeError("google-genai package not available; install dependency.")
            api_key = os.getenv("GEMINI_API_KEY")
            if not api_key:
                raise RuntimeError("GEMINI_API_KEY environment variable not set")
            self._client = genai.Client(api_key=api_key)
        return self._client

    def _has_api_key(self) -> bool:
        return bool(os.getenv("GEMINI_API_KEY"))

    async def ensure_audio(self, feed_url: str, channel_title: str, articles: List[Dict[str, str]]) -> AudioJob:
        content_hash = _articles_digest(articles)
        async with self._jobs_lock:
            job = self._jobs.get(feed_url)
            if job and job.content_hash == content_hash:
                if job.status in {"pending", "generating"} and job.task and not job.task.done():
                    return job
                if job.status == "ready" and job.audio_path and job.audio_path.exists():
                    return job
                if job.status == "error":
                    LOGGER.info("Retrying audio generation for feed %s", feed_url)
            elif job and job.content_hash != content_hash:
                if job.task and not job.task.done():
                    job.task.cancel()
            job = AudioJob(
                feed_url=feed_url,
                channel_title=channel_title,
                content_hash=content_hash,
                articles=list(articles),
            )
            job.task = asyncio.create_task(self._run_job(job))
            self._jobs[feed_url] = job
            return job

    async def _run_job(self, job: AudioJob) -> None:
        job.status = "generating"
        job.updated_at = time.time()
        try:
            fake_audio_mode = self._using_fake_audio()
            use_real_transcript = self._has_api_key()
            LOGGER.info(
                "Starting job for feed %s (transcript=%s, tts=%s)",
                job.feed_url,
                "gemini" if use_real_transcript else "dummy",
                "skipped" if fake_audio_mode else "gemini",
            )

            # Transcript — real if API key present, dummy otherwise
            if use_real_transcript:
                if job.sections:
                    transcript = await asyncio.to_thread(self._generate_digest_transcript, job.sections)
                else:
                    transcript = await asyncio.to_thread(self._generate_transcript, job.channel_title, job.articles)
            else:
                transcript = self._generate_dummy_transcript(job.channel_title, job.articles)
            job.transcript = transcript
            print(f"\n{'=' * 60}\nPODCAST SCRIPT — {job.channel_title}\n{'=' * 60}\n{transcript}\n{'=' * 60}\n")

            # Audio — skip TTS when fake mode is on
            if fake_audio_mode:
                audio_bytes, mime_type = self._generate_dummy_audio(transcript)
            else:
                audio_bytes, mime_type = await asyncio.to_thread(self._synthesise_audio, transcript)
            audio_bytes, mime_type = await asyncio.to_thread(_normalise_audio_bytes, audio_bytes, mime_type)
            audio_path = self._write_audio(job.feed_url, audio_bytes, mime_type)
            job.audio_path = audio_path
            job.audio_url = f"/static/podcasts/{audio_path.name}"
            job.audio_mime_type = mime_type
            job.status = "ready"
            job.updated_at = time.time()
            if job.feed_url == DIGEST_FEED_URL:
                self._save_digest_meta(job)
            LOGGER.info(
                "Completed %s audio generation for %s (%s)",
                "fake" if fake_audio_mode else "Gemini",
                job.feed_url,
                job.audio_mime_type,
            )
        except asyncio.CancelledError:
            job.status = "cancelled"
            job.updated_at = time.time()
            LOGGER.debug("Audio generation cancelled for %s", job.feed_url)
            raise
        except Exception as exc:
            job.status = "error"
            job.error = str(exc)
            job.updated_at = time.time()
            LOGGER.exception("Audio generation failed for %s", job.feed_url)

    def _generate_transcript(self, channel_title: str, articles: List[Dict[str, str]]) -> str:
        if genai is None or types is None:
            raise RuntimeError("google-genai package is required for real transcript generation.")
        LOGGER.info("Requesting Gemini transcript for feed '%s' with %d articles", channel_title, len(articles))
        prompt = (
            "Generate a conversational podcast dialogue between two news anchors named Liam and Anya. "
            "Liam is serious and concise, while Anya is witty and energetic. "
            "Blend the provided article summaries into a cohesive 2-3 minute script. "
            "Avoid repeating the feed title verbatim more than once and include smooth transitions between stories.\n\n"
            f"Feed: {channel_title}\n\nArticles:\n{_articles_prompt_snippet(articles)}\n"
        )
        client = self._client_guard()
        response = client.models.generate_content(
            model=self.transcript_model,
            contents=prompt,
        )
        if not response.text:
            raise ValueError("Transcript generation returned empty content.")
        return response.text.strip()

    def _generate_digest_transcript(self, sections: List[Tuple[str, List[Dict[str, str]]]]) -> str:
        if genai is None or types is None:
            raise RuntimeError("google-genai package is required for real transcript generation.")
        section_blocks = []
        for section_name, articles in sections:
            snippet = _articles_prompt_snippet(articles[:MAX_DIGEST_ARTICLES_PER_SECTION], limit=MAX_DIGEST_ARTICLES_PER_SECTION)
            section_blocks.append(f"[{section_name.upper()}]\n{snippet}")
        sections_text = "\n\n---\n\n".join(section_blocks)
        prompt = (
            "You are writing a daily morning news podcast script for two anchors:\n"
            "- Liam: calm, authoritative, strong on geopolitics and context. Gives depth and weight to big stories.\n"
            "- Anya: sharp, witty, great at finding surprising angles, human stakes, and keeping energy high.\n\n"
            "The podcast covers four sections in this order:\n"
            "1. World News\n"
            "2. Markets & Finance\n"
            "3. Sports\n"
            "4. Entertainment\n\n"
            "Guidelines:\n"
            "- From the articles provided, pick the 4-5 most significant and interesting stories per section.\n"
            "  Prioritise: stories with wide impact, breaking developments, surprising twists, or strong human angles.\n"
            "  Skip filler, routine updates, or stories with no compelling hook.\n"
            "- Open with a punchy intro — Liam sets the stage, Anya immediately pulls the listener in with something unexpected.\n"
            "- Give each story the space it deserves: a major geopolitical event warrants more depth than a sports result.\n"
            "  Let important stories breathe with analysis and reaction; lighter stories can be punchy and quick.\n"
            "- Transition between sections with a line that naturally bridges the themes\n"
            "  (e.g. 'Those geopolitical tremors are already rattling currency markets, Anya...').\n"
            "- Let personality drive the script: Liam provides context and stakes, Anya adds wit, a fresh angle, or a moment of levity.\n"
            "  Let them disagree, riff off each other, or react genuinely — it should feel like a real conversation, not a readout.\n"
            "- End with a memorable sign-off that ties the day's themes together and leaves the listener feeling informed.\n"
            "- Write as much as the stories demand. Do not pad, but do not rush a story that deserves more.\n"
            "- Format strictly as: 'Liam: ...' or 'Anya: ...' — one speaker per line, no stage directions or section headers.\n\n"
            f"TODAY'S STORIES:\n\n{sections_text}\n"
        )
        LOGGER.info("Requesting Gemini digest transcript with %d sections", len(sections))
        client = self._client_guard()
        response = client.models.generate_content(
            model=self.transcript_model,
            contents=prompt,
        )
        if not response.text:
            raise ValueError("Digest transcript generation returned empty content.")
        return response.text.strip()

    def _synthesise_audio(self, transcript: str) -> tuple[bytes, str]:
        if genai is None or types is None:
            raise RuntimeError("google-genai package is required for real audio synthesis.")
        LOGGER.info("Requesting Gemini TTS synthesis for transcript (%d chars)", len(transcript))
        client = self._client_guard()
        speaker_configs = []
        for speaker_name, voice_name in self.speakers:
            speaker_configs.append(
                types.SpeakerVoiceConfig(
                    speaker=speaker_name,
                    voice_config=types.VoiceConfig(
                        prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice_name)
                    ),
                )
            )
        response = client.models.generate_content(
            model=self.tts_model,
            contents=transcript,
            config=types.GenerateContentConfig(
                response_modalities=["AUDIO"],
                speech_config=types.SpeechConfig(
                    multi_speaker_voice_config=types.MultiSpeakerVoiceConfig(
                        speaker_voice_configs=speaker_configs
                    )
                ),
            ),
        )
        return _extract_audio_bytes(response)

    def _generate_dummy_transcript(self, channel_title: str, articles: List[Dict[str, str]]) -> str:
        headlines = ", ".join(article.get("title") or "Untitled story" for article in articles[:MAX_PROMPT_ARTICLES])
        timestamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
        return (
            f"[FAKE PODCAST SCRIPT]\n"
            f"Feed: {channel_title}\n"
            f"Generated: {timestamp}\n"
            f"Stories discussed: {headlines or 'No stories available'}\n"
            "Hosts Liam and Anya share highlights in this simulated recording."
        )

    def _generate_dummy_audio(self, transcript: str) -> tuple[bytes, str]:
        duration = max(2, int(FAKE_AUDIO_SECONDS))
        LOGGER.info("Generating fake sine-wave audio for %d seconds", duration)
        audio_bytes = _sine_wave_pcm(duration, DEFAULT_SAMPLE_RATE, FAKE_AUDIO_FREQUENCY)
        header = _wrap_pcm_as_wav(audio_bytes)
        return header, "audio/wav"

    def _write_audio(self, feed_url: str, audio_bytes: bytes, mime_type: str) -> Path:
        ext = self._extension_for_mime(mime_type)
        filename_hash = hashlib.sha256(feed_url.encode("utf-8")).hexdigest()[:16]
        filename = f"podcast_{filename_hash}{ext}"
        path = self.output_dir / filename
        with open(path, "wb") as handle:
            handle.write(audio_bytes)
        return path

    @staticmethod
    def _extension_for_mime(mime_type: str) -> str:
        mapping = {
            "audio/wav": ".wav",
            "audio/x-wav": ".wav",
            "audio/mpeg": ".mp3",
            "audio/mp3": ".mp3",
            "audio/flac": ".flac",
            "audio/ogg": ".ogg",
        }
        return mapping.get(mime_type.lower(), ".mp3")

    def _save_digest_meta(self, job: AudioJob) -> None:
        try:
            meta = {
                "date_utc": time.strftime("%Y-%m-%d", time.gmtime()),
                "audio_filename": job.audio_path.name if job.audio_path else None,
                "audio_mime_type": job.audio_mime_type,
                "transcript": job.transcript,
            }
            DIGEST_META_PATH.write_text(json.dumps(meta))
            LOGGER.info("Digest metadata saved for %s", meta["date_utc"])
        except Exception:
            LOGGER.warning("Failed to save digest metadata", exc_info=True)

    def _load_cached_digest_job(self) -> Optional[AudioJob]:
        try:
            if not DIGEST_META_PATH.exists():
                return None
            meta = json.loads(DIGEST_META_PATH.read_text())
            if meta.get("date_utc") != time.strftime("%Y-%m-%d", time.gmtime()):
                LOGGER.info("Cached digest is from a previous day — will regenerate")
                return None
            audio_filename = meta.get("audio_filename")
            if not audio_filename:
                return None
            audio_path = self.output_dir / audio_filename
            if not audio_path.exists():
                LOGGER.info("Cached digest audio file missing — will regenerate")
                return None
            job = AudioJob(
                feed_url=DIGEST_FEED_URL,
                channel_title="Daily Digest",
                content_hash="",
                articles=[],
            )
            job.status = "ready"
            job.audio_path = audio_path
            job.audio_url = f"/static/podcasts/{audio_filename}"
            job.audio_mime_type = meta.get("audio_mime_type")
            job.transcript = meta.get("transcript")
            LOGGER.info("Restored digest from local cache (date: %s)", meta["date_utc"])
            return job
        except Exception:
            LOGGER.warning("Failed to load digest metadata", exc_info=True)
            return None

    async def ensure_digest_audio(self, sections: List[Tuple[str, str, List[Dict[str, str]]]]) -> AudioJob:
        """sections: list of (section_name, feed_url, articles)"""
        async with self._jobs_lock:
            cached = self._load_cached_digest_job()
            if cached:
                self._jobs[DIGEST_FEED_URL] = cached
                return cached

        all_articles = [article for _, _, articles in sections for article in articles]
        content_hash = _articles_digest(all_articles)
        section_data: List[Tuple[str, List[Dict[str, str]]]] = [(name, articles) for name, _, articles in sections]
        async with self._jobs_lock:
            job = self._jobs.get(DIGEST_FEED_URL)
            if job and job.content_hash == content_hash:
                if job.status in {"pending", "generating"} and job.task and not job.task.done():
                    return job
                if job.status == "ready" and job.audio_path and job.audio_path.exists():
                    return job
                if job.status == "error":
                    LOGGER.info("Retrying digest audio generation")
            elif job and job.content_hash != content_hash:
                if job.task and not job.task.done():
                    job.task.cancel()
            job = AudioJob(
                feed_url=DIGEST_FEED_URL,
                channel_title="Daily Digest",
                content_hash=content_hash,
                articles=all_articles,
                sections=section_data,
            )
            job.task = asyncio.create_task(self._run_job(job))
            self._jobs[DIGEST_FEED_URL] = job
            return job

    async def get_status(self, feed_url: str) -> Dict[str, Optional[str]]:
        async with self._jobs_lock:
            job = self._jobs.get(feed_url)
            if not job:
                return {
                    "feed": feed_url,
                    "status": "missing",
                    "audio_url": None,
                    "mime_type": None,
                    "transcript": None,
                    "error": None,
                    "updated_at": None,
                }
            if job.status == "ready" and job.audio_path and not job.audio_path.exists():
                job.status = "pending"
                job.audio_path = None
                job.audio_url = None
                job.audio_mime_type = None
                job.task = asyncio.create_task(self._run_job(job))
            return job.to_dict()

    async def list_statuses(self) -> List[Dict[str, Optional[str]]]:
        async with self._jobs_lock:
            return [job.to_dict() for job in self._jobs.values()]


audio_manager = AudioPodcastManager()


async def ensure_audio_for_feed(feed_url: str, channel_title: str, articles: List[Dict[str, str]]) -> Dict[str, Optional[str]]:
    job = await audio_manager.ensure_audio(feed_url, channel_title, articles)
    return job.to_dict()


async def get_audio_status(feed_url: str) -> Dict[str, Optional[str]]:
    return await audio_manager.get_status(feed_url)


async def get_all_audio_statuses() -> List[Dict[str, Optional[str]]]:
    return await audio_manager.list_statuses()


async def ensure_digest_audio_for_feeds(sections: List[Tuple[str, str, List[Dict[str, str]]]]) -> Dict[str, Optional[str]]:
    job = await audio_manager.ensure_digest_audio(sections)
    return job.to_dict()
