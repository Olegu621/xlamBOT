"""Signed script updates; executable/runtime upgrades still use an installer."""
from __future__ import annotations
import hashlib
import importlib.abc
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import threading
import time
import zipfile
import requests
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

REPOSITORY = 'Olegu621/xlamBOT-updates'
BOOTSTRAP = 1
PUBLIC_KEY = '9a7d7864c03c38ece7f571ca9808aa41a37b0f1d468e3b2c74e1dbe1b4b36b32'
MAX_SIZE = 64 * 1024 * 1024
ACTIVE_OVERLAY = None
_state_lock = threading.RLock()

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')

def root():
    return Path(os.environ.get('XLAMBOT_UPDATE_HOME') or Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'xlamBOT' / 'updates')

def read_state():
    try:
        return json.loads((root() / 'state.json').read_text('utf-8'))
    except (OSError, ValueError):
        return {'enabled': True, 'revision': 0}

def write_state(state):
    with _state_lock:
        root().mkdir(parents=True, exist_ok=True)
        temporary = root() / 'state.tmp'
        temporary.write_bytes(canonical(state))
        os.replace(temporary, root() / 'state.json')

def safe_name(name):
    p = PurePosixPath(name)
    if not name or '\\' in name or ':' in name or p.is_absolute() or '..' in p.parts or str(p) != name:
        raise ValueError('Invalid update path')
    if p.parts[0] in {'cfg', 'devices', 'models', 'training', 'playstyles', 'vendor', 'scrcpy'}:
        raise ValueError('Update cannot modify user data or runtime')
    if name in {'update_client.py', 'xlambot_launcher.py'} or p.suffix not in {'.py', '.js', '.css', '.html'}:
        raise ValueError('Unsupported update file')
    return name

def verify(envelope):
    manifest = envelope['manifest']
    Ed25519PublicKey.from_public_bytes(bytes.fromhex(PUBLIC_KEY)).verify(bytes.fromhex(envelope['signature']), canonical(manifest))
    if manifest['repository'] != REPOSITORY or manifest['bootstrap'] != BOOTSTRAP:
        raise ValueError('This update needs a newer installer')
    if type(manifest['revision']) is not int or manifest['revision'] < 1:
        raise ValueError('Invalid revision')
    if not 0 < manifest['size'] <= MAX_SIZE or not manifest['files']:
        raise ValueError('Invalid update size')
    for name, digest in manifest['files'].items():
        safe_name(name)
        if len(bytes.fromhex(digest)) != 32:
            raise ValueError('Invalid file digest')
    return manifest

def validate_content(folder, manifest):
    for name, expected in manifest['files'].items():
        path = folder / safe_name(name)
        if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError('Update file integrity check failed')

class OverlayFinder(importlib.abc.MetaPathFinder):
    def __init__(self, folder):
        self.folder = folder
    def find_spec(self, fullname, path=None, target=None):
        location = self.folder.joinpath(*fullname.split('.'))
        if (location / '__init__.py').is_file():
            return importlib.util.spec_from_file_location(fullname, location / '__init__.py', submodule_search_locations=[str(location)])
        if location.with_suffix('.py').is_file():
            return importlib.util.spec_from_file_location(fullname, location.with_suffix('.py'))
        return None

def activate():
    global ACTIVE_OVERLAY
    state = read_state()
    if state.get('pending') and state.get('enabled', True):
        if state.get('attempted'):
            state.pop('pending', None)
            state.pop('attempted', None)
            state['last_error'] = 'Previous update did not start; restored previous scripts'
        else:
            state['attempted'] = True
        write_state(state)
    revision = (state.get('pending') if state.get('enabled', True) else None) or state.get('revision', 0)
    if not revision:
        return None
    folder = root() / 'releases' / str(revision)
    try:
        manifest = verify(json.loads((folder / 'manifest.json').read_text('utf-8')))
        if manifest['revision'] != revision:
            raise ValueError('Revision mismatch')
        validate_content(folder / 'content', manifest)
        sys.meta_path.insert(0, OverlayFinder(folder / 'content'))
        ACTIVE_OVERLAY = folder / 'content'
        return folder / 'content'
    except Exception:
        state.pop('pending', None)
        state.pop('attempted', None)
        state['last_error'] = 'Damaged update; using bundled scripts'
        state['revision'] = 0
        write_state(state)
        return None

def mark_healthy():
    state = read_state()
    if state.get('pending') and state.get('attempted'):
        state['previous'] = state.get('revision', 0)
        state['revision'] = state.pop('pending')
        state.pop('attempted', None)
        state.pop('last_error', None)
        write_state(state)

def download(url, limit):
    response = requests.get(url, timeout=(8, 30), stream=True, headers={'User-Agent': 'xlamBOT-updater/1'})
    with response:
        response.raise_for_status()
        data = bytearray()
        for chunk in response.iter_content(64 * 1024):
            data.extend(chunk)
            if len(data) > limit:
                raise ValueError('Download exceeds permitted size')
        return bytes(data)

def release_url(asset):
    url = asset['browser_download_url']
    if not url.startswith(f'https://github.com/{REPOSITORY}/releases/download/'):
        raise ValueError('Unexpected update origin')
    return url

class UpdateManager:
    def __init__(self, busy, restart):
        self.busy, self.restart = busy, restart
        self.lock = threading.RLock()
        self.check_lock = threading.Lock()
        self.status = {'state': 'idle', 'message': 'Проверка обновлений', 'repository': REPOSITORY}
        self.installing = False
    def snapshot(self):
        with self.lock:
            return {**self.status, 'enabled': read_state().get('enabled', True), 'revision': read_state().get('revision', 0)}
    def enabled(self, enabled):
        with self.lock:
            if type(enabled) is not bool:
                raise ValueError('enabled must be boolean')
            state = read_state(); state['enabled'] = enabled; write_state(state)
        return self.snapshot()
    def check(self):
        if not self.check_lock.acquire(blocking=False):
            return
        try:
            self.status.update(state='checking', message='Проверяю GitHub')
            release = json.loads(download(f'https://api.github.com/repos/{REPOSITORY}/releases/latest', 2 * 1024 * 1024))
            if release.get('draft') or release.get('prerelease'):
                raise ValueError('Only stable releases are supported')
            assets = {a['name']: a for a in release['assets']}
            envelope = json.loads(download(release_url(assets['manifest.json']), 1024 * 1024))
            manifest = verify(envelope)
            state = read_state()
            if manifest['revision'] <= max(state.get('revision', 0), state.get('pending', 0)):
                self.status.update(state='current', message='Установлена актуальная версия')
                return
            archive = download(release_url(assets['scripts.zip']), MAX_SIZE)
            if len(archive) != manifest['size'] or hashlib.sha256(archive).hexdigest() != manifest['sha256']:
                raise ValueError('Archive integrity check failed')
            folder = root() / 'releases' / str(manifest['revision'])
            content = folder / 'content'; content.mkdir(parents=True, exist_ok=True)
            import io
            with zipfile.ZipFile(io.BytesIO(archive)) as z:
                names = z.namelist()
                if len(names) != len(set(names)) or set(names) != set(manifest['files']):
                    raise ValueError('Unexpected archive contents')
                if sum(i.file_size for i in z.infolist()) > MAX_SIZE:
                    raise ValueError('Unpacked update too large')
                for name in names:
                    path = content / safe_name(name); path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(z.read(name))
            validate_content(content, manifest)
            (folder / 'manifest.json').write_bytes(canonical(envelope))
            # A disabled updater may check manually, but never arms installation.
            if read_state().get('enabled', True):
                state = read_state(); state['pending'] = manifest['revision']; write_state(state)
            self.status.update(state='ready', message='Обновление скачано; установится после остановки ботов', available=manifest['revision'])
        except Exception as error:
            self.status.update(state='error', message=f'Не удалось обновить: {type(error).__name__}')
        finally:
            self.check_lock.release()
    def request_check(self):
        threading.Thread(target=self.check, daemon=True).start()
    def loop(self):
        next_check = 0
        while True:
            if read_state().get('enabled', True):
                if time.monotonic() >= next_check:
                    self.check(); next_check = time.monotonic() + 3600
                with self.lock:
                    if read_state().get('pending') and not self.busy() and not self.installing:
                        self.installing = True
                        self.status.update(state='restarting', message='Применяю обновление; панель перезапустится')
                        try:
                            self.restart()
                        except Exception:
                            self.installing = False
                            self.status.update(state='error', message='Не удалось перезапустить бот')
            time.sleep(10)

def restart_application():
    if not getattr(sys, 'frozen', False) or os.name != 'nt':
        raise RuntimeError('Automatic restart requires the Windows installer')
    # A detached helper waits for this process/mutex to end, then starts the same EXE.
    exe = str(Path(sys.executable).resolve()).replace("'", "''")
    helper = root() / 'restart.ps1'
    helper.write_text(f"$p = Get-Process -Id {os.getpid()} -ErrorAction SilentlyContinue\nif ($p) {{ $p.WaitForExit() }}\nStart-Sleep -Seconds 1\nStart-Process -FilePath '{exe}' -WindowStyle Hidden\n", encoding='utf-8-sig')
    subprocess.Popen(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(helper)],
        creationflags=subprocess.CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS, close_fds=True)
    time.sleep(2)
    os._exit(0)
