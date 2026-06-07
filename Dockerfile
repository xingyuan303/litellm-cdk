# Pin a specific release (or a @sha256 digest) for true reproducibility in production.
FROM ghcr.io/berriai/litellm:main-stable
WORKDIR /app

# Bake the Bedrock geography prefix into config at build time (us|eu|jp|au|global).
ARG BEDROCK_GEO=us
COPY config.yaml /app/config.yaml
RUN sed -i "s/__BEDROCK_GEO__/${BEDROCK_GEO}/g" /app/config.yaml

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://localhost:4000/health/readiness')" || exit 1

# Use the image's built-in entrypoint (handles Prisma client / DB migration); pass args via CMD.
CMD ["--port", "4000", "--config", "/app/config.yaml", "--num_workers", "1"]
