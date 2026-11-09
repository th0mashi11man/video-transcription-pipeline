"""Persistent, atomic progress updates for the desktop job monitor."""

import json
import threading
import time
from pathlib import Path


class Progress:
    def __init__(self, path=None):
        self.path = Path(path) if path else None
        if self.path:
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.last_update = 0.0
        self.current = {}

    def set(self, stage, label, detail="", *, completed=None, total=None, unit=None):
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
                temporary.write_text(json.dumps(value), encoding="utf-8")
                temporary.replace(self.path)

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
