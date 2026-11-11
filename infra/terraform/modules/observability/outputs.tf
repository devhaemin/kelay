output "alarm_topic_arn" {
  value = aws_sns_topic.alarms.arn
}

output "clickhouse_service_id" {
  value = try(clickhouse_service.telemetry[0].id, null)
}

output "clickhouse_endpoints" {
  description = "Connection endpoints of the telemetry service; null when ClickHouse is disabled."
  value       = try(clickhouse_service.telemetry[0].endpoints, null)
}
