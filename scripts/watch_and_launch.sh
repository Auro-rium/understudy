#!/usr/bin/env bash
# Poll the EC2 GPU quota; when approved (>= 8 vCPUs) run the training launcher and notify.
# Needs HF_TOKEN in the env or in .env (gated Gemma model). If the quota is approved but there is no token,
# it notifies once and keeps waiting for the token. Runs the launcher AT MOST ONCE (lock file).
# Usage: nohup scripts/watch_and_launch.sh [interval_s] > logs/watch_and_launch.log 2>&1 &
# Stop:  pkill -f watch_and_launch.sh
set -uo pipefail
cd "$(dirname "$0")/.."
INTERVAL="${1:-120}"; REGION="${AWS_REGION:-us-east-1}"; LOCK="logs/.launched"
aws() { command aws --cli-read-timeout 20 --cli-connect-timeout 10 "$@"; }

notify() {
  echo "[$(date '+%H:%M:%S')] $1"
  osascript -e "display notification \"$1\" with title \"Understudy AWS\"" 2>/dev/null || true
}
hf_token() {  # env first, then .env
  if [[ -n "${HF_TOKEN:-}" ]]; then echo "$HF_TOKEN"; return; fi
  grep -E '^HF_TOKEN=.+' .env 2>/dev/null | head -1 | cut -d= -f2-
}

[[ -e "$LOCK" ]] && { echo "already launched once ($LOCK exists); delete it to allow another run"; exit 0; }
REGIONS="${REGIONS:-us-east-1 us-west-2 us-east-2 ap-south-1}"   # watch several regions, launch in the first approved one
warned_token=0; last=""; denied=" "
while true; do
  alive=0; snap=""
  for REGION in $REGIONS; do
    [[ "$denied" == *" $REGION "* ]] && continue
    alive=1
    val="$(aws service-quotas get-service-quota --region "$REGION" --service-code ec2 --quota-code L-DB2E81BA \
            --query Quota.Value --output text 2>/dev/null || echo ERR)"
    status="$(aws service-quotas list-requested-service-quota-change-history-by-quota --region "$REGION" \
            --service-code ec2 --quota-code L-DB2E81BA --query 'RequestedQuotas[0].Status' --output text 2>/dev/null || echo ?)"
    now="$REGION quota=$val request=$status"
    snap="$snap| $now "
    case "$status" in DENIED|NOT_APPROVED|INVALID_REQUEST) notify "$REGION GPU quota request $status"; denied="$denied$REGION "; continue;; esac
    if [[ "$val" != "ERR" ]] && awk "BEGIN{exit !($val >= 8)}"; then
      tok="$(hf_token)"
      if [[ -z "$tok" ]]; then
        [[ $warned_token -eq 0 ]] && { notify "GPU quota APPROVED in $REGION but HF_TOKEN missing: add HF_TOKEN=... to .env"; warned_token=1; }
      else
        notify "GPU quota APPROVED in $REGION: launching training"
        touch "$LOCK"
        AWS_REGION="$REGION" HF_TOKEN="$tok" bash scripts/aws_launch_ec2.sh --epochs 3 > logs/aws_launch.log 2>&1
        rc=$?
        if [[ $rc -eq 0 ]]; then notify "AWS training finished: results in aws_out/ (see logs/aws_launch.log)"
        else notify "AWS training FAILED (exit $rc): see logs/aws_launch.log; instance terminated by trap"; fi
        exit $rc
      fi
    fi
  done
  [[ "$snap" != "$last" ]] && { echo "[$(date '+%H:%M:%S')] $snap"; last="$snap"; }
  [[ $alive -eq 0 ]] && { notify "all watched regions denied: open an AWS Support case"; exit 2; }
  sleep "$INTERVAL"
done
