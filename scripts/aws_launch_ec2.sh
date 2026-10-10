#!/usr/bin/env bash
# Route A: train the QLoRA adapter on one EC2 GPU instance, copy results back, ALWAYS terminate.
# Refuses to run unless scripts/aws_preflight.sh passes. Needs HF_TOKEN (gated gemma model) in the env.
# Usage: HF_TOKEN=... scripts/aws_launch_ec2.sh [--epochs 3]
# Cost guard: instance self-terminates on shutdown, a 90-min timer powers it off, and a trap terminates on exit.
set -uo pipefail
cd "$(dirname "$0")/.."
REGION="${AWS_REGION:-us-east-1}"; ITYPE="${INSTANCE_TYPE:-g5.2xlarge}"; NAME="understudy-train-$(date +%s)"
OUT="aws_out/$NAME"; mkdir -p "$OUT"
: "${HF_TOKEN:?set HF_TOKEN (accept the google/gemma-4-E4B-it license on huggingface.co first)}"

bash scripts/aws_preflight.sh "$REGION" || { echo "Preflight failed: nothing launched."; exit 1; }

IID=""
cleanup() { [[ -n "$IID" ]] && { echo "terminating $IID"; aws ec2 terminate-instances --region "$REGION" --instance-ids "$IID" >/dev/null; }
            aws ec2 delete-key-pair --region "$REGION" --key-name "$NAME" >/dev/null 2>&1
            [[ -n "${SG:-}" ]] && { sleep 45; aws ec2 delete-security-group --region "$REGION" --group-id "$SG" >/dev/null 2>&1; }; }
trap cleanup EXIT

AMI="$(aws ssm get-parameter --region "$REGION" --name /aws/service/deeplearning/ami/x86_64/base-oss-nvidia-driver-gpu-ubuntu-22.04/latest/ami-id --query Parameter.Value --output text)"
MYIP="$(curl -s https://checkip.amazonaws.com)"
aws ec2 create-key-pair --region "$REGION" --key-name "$NAME" --query KeyMaterial --output text > "$OUT/key.pem"; chmod 600 "$OUT/key.pem"
SG="$(aws ec2 create-security-group --region "$REGION" --group-name "$NAME" --description understudy-train --query GroupId --output text)"
aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG" --protocol tcp --port 22 --cidr "$MYIP/32" >/dev/null

IID="$(aws ec2 run-instances --region "$REGION" --image-id "$AMI" --instance-type "$ITYPE" --key-name "$NAME" \
  --security-group-ids "$SG" --instance-initiated-shutdown-behavior terminate \
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=100,VolumeType=gp3}' \
  --user-data '#!/bin/bash
shutdown -P +90' \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" --query 'Instances[0].InstanceId' --output text)"
echo "launched $IID ($ITYPE)"
aws ec2 wait instance-running --region "$REGION" --instance-ids "$IID"
HOST="$(aws ec2 describe-instances --region "$REGION" --instance-ids "$IID" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"
SSH="ssh -i $OUT/key.pem -o StrictHostKeyChecking=no -o ConnectTimeout=10 ubuntu@$HOST"
for i in $(seq 1 30); do $SSH true 2>/dev/null && break; sleep 10; done

scp -i "$OUT/key.pem" -o StrictHostKeyChecking=no data/train.jsonl data/val.jsonl training/aws_qlora_train.py "ubuntu@$HOST:~/"
$SSH "pip install -q -U transformers peft bitsandbytes accelerate && HF_TOKEN=$HF_TOKEN python aws_qlora_train.py --train train.jsonl --val val.jsonl --out out ${*:-}" 2>&1 | tee "$OUT/train.log"
scp -r -i "$OUT/key.pem" -o StrictHostKeyChecking=no "ubuntu@$HOST:~/out" "$OUT/"
echo "results in $OUT/out (adapter/, loss_curve.json, train_meta.json). Next: scripts/spike_peft_to_mlx.py then score on the test set."
