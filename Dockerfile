FROM python:3.11-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt .
RUN python -m pip install --no-cache-dir --upgrade pip && pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

CMD exec uvicorn rss_viewer:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips="*"
