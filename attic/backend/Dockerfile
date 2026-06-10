# Backend Dockerfile for Fly.io
# Includes: Python 3.11, Foundry (anvil), FastAPI server.
#
# The image is intentionally a Debian slim base so that the foundry installer
# script works (it expects libc + curl + git).

FROM python:3.11-slim

# System deps for Foundry + Python crypto deps
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        ca-certificates \
        git \
        build-essential \
        libssl-dev \
        libffi-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Foundry (provides `anvil`)
ENV FOUNDRY_DIR=/root/.foundry
ENV PATH="${FOUNDRY_DIR}/bin:${PATH}"
RUN curl -L https://foundry.paradigm.xyz | bash \
    && ${FOUNDRY_DIR}/bin/foundryup
RUN anvil --version

# Python deps
WORKDIR /app
COPY requirements_api.txt .
RUN pip install --no-cache-dir -r requirements_api.txt

# App code
COPY . .

# FastAPI server (Fly.io defaults to PORT=8080, but we honour both)
EXPOSE 8080
ENV PORT=8080
CMD ["sh", "-c", "uvicorn api.main:app --host 0.0.0.0 --port ${PORT}"]
