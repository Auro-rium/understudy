"""Single source of truth for the task schema and the frontend API contract."""
from typing import Literal, Optional

from pydantic import BaseModel

CATEGORIES = {
    "A": "payment_delay",
    "B": "payment_dispute",
    "C": "onboarding_kyc",
    "D": "task_assignment",
    "E": "app_technical",
    "F": "task_submission",
    "G": "account_status",
    "H": "other",
}
LETTERS = list(CATEGORIES)
PRIORITIES = ["P1", "P2", "P3", "P4"]
TEAMS = {
    "A": "Payments",
    "B": "Payments",
    "C": "Onboarding",
    "D": "Ops",
    "E": "Tech",
    "F": "Quality",
    "G": "Trust & Safety",
    "H": "General",
}

Source = Literal["local", "teacher", "review"]
Mode = Literal["online", "offline"]


class ClassifyRequest(BaseModel):
    text: str


class ClassifyResult(BaseModel):
    id: int
    category: str
    category_name: str
    priority: str
    team: str
    source: Source
    confidence: Optional[float] = None
    latency_ms: float
    cost_usd: float
    model_version: str


class TicketOut(ClassifyResult):
    text: str
    created_at: str


class Health(BaseModel):
    status: str
    model_version: str
    mode: Mode
    streaming: bool = False


class MetricsSummary(BaseModel):
    total: int
    local_share: float
    teacher_share: float
    review_share: float
    cost_usd_total: float
    cost_avoided_usd: float
    model_version: str
    mode: Mode


class TimePoint(BaseModel):
    t: str
    local_share: float
    cost_cumulative: float
    cost_cloud_only_cumulative: float


class ReviewItem(BaseModel):
    id: int
    text: str
    created_at: str


class LossPoint(BaseModel):
    step: int
    loss: float


class RoundEval(BaseModel):
    category_acc: float
    category_macro_f1: float
    priority_acc: float


class RoundOut(BaseModel):
    round: int
    model_version: str
    examples: int
    loss: list[LossPoint]
    wall_time_s: float
    hardware: str
    cost_usd: float
    promoted: bool
    reason: str
    eval: RoundEval


class TrainRequest(BaseModel):
    backend: Literal["mlx_local"] = "mlx_local"


class StreamStart(BaseModel):
    rate_per_min: float = 30


class OfflineRequest(BaseModel):
    offline: bool


def category_fields(letter: str) -> dict:
    return {"category": letter, "category_name": CATEGORIES[letter], "team": TEAMS[letter]}
