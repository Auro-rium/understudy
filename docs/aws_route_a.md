# AWS GPU training, Route A (single EC2 instance)

**Status: blocked.** Quota is approved for SageMaker `ml.g5.xlarge/2xlarge` training, but EC2 G/VT vCPUs is
still 0 (request for 8 pending) and an Organizations SCP denies EC2/SageMaker/S3-write/SSM for account
436847501987. `scripts/aws_preflight.sh` prints exactly what is still blocked.

## Message for the organization admin
> Account 436847501987 (user `Understudy`) is blocked by SCP `p-e6tm3tr2` (org `o-2q6uo4af0g`, management
> account 280517746939) from EC2, SSM and S3 writes. Please exempt this account or allow, in us-east-1:
> ec2: RunInstances, TerminateInstances, Describe{Instances,InstanceTypeOfferings,InstanceStatus,Images,Subnets,Vpcs,SecurityGroups},
> CreateSecurityGroup, AuthorizeSecurityGroupIngress, DeleteSecurityGroup, CreateKeyPair, DeleteKeyPair, CreateTags;
> ssm: GetParameter; s3: CreateBucket, PutObject, GetObject, ListBucket (optional with the scp/ssh flow).
> Also: which regions / instance types does the SCP permit?

## Run (once preflight says ALL CLEAR)
```bash
bash scripts/aws_preflight.sh            # must end with ALL CLEAR
HF_TOKEN=hf_... bash scripts/aws_launch_ec2.sh --epochs 3
```
Needs: Hugging Face account with the `google/gemma-4-E4B-it` license accepted (gated model).
The launcher ships `data/train.jsonl`, `data/val.jsonl` and `training/aws_qlora_train.py` over scp, trains,
copies `out/` back, and always terminates the instance (trap + self-shutdown + 90-minute timer).

## Then
1. `scripts/spike_peft_to_mlx.py aws_out/<run>/out/adapter adapters/aws_round --num-total-layers 42`
   (verified only on a synthetic adapter).
2. Score on the 200 test tickets with the same runner as the local rounds, so the numbers compare directly.

## Settings (proposed, untested on a GPU)
QLoRA nf4, rank 16, alpha 32, dropout 0.05, all attention+MLP in the language model, lr 2e-4 cosine, 5% warmup,
effective batch 16 (8 x 2), 3 epochs (~225 steps), max length 320, loss on the answer tokens only.
Data: 1,200 train tickets, mean 166 / p95 211 / max 268 tokens, answer = 3 tokens (`scripts/token_stats.py`).
