# Telemetry collector image for ECS: the upstream OpenTelemetry Collector (contrib) with Kelay's
# pipelines baked in. Build: docker build -t <ecr>/kelay-<env>/otel-collector:<tag> infra/otel
#
# The image starts with config.yaml (export to ClickHouse). An env without ClickHouse runs it with
# `--config=/etc/otelcol-contrib/debug.yaml` instead, which Terraform sets as the task's command.
FROM otel/opentelemetry-collector-contrib:0.165.0

COPY config.yaml /etc/otelcol-contrib/config.yaml
COPY debug.yaml /etc/otelcol-contrib/debug.yaml

EXPOSE 4318 13133
