"""Persistent, atomic progress updates for the desktop job monitor."""

import json
import math
import sys
import threading
import time
from numbers import Integral, Real
from pathlib import Path


def progress_count(value):
    """Convert NumPy/Python counters to finite JSON numbers."""
    if isinstance(value, Integral):
        return int(value) if value >= 0 else None
    if isinstance(value, Real):
        value = float(value)
        return value if math.isfinite(value) and value >= 0 else None
    return None


class Progress:
    def __init__(self, path=None):
        self.path = Path(path) if path else None
        self.warned = False
        if self.path:
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
            except OSError:
                self.warn()
                self.path = None
        self.lock = threading.Lock()
        self.last_update = 0.0
        self.current = {}

    def set(self, stage, label, detail="", *, completed=None, total=None, unit=None):
        completed, total = progress_count(completed), progress_count(total)
        value = dict(stage=stage, label=label, detail=detail,
                     completed=completed, total=total, unit=unit)
        with self.lock:
            changed = stage != self.current.get("stage") or label != self.current.get("label")
            now = time.monotonic()
            if not changed and total and completed != total and now - self.last_update < .25:
                return
            self.current = value
            self.last_update = now
            if changed:
                print(label + (f" — {detail}" if detail else ""), flush=True)
            if self.path:
                temporary = self.path.with_suffix(".tmp")
                try:
                    temporary.write_text(json.dumps(value, allow_nan=False), encoding="utf-8")
                    temporary.replace(self.path)
                except (OSError, TypeError, ValueError, OverflowError):
                    # Progress is optional; a display/file error must not abort
                    # GPU transcription or speaker detection.
                    self.warn()
                    try:
                        temporary.unlink(missing_ok=True)
                    except OSError:
                        pass

    def warn(self):
        if not self.warned:
            print("Progress display could not be updated; transcription will continue.",
                  file=sys.stderr, flush=True)
            self.warned = True

    def bar(self, stage, label, detail="", unit=None):
        """Adapt tqdm's actual file/frame counts without inventing an ETA."""
        from tqdm import tqdm
        reporter = self

        class ProgressBar(tqdm):
            def __init__(self, *args, **kwargs):
                kwargs["disable"] = False
                super().__init__(*args, **kwargs)

            def display(self, *args, **kwargs):
                reporter.set(stage, label, detail, completed=self.n,
                             total=self.total, unit=unit or self.unit)

        return ProgressBar
