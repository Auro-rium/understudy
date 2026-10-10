#!/usr/bin/env bash
# CPU training of the SAME 4-bit model the Mac serves (mlx-community/gemma-4-e4b-it-4bit) with the SAME
# mlx_lm.lora command and settings as the local rounds, on the biggest CPU box the Standard quota allows
# (r7i.2xlarge: 8 vCPU, 64 GB). MLX has a Linux CPU backend, so the adapter comes out directly in MLX format
# (no PEFT conversion, no gated model, no HF token). ALWAYS terminates the instance.
#   benchmark: bash scripts/aws_launch_cpu.sh --iters 10
#   real run : bash scripts/aws_launch_cpu.sh --iters 600
# Env: MAX_MINUTES (self-shutdown timer, default 60), INSTANCE_TYPE, AWS_REGION.
set -uo pipefail
cd "$(dirname "$0")/.."
aws() { command aws --cli-read-timeout 30 --cli-connect-timeout 10 "$@"; }
REGION="${AWS_REGION:-us-east-1}"; ITYPE="${INSTANCE_TYPE:-r7i.2xlarge}"; MAXMIN="${MAX_MINUTES:-60}"
MODEL="mlx-community/gemma-4-e4b-it-4bit"
NAME="understudy-cpu-$(date +%s)"; OUT="aws_out/$NAME"; mkdir -p "$OUT"
[[ -f aws_chatdata/data/train.jsonl ]] || PYTHONPATH=. backend/.venv/bin/python scripts/make_chat_data.py aws_chatdata

q="$(aws service-quotas get-service-quota --region "$REGION" --service-code ec2 --quota-code L-1216C47A --query Quota.Value --output text)"
awk "BEGIN{exit !($q >= 8)}" || { echo "Standard vCPU quota is $q (<8): nothing launched."; exit 1; }
n="$(aws ec2 describe-instances --region "$REGION" --filters Name=instance-state-name,Values=pending,running --query 'length(Reservations[].Instances[])' --output text)"
[[ "$n" == "0" ]] || { echo "$n instance(s) already running in $REGION: refusing (quota / double-billing)."; exit 1; }

IID=""; SG=""
cleanup() { [[ -n "$IID" ]] && { echo "terminating $IID"; aws ec2 terminate-instances --region "$REGION" --instance-ids "$IID" >/dev/null; }
            aws ec2 delete-key-pair --region "$REGION" --key-name "$NAME" >/dev/null 2>&1
            [[ -n "$SG" ]] && { sleep 60; aws ec2 delete-security-group --region "$REGION" --group-id "$SG" >/dev/null 2>&1; }; }
trap cleanup EXIT

AMI="$(aws ssm get-parameter --region "$REGION" --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 --query Parameter.Value --output text)"
MYIP="$(curl -s https://checkip.amazonaws.com)"
aws ec2 create-key-pair --region "$REGION" --key-name "$NAME" --query KeyMaterial --output text > "$OUT/key.pem"; chmod 600 "$OUT/key.pem"
SG="$(aws ec2 create-security-group --region "$REGION" --group-name "$NAME" --description understudy-cpu --query GroupId --output text)"
aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG" --protocol tcp --port 22 --cidr "$MYIP/32" >/dev/null

IID="$(aws ec2 run-instances --region "$REGION" --image-id "$AMI" --instance-type "$ITYPE" --key-name "$NAME" \
  --security-group-ids "$SG" --instance-initiated-shutdown-behavior terminate \
  --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=40,VolumeType=gp3,DeleteOnTermination=true}' \
  --user-data "#!/bin/bash
shutdown -P +$MAXMIN" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" --query 'Instances[0].InstanceId' --output text)"
echo "launched $IID ($ITYPE), self-shutdown in ${MAXMIN} min"
aws ec2 wait instance-running --region "$REGION" --instance-ids "$IID"
HOST="$(aws ec2 describe-instances --region "$REGION" --instance-ids "$IID" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"
SSH="ssh -i $OUT/key.pem -o StrictHostKeyChecking=no -o ConnectTimeout=10 ec2-user@$HOST"
for i in $(seq 1 30); do $SSH true 2>/dev/null && break; sleep 10; done

scp -r -i "$OUT/key.pem" -o StrictHostKeyChecking=no aws_chatdata/data "ec2-user@$HOST:~/chatdata"
# Same flags as training/mlx_local.py (mask-prompt, rank-8 default LoRA on the last 8 layers, lr 1e-4, bs 1, seq 512)
$SSH "nproc; free -g | sed -n 2p; lscpu | grep -E 'Model name|amx_bf16' | cut -c1-90 | head -2
sudo dnf install -y -q python3.11 python3.11-pip >/dev/null && python3.11 -m venv ~/mv && . ~/mv/bin/activate && python -m pip install -q 'mlx[cpu]' mlx-lm && \
python -c 'import mlx.core as mx; print(\"mlx device:\", mx.default_device())' && \
mkdir -p out && python -m mlx_lm.lora --train --model $MODEL --data ~/chatdata --adapter-path ~/out/adapters \
  --batch-size 1 --num-layers 8 --max-seq-length 512 --learning-rate 1e-4 --grad-checkpoint --mask-prompt \
  --steps-per-report 1 --steps-per-eval 100000 --save-every 100000 $*" 2>&1 | tee "$OUT/train.log"
scp -r -i "$OUT/key.pem" -o StrictHostKeyChecking=no "ec2-user@$HOST:~/out" "$OUT/" 2>&1 | tail -1
echo "adapter (MLX format) in $OUT/out/adapters; raw log in $OUT/train.log"
