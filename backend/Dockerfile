# Build from the repository root: docker build -f backend/Dockerfile -t aquasentinal-backend .
# The backend reads shared/geometry.json and shared/perception.json, so the context is the repo root.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY shared shared
COPY backend backend
WORKDIR /app/backend
ENV APP_MODE=SIMULATION AQUA_HARDWARE_ENABLE=false AQUA_DATA_DIR=/data DATABASE_URL=sqlite:////data/aquasentinal.db
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
