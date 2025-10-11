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
from typing import Dict, Iterable, List, Optional
from google import genai
from google.genai import types


LOGGER = logging.getLogger("audio_podcast_backend")

TRANSCRIPT_MODEL = "gemini-2.0-flash"
TTS_MODEL = "gemini-2.5-flash-preview-tts"
OUTPUT_DIR = Path("static/podcasts")
MAX_PROMPT_ARTICLES = 8
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


def _articles_prompt_snippet(articles: List[Dict[str, str]]) -> str:
    lines = []
    for idx, article in enumerate(articles[:MAX_PROMPT_ARTICLES], start=1):
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
        if self._using_fake_audio():
            raise RuntimeError("Client guard should not be used when fake audio is enabled.")
        if self._client is None:
            if genai is None:
                raise RuntimeError("google-genai package not available; disable PODCAST_FAKE_AUDIO or install dependency.")
            self._client = genai.Client()
        return self._client

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
            LOGGER.info(
                "Starting %s audio generation for feed %s",
                "fake" if fake_audio_mode else "Gemini",
                job.feed_url,
            )
            if fake_audio_mode:
                transcript = self._generate_dummy_transcript(job.channel_title, job.articles)
                job.transcript = transcript
                audio_bytes, mime_type = self._generate_dummy_audio(transcript)
            else:
                transcript = await asyncio.to_thread(self._generate_transcript, job.channel_title, job.articles)
                job.transcript = transcript
                audio_bytes, mime_type = await asyncio.to_thread(self._synthesise_audio, transcript)
            audio_bytes, mime_type = await asyncio.to_thread(_normalise_audio_bytes, audio_bytes, mime_type)
            audio_path = self._write_audio(job.feed_url, audio_bytes, mime_type)
            job.audio_path = audio_path
            job.audio_url = f"/static/podcasts/{audio_path.name}"
            job.audio_mime_type = mime_type
            job.status = "ready"
            job.updated_at = time.time()
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
