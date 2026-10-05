"""Record and annotate match frames using the classes of bundled ONNX models."""

from __future__ import annotations

import json
import math
import os
import threading
import time
import zipfile
from pathlib import Path
from typing import Any

from utils import resolve_project_path, atomic_write_text
from training_models import model_catalog, class_choices, LABELS

# Классы для разметки - все, что наши модели вообще ищут на карте. Взят из
# моделей, а не выдуман: gasDetector знает gas и bush, tileDetector - wall, bush
# и close_bush. Список в конфиге, потому что модель можно переобучить под
# другой набор, и разметка обязана совпадать с тем, на чём потом учат.
CLASS_LABELS_RU = LABELS

def class_names():
    return tuple(model_catalog()['classes'])

# A match is over when the screen stops saying match for this many checks in a
# row. The result screen is counted as still being part of the match, so the
# last frames of it are not thrown away.
# Только «match» - это и есть бой. «match_making» - экран подбора, и раньше он
# считался боем: запись начиналась заранее и обрывалась, не дождавшись матча.
# «brawler_selection» и «lobby» - тоже до боя.
MATCH_STATES = ("match",)

# Столько не-боевых проверок подряд считается концом боя. Две, а не больше:
# матчи идут один за другим, и при длинной паузе запись успевала перекрыть
# несколько боёв - тогда десять кадров размазались уже не по одному бою.
IDLE_CHECKS_BEFORE_STOP = 2

# Меньше двух кадров боя - это не бой, а мигновение. Пока столько не набралось,
# состояние может мигать сколько угодно: экран подбора, выбор бойца и загрузка
# тоже иногда читаются как бой, и оборвать запись на них нельзя.
MIN_MATCH_FRAMES = 2
MIN_FRAMES = 2

# Потолок на кадры в одной записи. Бой длинный - кадров может набежать много,
# а размазывать их всё равно будут по всей сессии, и поднятый лимит виден сразу.
MAX_RECORDED_FRAMES = 400

# How many frames the operator wants out of a match. The recorder still grabs one
# every few seconds, because nobody can say in advance when the match ends; the
# extra ones are thinned out evenly at the end, so ten frames from a three-minute
# match are ten spread across it rather than ten from the first half-minute.
DEFAULT_FRAME_COUNT = 10
MAX_FRAME_COUNT = 400


def training_root() -> Path:
    return resolve_project_path("training")


class TrainingSession:
    """One recorded match: its frames and, once marked up, its boxes."""

    def __init__(self, key: str, session_id: str, folder: Path):
        self.key = key
        self.id = session_id
        self.folder = folder
        self.meta_path = folder / "session.json"
        self._lock = threading.RLock()
        self.meta: dict[str, Any] = {
            "id": session_id,
            "key": key,
            "started": time.time(),
            "finished": None,
            "interval": 3.0,
            "status": "recording",
            "frames": [],
            "classes": list(class_names()),
            "annotation_version": 2,
        }
        self._load()
        # Append new categories without renumbering existing annotations.
        previous_classes = list(self.meta.get('classes') or [])
        self.meta['classes'] = list(dict.fromkeys(previous_classes + list(class_names())))
        if set(self.meta['classes']) - set(previous_classes):
            for frame in self.meta['frames']:
                frame['checked'] = False
            self.meta['review_notice'] = 'Набор классов расширен. Проверьте старые кадры заново; рамки сохранены.'
        self.meta.setdefault('models', model_catalog()['models'])

    # ── storage ──────────────────────────────────────────────────────────────
    def _load(self) -> None:
        if not self.meta_path.exists():
            return
        try:
            stored = json.loads(self.meta_path.read_text(encoding="utf-8"))
            if isinstance(stored, dict):
                if stored.get('annotation_version', 0) < 2:
                    for frame in stored.get('frames', []):
                        frame['checked'] = False
                    stored['annotation_version'] = 2
                    stored['review_notice'] = 'Запись создана прежней панелью. Проверьте кадры заново для всех классов: прежние рамки могли не сохраниться.'
                self.meta.update(stored)
        except Exception:  # noqa: BLE001
            pass

    def save(self) -> None:
        with self._lock:
            self.folder.mkdir(parents=True, exist_ok=True)
            atomic_write_text(self.meta_path, json.dumps(self.meta, ensure_ascii=False, indent=1))

    # ── recording ─────────────────────────────────────────────────────────────
    def add_frame(self, name: str, width: int, height: int) -> dict[str, Any]:
        with self._lock:
            frame = {"file": name, "w": int(width), "h": int(height),
                     "boxes": [], "checked": False}
            self.meta["frames"].append(frame)
            self.save()
            return frame

    def finish(self, reason: str = "") -> None:
        with self._lock:
            self.select_frames()
            self.meta["finished"] = time.time()
            self.meta["status"] = "done"
            self.meta["reason"] = reason
            self.save()

    def select_frames(self) -> None:
        """Keep an even spread of `frame_count` frames and drop the rest.

        Evenly spread matters more than evenly timed: a Showdown match spends
        its first seconds at full size and its last seconds almost closed, so
        taking the first N frames would give nothing but wide gas. Picking by
        index puts the same number of stills on every third of the match.
        """
        with self._lock:
            frames = self.meta.get("frames", [])
            wanted = self.meta.get("frame_count") or 0
            if not frames:
                return
            if not wanted or wanted >= len(frames):
                for frame in frames:
                    frame["keep"] = True
                return
            wanted = max(1, int(wanted))
            last = len(frames) - 1
            keep_indexes = sorted({round(i * last / (wanted - 1)) if wanted > 1 else 0
                                   for i in range(wanted)})
            for i, frame in enumerate(frames):
                frame["keep"] = i in keep_indexes

    def kept_frames(self) -> list[dict[str, Any]]:
        """Frames that survive the thinning, oldest first.

        Falls back to every frame for sessions written before thinning existed,
        so an old recording does not read as an empty one.
        """
        with self._lock:
            frames = list(self.meta.get("frames", []))
        if not any("keep" in f for f in frames):
            return frames
        return [f for f in frames if f.get("keep")]

    # ── labelling ─────────────────────────────────────────────────────────────
    def set_boxes(self, frame_name, boxes, checked, revision=None, excluded=False):
        with self._lock:
            frame = self._frame(frame_name)
            if frame is None:
                return None
            if revision is not None and int(revision) != int(frame.get('revision', 0)):
                raise ValueError('Кадр изменён в другой вкладке. Обновите страницу перед сохранением.')
            if not isinstance(boxes, list) or len(boxes) > 2000:
                raise ValueError('Некорректный список рамок.')
            clean = []
            allowed = self.meta['classes']
            for index, box in enumerate(boxes):
                try:
                    cls = box['cls']
                    x1, y1, x2, y2 = [float(box[key]) for key in ('x1', 'y1', 'x2', 'y2')]
                except (KeyError, TypeError, ValueError):
                    raise ValueError(f'Рамка {index + 1}: неверные координаты.')
                if cls not in allowed or not all(math.isfinite(v) for v in (x1, y1, x2, y2)):
                    raise ValueError(f'Рамка {index + 1}: неизвестный класс или нечисловые координаты.')
                x1, x2 = sorted((max(0, min(x1, frame['w'])), max(0, min(x2, frame['w']))))
                y1, y2 = sorted((max(0, min(y1, frame['h'])), max(0, min(y2, frame['h']))))
                if x2 - x1 < 4 or y2 - y1 < 4:
                    raise ValueError(f'Рамка {index + 1}: ширина и высота должны быть не меньше 4 пикселей.')
                clean.append({'cls': cls, 'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2})
            previous = dict(frame)
            frame.update(boxes=clean, checked=bool(checked), excluded=bool(excluded), revision=int(frame.get('revision', 0)) + 1)
            try:
                self.save()
            except Exception:
                frame.clear()
                frame.update(previous)
                raise
            return dict(frame)


    def _frame(self, name: str) -> dict[str, Any] | None:
        for frame in self.meta.get("frames", []):
            if frame.get("file") == name:
                return frame
        return None

    # ── reporting ─────────────────────────────────────────────────────────────
    def summary(self) -> dict[str, Any]:
        with self._lock:
            frames = self.kept_frames()
            checked = sum(1 for f in frames if f.get("checked"))
            boxes = sum(len(f.get("boxes") or []) for f in frames)
            return {
                "id": self.id,
                "key": self.key,
                "status": self.meta.get("status", "recording"),
                "started": self.meta.get("started"),
                "finished": self.meta.get("finished"),
                "interval": self.meta.get("interval", 3.0),
                "frame_count": self.meta.get("frame_count"),
                "recorded": len(self.meta.get("frames", [])),
                "frames": len(frames),
                "checked": checked,
                "boxes": boxes,
                "classes": list(self.meta.get("classes") or class_names()),
                "models": self.meta.get("models", []),
                "review_notice": self.meta.get("review_notice", ""),
                "reason": self.meta.get("reason", ""),
            }

    def detail(self) -> dict[str, Any]:
        with self._lock:
            return {**self.summary(), "items": self.kept_frames()}

    # ── export ────────────────────────────────────────────────────────────────
    def export_zip(self):
        import hashlib
        with self._lock:
            frames = [dict(f, boxes=[dict(b) for b in f.get('boxes', [])]) for f in self.kept_frames()]
            names = list(self.meta['classes'])
            models = list(self.meta.get('models') or model_catalog()['models'])
        if any(not f.get('checked') for f in frames):
            raise ValueError('Для экспорта проверьте все кадры; нужны минимум два кадра.')
        excluded = [f['file'] for f in frames if f.get('excluded')]
        frames = [f for f in frames if not f.get('excluded')]
        if len(frames) < 2:
            raise ValueError('После пропуска кадров нужны минимум два изображения для train/val.')
        groups = {}
        for frame in frames:
            path = self.folder / 'images' / frame['file']
            if not path.is_file():
                raise ValueError('Нет изображения: ' + frame['file'])
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            groups.setdefault(digest, []).append(frame)
        if len(groups) < 2:
            raise ValueError('Нужны минимум два разных изображения для train/val.')
        val = set(sorted(groups)[:max(1, len(groups) // 5)])
        out = self.folder / 'dataset.zip'
        import uuid
        temporary = self.folder / ('dataset.' + uuid.uuid4().hex + '.pending.zip')
        manifest = {'classes': names, 'models': models, 'session': self.id,
                    'excluded_frames': excluded, 'format': 'YOLO detection xywh normalized',
                    'split': 'identical image hashes remain together',
                    'model_class_aliases': {'gasDetector.onnx': {'close_bush': 'bush'}}}
        try:
            with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED) as zf:
                datasets = [('', names)] + [('datasets/' + Path(m['file']).stem + '/', m['classes']) for m in models]
                for prefix, categories in datasets:
                    for digest, items in groups.items():
                        split = 'val' if digest in val else 'train'
                        for frame in items:
                            filename = frame['file']
                            zf.write(self.folder / 'images' / filename, prefix + f'images/{split}/{filename}')
                            lines = []
                            for box in frame['boxes']:
                                category = box['cls']
                                if prefix == 'datasets/gasDetector/' and category == 'close_bush' and 'close_bush' not in categories:
                                    category = 'bush'
                                if category not in categories:
                                    continue
                                values = [(box['x1'] + box['x2']) / 2 / frame['w'],
                                          (box['y1'] + box['y2']) / 2 / frame['h'],
                                          (box['x2'] - box['x1']) / frame['w'],
                                          (box['y2'] - box['y1']) / frame['h']]
                                lines.append(str(categories.index(category)) + ' ' + ' '.join(f'{v:.6f}' for v in values))
                            zf.writestr(prefix + f'labels/{split}/{Path(filename).stem}.txt', '\n'.join(lines))
                    zf.writestr(prefix + 'data.yaml', 'path: .\ntrain: images/train\nval: images/val\nnames: ' + json.dumps(dict(enumerate(categories))) + '\n')
                zf.writestr('model_manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
                zf.writestr('README.txt', 'Root: combined classes. datasets/: one dataset per ONNX with its original class IDs.\nReview every visible instance before training. Detector names do not fully specify annotation conventions.\n')
            os.replace(temporary, out)
        finally:
            if temporary.exists():
                temporary.unlink()
        return out



class TrainingRecorder:
    """Keeps at most one running recording per device."""

    def __init__(self, device_manager):
        self._dm = device_manager
        self._sessions: dict[str, TrainingSession] = {}
        self._threads: dict[str, threading.Thread] = {}
        self._stop_flags: dict[str, threading.Event] = {}
        self._lock = threading.RLock()

    # ── lookup ────────────────────────────────────────────────────────────────
    def _folder(self, key: str, session_id: str) -> Path:
        return training_root() / key / session_id

    def session(self, session_id: str) -> TrainingSession | None:
        with self._lock:
            if session_id in self._sessions:
                return self._sessions[session_id]
        for folder in training_root().glob("*/*"):
            if folder.name == session_id:
                key = folder.parent.name
                found = TrainingSession(key, session_id, folder)
                with self._lock:
                    self._sessions[session_id] = found
                return found
        return None

    def all_sessions(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for folder in sorted(training_root().glob("*/*")):
            if not (folder / "session.json").exists():
                continue
            key = folder.parent.name
            with self._lock:
                found = self._sessions.get(folder.name)
            if found is None:
                found = TrainingSession(key, folder.name, folder)
                with self._lock:
                    self._sessions[folder.name] = found
            out.append(found.summary())
        out.sort(key=lambda item: item.get("started") or 0, reverse=True)
        return out

    def status(self, key: str) -> dict[str, Any] | None:
        with self._lock:
            thread = self._threads.get(key)
            flag = self._stop_flags.get(key)
        if thread is None or flag is None:
            return None
        session = self.session(self._session_id_for(key))
        if session is None:
            return None
        summary = session.summary()
        summary["recording"] = thread.is_alive()
        return summary

    def _session_id_for(self, key: str) -> str:
        for folder in sorted((training_root() / key).glob("*"), reverse=True):
            if (folder / "session.json").exists():
                return folder.name
        return ""

    # ── control ───────────────────────────────────────────────────────────────
    def start(self, key: str, interval: float = 3.0,
              frame_count: int | None = None) -> dict[str, Any]:
        with self._lock:
            existing = self._threads.get(key)
            if existing is not None and existing.is_alive():
                return {"ok": False, "message": "Запись уже идёт."}
            session_id = time.strftime("%Y%m%d-%H%M%S")
            folder = self._folder(key, session_id)
            (folder / "images").mkdir(parents=True, exist_ok=True)
            session = TrainingSession(key, session_id, folder)
            session.meta["interval"] = max(0.5, float(interval))
            try:
                wanted = int(frame_count) if frame_count else DEFAULT_FRAME_COUNT
            except (TypeError, ValueError):
                wanted = DEFAULT_FRAME_COUNT
            session.meta["frame_count"] = max(1, min(MAX_FRAME_COUNT, wanted))
            session.save()
            self._sessions[session_id] = session
            flag = threading.Event()
            self._stop_flags[key] = flag
            thread = threading.Thread(
                target=self._loop, args=(key, session, flag),
                name=f"training-{key}", daemon=True)
            self._threads[key] = thread
        thread.start()
        return {"ok": True, "session": session.summary()}

    def stop(self, key: str, reason: str = "остановлено вручную") -> dict[str, Any]:
        with self._lock:
            flag = self._stop_flags.get(key)
        if flag is not None:
            flag.set()
        return {"ok": True}

    def _loop(self, key: str, session: TrainingSession, flag: threading.Event) -> None:
        """Record the fight, not the wait for it.

        The recorder starts the bot, and from that moment to the first match
        there is a menu, a brawler screen and a loading bar - often longer than
        the fight itself. Saving every frame from the button press filled the
        dataset with lobby pictures, and spreading ten frames over that span
        left most of them outside the match. So frames are only kept while the
        screen says match, and the ten are spread over those frames alone, first
        and last of the fight included.
        """
        interval = float(session.meta.get("interval", 3.0))
        idle = 0
        started = time.monotonic()
        index = 0
        # How long to wait for the match to actually begin. Without a bound a bot
        # that never queues would record nothing for ever and the button would
        # look broken rather than saying what happened.
        wait_limit = 15 * 60
        try:
            while not flag.is_set():
                instance = self._dm.instance_for(key)
                frame = None
                state = ""
                if instance is not None:
                    try:
                        frame, _ = instance.window_controller.latest_frame_copy()
                    except Exception:  # noqa: BLE001
                        frame = None
                    try:
                        state = str(instance.get_latest_state() or "")
                    except Exception:  # noqa: BLE001
                        state = ""

                in_match = state in MATCH_STATES
                if in_match:
                    if frame is not None:
                        index += 1
                        name = f"frame_{index:04d}.jpg"
                        if self._dm.save_frame_jpeg(key, frame,
                                                    session.folder / "images" / name):
                            session.add_frame(name, frame.shape[1], frame.shape[0])
                    # Экран боя без кадра - это не конец боя, поэтому к счётчику
                    # простоя это не относится.
                    idle = 0
                    if index >= MAX_RECORDED_FRAMES:
                        session.finish("достигнут потолок кадров")
                        return
                elif index >= MIN_MATCH_FRAMES:
                    idle += 1
                    if idle >= IDLE_CHECKS_BEFORE_STOP:
                        session.finish("матч закончился")
                        return
                elif time.monotonic() - started > wait_limit:
                    session.finish("матч так и не начался")
                    return
                flag.wait(interval)
        finally:
            with self._lock:
                self._threads.pop(key, None)
                self._stop_flags.pop(key, None)
            if session.meta.get("status") != "done":
                session.finish("остановлено")
