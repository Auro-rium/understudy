"""Modal backend stub."""
from __future__ import annotations

from .base import NotEnabled, Trainer


class ModalTrainer(Trainer):
    name = "modal"

    def prepare(self, examples):
        raise NotEnabled("modal backend is not implemented")

    def train(self, round, data_dir, on_progress=None):
        raise NotEnabled("modal backend is not implemented")
