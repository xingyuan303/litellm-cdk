# Pin a specific release (or a @sha256 digest) for true reproducibility in production.
FROM ghcr.io/berriai/litellm:main-stable
WORKDIR /app
COPY config.yaml /app/config.yaml
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
USER root
RUN chmod +x /app/docker-entrypoint.sh
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:4000/health/readiness || exit 1
ENTRYPOINT ["/app/docker-entrypoint.sh"]
