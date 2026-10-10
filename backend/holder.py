"""Reader-writer lock + ModelHolder for hot-swapping adapters/model versions."""
import threading
from typing import Optional

from backend.classifiers import BaseClassifier, ClassifierOutput


class RWLock:
    """Writer-preferring RW lock: a waiting writer blocks new readers."""

    def __init__(self):
        self._cond = threading.Condition()
        self._readers = 0
        self._writer = False
        self._writers_waiting = 0

    def acquire_read(self):
        with self._cond:
            while self._writer or self._writers_waiting:
                self._cond.wait()
            self._readers += 1

    def release_read(self):
        with self._cond:
            self._readers -= 1
            if self._readers == 0:
                self._cond.notify_all()

    def acquire_write(self):
        with self._cond:
            self._writers_waiting += 1
            while self._writer or self._readers:
                self._cond.wait()
            self._writers_waiting -= 1
            self._writer = True

    def release_write(self):
        with self._cond:
            self._writer = False
            self._cond.notify_all()


class ModelHolder:
    def __init__(self, classifier: BaseClassifier, version: str = "base"):
        self._clf = classifier
        self._version = version
        self._lock = RWLock()
        self._paused = False

    def pause(self):
        """Block new classify calls (in-flight ones finish first) and free the model's memory.
        The pausing thread may still call swap(); everything else must wait for resume()."""
        self._lock.acquire_write()
        self._paused = True
        if hasattr(self._clf, "unload"):
            self._clf.unload()

    def resume(self):
        if not self._paused:
            return
        if hasattr(self._clf, "reload"):
            self._clf.reload()
        self._paused = False
        self._lock.release_write()

    @property
    def version(self) -> str:
        return self._version

    def classify(self, text: str):
        """Returns (ClassifierOutput, model_version) atomically w.r.t. swaps."""
        self._lock.acquire_read()
        try:
            return self._clf.classify(text), self._version
        finally:
            self._lock.release_read()

    def swap(self, version: str, adapter_path: Optional[str] = None,
             classifier: Optional[BaseClassifier] = None) -> str:
        """Swap to `version`. Either give a ready `classifier`, or an `adapter_path` that is applied
        on top of the CURRENT classifier's base (built outside the lock, so slow loads don't block
        traffic). In-flight classify calls finish first; new calls wait for the pointer swap."""
        if classifier is None:
            if adapter_path is None:
                raise ValueError("swap needs adapter_path or classifier")
            classifier = self._clf.with_adapter(adapter_path)
        if self._paused:  # caller is the pausing thread, which already holds the write lock
            self._clf, self._version = classifier, version
            return version
        self._lock.acquire_write()
        try:
            self._clf, self._version = classifier, version
        finally:
            self._lock.release_write()
        return version
