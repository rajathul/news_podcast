# AudioTorial

**Live:** https://www.audiotorial.in

A daily news podcast generator. Pulls from NYT World News, Financial Times Markets, BBC Sports, and Variety Entertainment, generates a conversational podcast script with two AI anchors (Liam & Anya) using Gemini, synthesises it to audio with multi-speaker TTS, and serves everything through a clean web UI.

The podcast is cached daily in Supabase Storage — repeat visitors within the same calendar day (or within 4 hours across midnight) get the cached version instantly.

## How it works

```
RSS feeds (4 sources)
        │
        ▼
Top 10 articles per section → Gemini 2.5 Flash (script)
        │
        ▼
Multi-speaker TTS → Gemini 2.5 Flash TTS (Liam + Anya voices)
        │
        ▼
Uploaded to Supabase Storage → served to audio player
```

## Project layout

```
rss_viewer.py           FastAPI app — RSS parsing, API endpoints, digest route
audio_podcast_backend.py  Podcast generation — Gemini transcript + TTS, async job queue, Supabase cache
storage.py              Supabase Storage wrapper — upload/download audio and metadata
static/                 Frontend (vanilla JS, CSS)
templates/              HTML templates
requirements.txt        Python dependencies
Dockerfile              Container image
```

## Environment variables

Copy `.env.example` to `.env` and fill in your values:

```
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | Yes | Google Gemini API key — get one at [aistudio.google.com](https://aistudio.google.com/app/apikey) |
| `SUPABASE_URL` | Yes | Your Supabase project URL (`https://xxxx.supabase.co`) |
| `SUPABASE_KEY` | Yes | Supabase `service_role` key — found in Project Settings → API |
| `PODCAST_FAKE_AUDIO` | No | Set to `1` to skip TTS (transcript still generated). Useful for dev. |

**Supabase setup:** Create a free project at [supabase.com](https://supabase.com), go to Storage, and create a public bucket named `podcasts`.

## Running locally

**Option 1 — Docker (easiest):**

```bash
docker pull athulraj99/news_podcast:latest
docker run --rm -p 8000:8000 --env-file .env athulraj99/news_podcast:latest
```

**Option 2 — Python:**

```bash
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn rss_viewer:app --reload
```

Open http://localhost:8000 in your browser.

## Deployment

The GitHub Actions workflow (`.github/workflows/docker.yml`) builds and pushes a `latest` Docker image to both GHCR and Docker Hub on every push to `main`.

To deploy on GCP Cloud Run:
1. Set `GEMINI_API_KEY`, `SUPABASE_URL`, and `SUPABASE_KEY` as environment variables in the Cloud Run service
2. Point the service to the new `latest` image and deploy — same URL, zero downtime
