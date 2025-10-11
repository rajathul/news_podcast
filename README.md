# News Podcast

A tiny web app that fetches news (via RSS), generates podcast audio files, and serves them. The repository includes a small FastAPI app (`rss_viewer.py`), an audio backend script (`audio_podcast_backend.py`), static assets and generated podcasts.

## Project layout

- `rss_viewer.py` - FastAPI application that serves the RSS/news endpoints and web UI.
- `audio_podcast_backend.py` - Script that generates podcast audio (used to produce `.mp3`/`.wav` files).
- `static/` - Frontend assets (JS/CSS) and `podcasts/` with generated audio files.
- `templates/` - HTML templates (includes `index.html`).
- `requirements.txt` - Python dependencies for running locally.
- `Dockerfile` - Container image definition for running the app in Docker.

## Two ways to run

Choose one of the two recommended ways below.

1) Easiest (Docker)

Prerequisites:
- Docker installed on your machine. See https://docs.docker.com/get-docker/ for instructions.

Run the pre-built image from Docker Hub:

```
docker pull athulraj99/news_podcast:latest
docker run --rm -p 8000:8000 athulraj99/news_podcast:latest
```

Then open your browser to http://localhost:8000 to view the web UI.

2) Local Python environment

Prerequisites:
- Python 3.10+ (or the version used by the project)
- pip

Steps:

```
# create a virtual environment (optional but recommended)
python -m venv .venv
source .venv/bin/activate

# install dependencies
pip install -r requirements.txt

# run the FastAPI app with uvicorn (auto-reload)
uvicorn rss_viewer:app --reload
```

The app will listen on http://127.0.0.1:8000 by default. Open that URL in your browser.

## Troubleshooting

- If you get import errors, make sure the virtual environment is activated and `pip install -r requirements.txt` completed without errors.
- If port 8000 is already in use, pass `--port` to `uvicorn` or change the `docker run -p` mapping.
- If you run into audio generation issues, check `static/podcasts/` for produced files and review the logs printed by `audio_podcast_backend.py`.

## Notes

- This README provides quick start instructions only. For development or deployment tweaks (SSL, reverse proxy, CI), adapt the Dockerfile and run commands accordingly.
