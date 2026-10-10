"""Trainer interface."""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Callable, Optional


class NotEnabled(RuntimeError):
    """Backend exists as a skeleton but is not enabled/configured."""


@dataclass
class TrainResult:
    adapter_path: str
    loss_curve: list = field(default_factory=list)   # [(step, train_loss)]
    wall_time_s: float = 0.0
    hardware: str = ""
    cost_usd: float = 0.0
    val_curve: list = field(default_factory=list)    # [(step, val_loss)]


ProgressFn = Callable[[dict], None]


class Trainer(ABC):
    name: str = "base"

    @abstractmethod
    def prepare(self, examples: list[dict]) -> str:
        """Write training data from examples [{text, category, priority}] -> data_dir."""

    @abstractmethod
    def train(self, round: int, data_dir: str,
              on_progress: Optional[ProgressFn] = None) -> TrainResult:
        ...
