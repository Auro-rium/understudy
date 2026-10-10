# Nebius Token Factory fine-tuning (training/nebius.py)

Researched 2026-10-10 from the official docs and `openapi.json` (sources at the bottom). Statements
marked **[observed]** come from read-only GETs against our own account; **[unverified]** means it needs a real
job to confirm (we never create one without the user's go).

## 1. The critical question: Gemma 4 E4B

* `google/gemma-4-E4B-it` (also E2B-it and 31B-it) IS on the Nebius fine-tuning model list, but the list
  says **"Full fine-tuning" only. No LoRA** for any Gemma 4 model. Gemma 3 is NOT on the fine-tuning list
  (only `google/gemma-3-27b-it` exists, as an inference model **[observed]** in `GET /v1/models`).
* Bringing our own HF base: `model` must be a name Nebius supports; the supported name for Gemma 4 E4B is
  literally the HF repo id, so `NEBIUS_FT_MODEL=google/gemma-4-E4B-it` already *is* "get the model from HF".
  Nebius pulls the weights itself (no HF token needed for that). The job schema also has an undocumented
  `from_checkpoint: {type: "hf", repo, revision, token}` ("checkpoint to continue training from", present only in
  the OpenAPI schema, not in prose docs) **[unverified]**; wired as opt-in `NEBIUS_FT_FROM_HF_REPO`, which sends
  HF_TOKEN to Nebius. Arbitrary-architecture custom weights are NOT self-service: "Custom model weights" is
  beta, by request via support.
* Consequence for the Mac: a LoRA adapter for Gemma 4 E4B **cannot be produced on Nebius**, so there is nothing
  to load with `mlx-community/gemma-4-e4b-it-4bit` the way `mlx_local` does. What a full fine-tune produces is a
  full-weight checkpoint (~8B params incl. embeddings, ~16 GB bf16). It has the same architecture as our local
  base, so it CAN be used locally only after `mlx_lm convert` (Mode C below).
* A LoRA adapter trained on any other base (Qwen3, Llama) can NEVER be loaded by our local Gemma server.

### Modes (set via NEBIUS_FT_MODEL / NEBIUS_FT_LORA; `adapters/round_N/nebius_job.json` records which one ran)

| Mode | Config | Result | Use |
|---|---|---|---|
| A. Full FT Gemma 4 E4B, local | `google/gemma-4-E4B-it`, LORA=false | full weights downloaded (kind `full_weights`) | `python -m mlx_lm convert --hf-path adapters/round_N -q --q-bits 4 --mlx-path models/round_N`, then `LOCAL_MODEL=models/round_N`, no adapter. **[unverified]**: file layout of a full checkpoint and mlx_lm's handling of Gemma 4's multimodal wrapper |
| B. Remote student | any base, `NEBIUS_DOWNLOAD=0` (or LoRA base) | `ft_model` id (`ft:...:ckpt-step-N`) in nebius_job.json (kind `remote_only`/`lora_adapter`) | evaluate/serve through Nebius `POST /v1/chat/completions` with `model=<ft_model>` (works with `ServerClassifier(base_url=NEBIUS_BASE_URL, model=ft_model)` plus an `Authorization` header). LoRA adapters deploy "serverless with per-token billing" per the Deploy Custom LoRA page (page itself returned 404 to us, so details **[unverified]**); full-weight models need a Dedicated endpoint (hourly GPU, costs money) or the support-enabled custom-weights beta |
| C. LoRA on a different base | e.g. `Qwen/Qwen3-4B`, LORA=true | PEFT adapter (`adapter_model.safetensors`, `adapter_config.json`) **[observed format, from an existing Qwen3-1.7B job]** | only usable with that same base locally (would need `LOCAL_MODEL` switched to a Qwen3 mlx model and PEFT->MLX conversion); otherwise Mode B |

Closest LoRA-capable bases to Gemma 4 E4B (size): `Qwen/Qwen3-4B`, `Qwen/Qwen3-8B`,
`meta-llama/Llama-3.2-3B-Instruct`, `meta-llama/Llama-3.1-8B-Instruct`. Gemma 4 itself: full FT only.
The promotion gate in training/round.py evaluates whatever classifier the backend builds from the result, so
a remote student must be wrapped as a classifier by the lead (see "Changes for the lead").

## 2. API

Base URL `https://api.tokenfactory.nebius.com/v1` (OpenAI-compatible; regional hosts exist for inference, e.g.
`api.tokenfactory.us-central1.nebius.com`). Auth: `Authorization: Bearer $NEBIUS_API_KEY`
(keys: https://tokenfactory.nebius.com/project/api-keys). Env var name used by the docs: `NEBIUS_API_KEY`.

| Step | Call |
|---|---|
| list models (inference catalog, free) | `GET /v1/models[?verbose=true]` |
| upload dataset | `POST /v1/files` multipart `file=@x.jsonl`, `purpose=fine-tune` -> `{id}` (limit 20 GB) |
| create job | `POST /v1/fine_tuning/jobs` JSON `{model, training_file, validation_file?, hyperparameters, seed, suffix, integrations?, from_checkpoint?}` |
| poll | `GET /v1/fine_tuning/jobs/{id}`: `status` validating_files -> queued -> running -> succeeded / failed / cancelled; `trained_tokens`, `trained_steps`, `total_steps`, `error{code,message,param}`, `result_files` (poll >= 15 s) |
| events | `GET /v1/fine_tuning/jobs/{id}/events?limit&after`: lifecycle only ("Job is submitted", "Training started", "Training completed successfully") **[observed: no loss in events]** |
| loss / checkpoints | `GET /v1/fine_tuning/jobs/{id}/checkpoints`: one per epoch **[observed]**; `metrics{train_loss, valid_loss, (full_valid_loss, *_mean_token_accuracy)}`, `step_number`, `fine_tuned_model_checkpoint` (`ft:<base>:...:ckpt-step-N`), `result_files[]` |
| download | `GET /v1/files/{file_id}` (metadata, `filename` = `<ckpt_id>/<name>`), `GET /v1/files/{file_id}/content` |
| cancel | `POST /v1/fine_tuning/jobs/{id}/cancel` ("immediately cancel") |
| list jobs (probe) | `GET /v1/fine_tuning/jobs?limit=N` |

LoRA checkpoint files **[observed]**: `adapter_config.json`, `adapter_model.safetensors` (PEFT format, ~35 MB for
Qwen3-1.7B r=16), `chat_template.jinja`, `checkpoint.meta`, `tokenizer.json`, `tokenizer_config.json`.
Optional integrations: `wandb`, `mlflow`, `hf` (pushes the final model to an HF repo; needs an HF write token sent to Nebius).

## 3. Hyperparameters (SupervisedHParameters in openapi.json)

`n_epochs` 1-20 (3), `batch_size` 1-64 (8; docs say 8-32), `learning_rate` >=0 (1e-5; docs typical 1e-6..5e-5),
`context_length` 8192..131072 (8192), `packing` (true), `max_grad_norm` (1), `warmup_ratio` 0-1 (0), `weight_decay` (0),
`lora` (false), `lora_r` 8-128 (8), `lora_alpha` >=8 (8), `lora_dropout` 0-1 (0). Validation split optional
(docs: 80-90 % train / 10-20 % val); we send ~10 % val.
Our defaults for LoRA runs match the jobs already on the account: r=16, alpha=32, dropout 0.

## 4. Data format and loss masking

JSONL, types: conversational `{"messages":[...]}` (last message must be `assistant`), instruction
`{"prompt","completion"}`, text `{"text"}`, pretokenized `{"input_ids","labels","attention_mask"}`
(docs prose example says `token_ids`, the field list says `input_ids`; we use `input_ids`; labels `-100` = masked).
**Answer-only loss is not documented for the conversational/instruction formats** (docs only mention masking via
`-100` in pretokenized data). Default `NEBIUS_DATA_FORMAT=messages` therefore trains with whatever masking Nebius
applies **[unverified]**; `pretokenized` tokenizes locally with the HF tokenizer (needs HF_TOKEN, Gemma is gated),
masks the system+user prompt and trains on the answer tokens, and refuses if the chat template is not prefix-stable.
Our prompt is the shared `training/prompt.py` (system = CLASSIFIER_SYSTEM, user = raw ticket, assistant = `X Pn`).

## 5. Pricing / cost accounting

Per-token usage billing on **trained tokens** (docs: "pay only for tokens processed during training");
no numeric training prices are published on any page we could fetch (the price page is JS-rendered; docs and blog
give none). New accounts get $1 trial credit / 30 days (docs: Billing & Consumption). `trained_tokens` is the
total over all epochs **[observed: ~615k tokens for a 10-epoch run of a small set]**. So
`cost_usd = trained_tokens * NEBIUS_PRICE_PER_M_TOKENS / 1e6`; if the price is unset, cost is 0.0 and a note is
written to nebius_job.json. Copy the USD / 1M-token rate for your base model and method from the console
(https://tokenfactory.nebius.com/organization/prices). Observed wall time: 7-12 min even for tiny jobs (queue + startup).
Serving a fine-tuned model is billed separately (LoRA: per-token; Dedicated endpoint: GPU-hours).

## 6. What is untested (needs a real job = billable, not done)

Job creation/validation of `lora=false` on Gemma 4 E4B; whether the server rejects `lora=true` for it; format and
size of a full-weight checkpoint's `result_files`; mlx_lm conversion of it; answer-only masking in `messages` mode;
the `from_checkpoint` HF option; loss-event shape (we read checkpoints, which are verified); the price per 1M tokens;
serving a fine-tuned model via `/v1/chat/completions`. Everything else (upload/poll/checkpoints/files download,
cancel, auth) matches the OpenAPI spec and read-only calls on our account, and `tests/test_training_nebius.py`
covers the flow offline with `httpx.MockTransport`.

## 7. Safety design

NotEnabled without `NEBIUS_API_KEY` (raised in the constructor, before serving is paused); key only in the
Authorization header, never logged or echoed in errors; job creation is never auto-retried (no duplicate billing);
timeout (`NEBIUS_MAX_WAIT_MIN`), KeyboardInterrupt or any error while the job is live POSTs `/cancel`;
`scripts/nebius_probe.py` only issues GETs.

## Sources

* https://docs.tokenfactory.nebius.com/post-training/models (supported bases; Gemma 4 = full FT only)
* https://docs.tokenfactory.nebius.com/post-training/how-to-fine-tune (workflow, hyperparameters, checkpoints, download)
* https://docs.tokenfactory.nebius.com/post-training/datasets (formats, pretokenized labels)
* https://docs.tokenfactory.nebius.com/post-training/overview and https://docs.tokenfactory.nebius.com/fine-tuning/overview
* https://docs.tokenfactory.nebius.com/api-reference/introduction (base URL, Bearer auth)
* https://api.tokenfactory.nebius.com/openapi.json (job/checkpoint/event schemas, cancel, from_checkpoint)
* https://docs.tokenfactory.nebius.com/ai-models-inference/dedicated-endpoints/custom-weights (beta, on request)
* https://docs.tokenfactory.nebius.com/other-capabilities/billing-new (billing, trial credit)
* https://docs.tokenfactory.nebius.com/llms.txt (index; the "Deploy Custom LoRA" page linked from overview 404s)
