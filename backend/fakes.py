"""Test/demo doubles for the teacher (FakeClassifier lives in classifiers.py)."""
import threading

from backend.classifiers import FakeClassifier
from backend.teacher_iface import TeacherResult, TeacherUnavailable


class FakeTeacher:
    """Answers using the FakeClassifier keyword rules; reports synthetic token counts."""

    def __init__(self, tokens_in=120, tokens_out=12, available=True):
        self.tokens_in, self.tokens_out, self.available = tokens_in, tokens_out, available
        self.calls = 0
        self._lock = threading.Lock()
        self._oracle = FakeClassifier()

    def complete(self, system: str, user: str, json_mode: bool = False) -> TeacherResult:
        if not self.available:
            raise TeacherUnavailable("fake teacher offline")
        with self._lock:
            self.calls += 1
        o = self._oracle.classify(user)
        return TeacherResult(text='{"category": "%s", "priority": "%s"}' % (o.letter, o.priority),
                             tokens_in=self.tokens_in, tokens_out=self.tokens_out, latency_s=0.01)

    def healthy(self) -> bool:
        return self.available
