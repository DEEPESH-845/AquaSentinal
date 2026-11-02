# Build from the repository root: docker build -f backend/Dockerfile -t aquasentinal-backend .
# The backend reads shared/geometry.json and shared/perception.json, so the context is the repo root (.dockerignore keeps it small).
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
# libglib is the one shared library opencv-python-headless needs on slim
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install -r backend/requirements.txt
COPY shared shared
COPY backend/app backend/app

# Unprivileged runtime user; /data holds the SQLite file and stored frames (ephemeral unless a volume is mounted)
RUN useradd --create-home --uid 10001 app && mkdir -p /data && chown app /data
USER app
WORKDIR /app/backend
ENV APP_MODE=SIMULATION AQUA_HARDWARE_ENABLE=false AQUA_DATA_DIR=/data DATABASE_URL=sqlite:////data/aquasentinal.db PORT=8000
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD python -c "import os, urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"PORT\"]}/api/health', timeout=4)" || exit 1

# Hosts such as Render set PORT; TLS ends at their proxy, so trust its forwarded headers.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
