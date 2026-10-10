#!/usr/bin/env bash
# Watch AWS GPU quota approval for Understudy training. Exits 0 as soon as ANY watched quota is >= 1.
# Usage: scripts/watch_quota.sh [interval_seconds]   (default 60)
# Run in background:  nohup scripts/watch_quota.sh > logs/quota.log 2>&1 &
set -uo pipefail
INTERVAL="${1:-60}"
REGION="${AWS_REGION:-us-east-1}"

# "service-code quota-code label"
WATCH=(
  "ec2 L-DB2E81BA ec2-on-demand-G-and-VT-vCPUs"
)

notify() {
  echo "$1"
  osascript -e "display notification \"$1\" with title \"Understudy AWS quota\"" 2>/dev/null || true
}

while true; do
  ts="$(date '+%H:%M:%S')"
  line="[$ts]"
  for w in "${WATCH[@]}"; do
    read -r svc code label <<<"$w"
    val="$(aws service-quotas get-service-quota --region "$REGION" --service-code "$svc" \
            --quota-code "$code" --query 'Quota.Value' --output text 2>/dev/null || echo ERR)"
    status="$(aws service-quotas list-requested-service-quota-change-history-by-quota --region "$REGION" \
            --service-code "$svc" --quota-code "$code" \
            --query 'RequestedQuotas[0].Status' --output text 2>/dev/null || echo none)"
    line="$line $label=${val}(${status})"
    # approved when the applied value is >= 1 (compare as float)
    if [[ "$val" != "ERR" ]] && awk "BEGIN{exit !($val >= 1)}"; then
      echo "$line"
      notify "APPROVED: $label now $val - AWS training can start"
      exit 0
    fi
    # surface denials/closed cases so we don't wait forever
    if [[ "$status" == "DENIED" || "$status" == "NOT_APPROVED" || "$status" == "INVALID_REQUEST" ]]; then
      notify "$label request $status - check the AWS Support case"
    fi
  done
  echo "$line"
  sleep "$INTERVAL"
done
