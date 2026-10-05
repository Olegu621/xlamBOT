"""Build a cumulative, signed script release without packaging user data."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile
from cryptography.hazmat.primitives import serialization

parser = argparse.ArgumentParser()
parser.add_argument('--source', type=Path, required=True)
parser.add_argument('--key', type=Path, required=True)
parser.add_argument('--revision', type=int, required=True)
args = parser.parse_args()
if args.revision < 1:
    parser.error('revision must be positive')
source = args.source.resolve()
files = {}
for path in source.glob('*.py'):
    if path.name not in {'update_client.py', 'xlambot_launcher.py', 'setup.py'} and not path.name.startswith(('test_', 'tools_')):
        files[path.name] = path
for directory, extensions in {'webui': {'.py'}, 'api': {'.py'}, 'static': {'.js', '.css'}, 'templates': {'.html'}}.items():
    for path in (source / directory).rglob('*'):
        if path.is_file() and path.suffix in extensions and '__pycache__' not in path.parts:
            files[path.relative_to(source).as_posix()] = path
output = Path(__file__).resolve().parent / 'dist' / str(args.revision)
output.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(output / 'scripts.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
    for name, path in sorted(files.items()):
        archive.writestr(name, path.read_bytes())
data = (output / 'scripts.zip').read_bytes()
manifest = {'repository': 'Olegu621/xlamBOT-updates', 'bootstrap': 1, 'revision': args.revision,
    'size': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
    'files': {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in sorted(files.items())}}
canonical = json.dumps(manifest, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
key = serialization.load_pem_private_key(args.key.read_bytes(), password=None)
(output / 'manifest.json').write_text(json.dumps({'manifest': manifest, 'signature': key.sign(canonical).hex()}, ensure_ascii=False, indent=2), 'utf-8')
print(f'{len(files)} files, {len(data)} bytes: {output}')
