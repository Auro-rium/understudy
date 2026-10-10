#!/usr/bin/env bash
# Preflight for the EC2 GPU training route. Read-only / --dry-run only: creates and launches NOTHING.
# Prints OK/BLOCKED per requirement; exit 0 only when everything needed is allowed.
# Usage: scripts/aws_preflight.sh [region]   (default us-east-1)
set -uo pipefail
REGION="${1:-${AWS_REGION:-us-east-1}}"
ITYPE="${INSTANCE_TYPE:-g5.2xlarge}"
USER_ARN="$(aws sts get-caller-identity --query Arn --output text)"
fail=0

check() {  # check "label" cmd...   OK if exit 0, or if a --dry-run call answers DryRunOperation
  local label="$1"; shift
  local out
  out="$("$@" 2>&1)"; local rc=$?
  if [[ $rc -eq 0 || "$out" == *DryRunOperation* ]]; then
    echo "OK       $label"
  else
    fail=1
    local why="denied"
    [[ "$out" == *"service control policy"* ]] && why="BLOCKED BY SCP"
    [[ "$out" != *"not authorized"* && "$out" != *"explicit deny"* ]] && why="error: $(echo "$out" | head -c 90 | tr '\n' ' ')"
    echo "BLOCKED  $label  [$why]"
  fi
}

echo "principal: $USER_ARN   region: $REGION   instance: $ITYPE"
check "GPU quota (EC2 G/VT vCPUs >= 8)" bash -c \
  "v=\$(aws service-quotas get-service-quota --service-code ec2 --quota-code L-DB2E81BA --region $REGION --query Quota.Value --output text); awk \"BEGIN{exit !(\$v>=8)}\""
check "ec2:DescribeInstances"            aws ec2 describe-instances --region "$REGION" --max-items 1
check "ec2:DescribeInstanceTypeOfferings" aws ec2 describe-instance-type-offerings --region "$REGION" --filters "Name=instance-type,Values=$ITYPE" --max-items 1
check "ec2:DescribeImages"               aws ec2 describe-images --region "$REGION" --owners amazon --max-items 1
check "ec2:DescribeVpcs"                 aws ec2 describe-vpcs --region "$REGION" --max-items 1
check "ec2:CreateKeyPair (dry-run)"      aws ec2 create-key-pair --region "$REGION" --key-name understudy-preflight --dry-run
check "ec2:CreateSecurityGroup (dry-run)" aws ec2 create-security-group --region "$REGION" --group-name understudy-preflight --description x --dry-run
check "ssm:GetParameter (GPU AMI lookup)" aws ssm get-parameter --region "$REGION" --name /aws/service/deeplearning/ami/x86_64/base-oss-nvidia-driver-gpu-ubuntu-22.04/latest/ami-id
AMI="$(aws ssm get-parameter --region "$REGION" --name /aws/service/deeplearning/ami/x86_64/base-oss-nvidia-driver-gpu-ubuntu-22.04/latest/ami-id --query Parameter.Value --output text 2>/dev/null || true)"
if [[ "$AMI" == ami-* ]]; then
  check "ec2:RunInstances $ITYPE (dry-run)" aws ec2 run-instances --region "$REGION" --instance-type "$ITYPE" --image-id "$AMI" --count 1 --dry-run
else
  fail=1; echo "BLOCKED  ec2:RunInstances (dry-run)  [needs the AMI lookup above to pass]"
fi
check "s3:ListAllMyBuckets"              aws s3api list-buckets
# policy-simulator for actions that have no dry-run (SCP denies show up as explicitDeny)
for act in s3:CreateBucket s3:PutObject s3:GetObject ssm:SendCommand ssm:StartSession iam:PassRole iam:CreateInstanceProfile ec2:TerminateInstances; do
  d="$(aws iam simulate-principal-policy --policy-source-arn "$USER_ARN" --action-names "$act" --query 'EvaluationResults[0].EvalDecision' --output text 2>&1)"
  if [[ "$d" == "allowed" ]]; then echo "OK       $act (simulated)"; else fail=1; echo "BLOCKED  $act (simulated: $d)"; fi
done

if [[ $fail -eq 0 ]]; then echo "ALL CLEAR: EC2 training route is open."; else echo "NOT READY: ask the org admin to lift SCP p-e6tm3tr2 (see docs/aws_route_a.md)."; fi
exit $fail
