"""Read class IDs from the bundled ONNX files, without executing model code."""
import ast
import hashlib
import re
from functools import lru_cache
from pathlib import Path

from utils import resolve_project_path

LABELS = {'gas': 'Газ', 'bush': 'Куст', 'wall': 'Стена',
          'close_bush': 'Куст вблизи', 'enemy': 'Враг',
          'teammate': 'Союзник', 'player': 'Наш игрок'}
HINTS = {
    'gas': 'Обводите видимую область ядовитого газа. Не размечайте обычный зелёный куст как газ.',
    'bush': 'Обводите видимый куст по его границам; отдельные группы кустов — отдельными рамками.',
    'wall': 'Обводите твёрдое препятствие. Кусты и декоративные детали не относятся к стенам.',
    'close_bush': 'Отдельный класс кустов из tileDetector. По имени и ONNX нельзя точно восстановить критерий его разметки: не назначайте этот класс только по размеру без примеров исходного датасета.',
    'enemy': 'Обводите видимого персонажа противника, а не ник, индикатор здоровья или эффект атаки.',
    'teammate': 'Обводите видимого персонажа союзника, а не ник, индикатор здоровья или эффект атаки.',
    'player': 'Обводите своего управляемого персонажа по видимым границам.'}

def normalize_names(raw):
    parsed = ast.literal_eval(raw)
    entries = dict(enumerate(parsed)) if isinstance(parsed, list) else parsed
    if not isinstance(entries, dict):
        raise ValueError('ONNX names must be a dictionary or list')
    result = []
    for index, value in sorted(entries.items(), key=lambda pair: int(pair[0])):
        if int(index) != len(result):
            raise ValueError('Non-contiguous ONNX class IDs')
        # gasDetector accidentally serializes each name as a one-entry dict.
        if isinstance(value, str) and value.startswith('{'):
            nested = ast.literal_eval(value)
            if isinstance(nested, dict) and len(nested) == 1:
                value = next(iter(nested.values()))
        if not isinstance(value, str) or not re.fullmatch(r'[a-zA-Z0-9_\-]+', value):
            raise ValueError('Invalid ONNX class name')
        result.append(value)
    if len(set(result)) != len(result):
        raise ValueError('Duplicate ONNX class names')
    return result

@lru_cache(maxsize=2)
def _read_catalog(signature):
    import onnxruntime as ort
    models = []
    for filename, _, _ in signature:
        path = Path(filename)
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        session = ort.InferenceSession(str(path), sess_options=options, providers=['CPUExecutionProvider'])
        metadata = session.get_modelmeta().custom_metadata_map
        names = normalize_names(metadata['names'])
        shape = session.get_outputs()[0].shape
        if isinstance(shape[1], int) and shape[1] != 4 + len(names):
            raise ValueError('Model output and class count disagree: ' + path.name)
        models.append({'file': path.name, 'classes': names,
                       'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    preferred = ['gas', 'bush', 'wall', 'close_bush', 'enemy', 'teammate', 'player']
    present = {name for model in models for name in model['classes']}
    names = [name for name in preferred if name in present] + sorted(present.difference(preferred))
    return {'classes': names, 'models': models}

def model_catalog():
    paths = [resolve_project_path('models', name) for name in
             ['gasDetector.onnx', 'tileDetector.onnx', 'closeTileDetector.onnx', 'mainInGameModel.onnx']]
    signature = tuple((str(path), path.stat().st_mtime_ns, path.stat().st_size) for path in paths)
    return _read_catalog(signature)

def class_choices(names=None):
    catalog = model_catalog()
    return [{'value': name, 'label': LABELS.get(name, name), 'hint': HINTS.get(name, ''),
             'models': [m['file'] for m in catalog['models'] if name in m['classes']]}
            for name in (names or catalog['classes'])]
