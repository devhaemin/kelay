# LLM gateway image for ECS: the pinned LiteLLM proxy with Kelay's model config baked in.
# Build: docker build -t <ecr>/kelay-<env>/llm-gateway:<tag> infra/litellm
FROM ghcr.io/berriai/litellm:v1.106.6

COPY config.yaml /app/config.yaml

EXPOSE 4000
CMD ["--config", "/app/config.yaml", "--port", "4000"]
