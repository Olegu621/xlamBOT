import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

source = Path(__file__).parent / 'restored-source'
sys.path.insert(0, str(source if source.is_dir() else Path(__file__).parent))
import update_client as u
key = Ed25519PrivateKey.generate()
u.PUBLIC_KEY = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw).hex()

def envelope(revision=1, data=b'VALUE=7\n'):
    manifest = {'repository':u.REPOSITORY, 'bootstrap':1, 'revision':revision, 'size':100,
        'sha256':'a'*64, 'files':{'sample_update.py':hashlib.sha256(data).hexdigest()}}
    return {'manifest':manifest, 'signature':key.sign(u.canonical(manifest)).hex()}

class Updates(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {'XLAMBOT_UPDATE_HOME':self.temp.name})
        self.env.start()
        self.meta = list(sys.meta_path)
        u.ACTIVE_OVERLAY = None
    def tearDown(self):
        sys.meta_path[:] = self.meta
        u.ACTIVE_OVERLAY = None
        self.env.stop(); self.temp.cleanup()
    def stage(self, rev=1):
        folder=u.root()/'releases'/str(rev)
        (folder/'content').mkdir(parents=True)
        (folder/'content/sample_update.py').write_bytes(b'VALUE=7\n')
        (folder/'manifest.json').write_bytes(u.canonical(envelope(rev)))
        return folder
    def test_signature_rejects_changed_revision(self):
        e=envelope(); e['manifest']['revision']=2
        with self.assertRaises(Exception): u.verify(e)
    def test_paths_and_userdata_rejected(self):
        for name in ['../x.py','/x.py','C:/x.py','x\\a.py','cfg/x.py','models/x.py','training/x.py','update_client.py','a.exe','x//y.py']:
            with self.subTest(name=name), self.assertRaises(ValueError): u.safe_name(name)
    def test_external_module_import_and_commit(self):
        self.stage(); u.write_state({'revision':0,'pending':1,'enabled':True})
        self.assertIsNotNone(u.activate())
        spec=u.OverlayFinder(u.ACTIVE_OVERLAY).find_spec('sample_update')
        module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        self.assertEqual(module.VALUE,7)
        u.mark_healthy(); self.assertEqual(u.read_state()['revision'],1)
        self.assertNotIn('pending',u.read_state())
    def test_failed_start_restores_previous(self):
        self.stage(1); self.stage(2)
        u.write_state({'revision':1,'pending':2,'attempted':True,'enabled':True})
        folder=u.activate()
        self.assertEqual(folder.parent.name,'1')
        self.assertNotIn('pending',u.read_state())
    def test_disabled_pending_update_is_not_activated(self):
        self.stage(); u.write_state({'revision':0,'pending':1,'enabled':False})
        self.assertIsNone(u.activate())
        self.assertNotIn('attempted',u.read_state())
    def test_corrupt_script_uses_bundle(self):
        folder=self.stage(); (folder/'content/sample_update.py').write_text('bad')
        u.write_state({'revision':1})
        self.assertIsNone(u.activate())
        self.assertEqual(u.read_state()['revision'],0)
    def test_offline_is_nonfatal(self):
        manager=u.UpdateManager(lambda:False,lambda:None)
        with patch.object(u,'download',side_effect=OSError('offline')): manager.check()
        self.assertEqual(manager.snapshot()['state'],'error')
        self.assertNotIn('pending',u.read_state())
    def test_duplicate_archive_rejected(self):
        import io,zipfile
        buffer=io.BytesIO()
        with zipfile.ZipFile(buffer,'w') as z:
            z.writestr('sample_update.py',b'VALUE=7\n'); z.writestr('sample_update.py',b'VALUE=7\n')
        data=buffer.getvalue(); e=envelope(); e['manifest'].update(size=len(data),sha256=hashlib.sha256(data).hexdigest())
        e['signature']=key.sign(u.canonical(e['manifest'])).hex()
        release={'assets':[{'name':name,'browser_download_url':f'https://github.com/{u.REPOSITORY}/releases/download/scripts-1/{name}'} for name in ['manifest.json','scripts.zip']]}
        manager=u.UpdateManager(lambda:False,lambda:None)
        with patch.object(u,'download',side_effect=[u.canonical(release),u.canonical(e),data]): manager.check()
        self.assertEqual(manager.snapshot()['state'],'error')
        self.assertNotIn('pending',u.read_state())
    def test_download_stages_signed_bundle_and_disable_prevents_activation(self):
        import io,zipfile
        buffer=io.BytesIO()
        with zipfile.ZipFile(buffer,'w') as z:z.writestr('sample_update.py',b'VALUE=7\n')
        data=buffer.getvalue(); e=envelope(); e['manifest'].update(size=len(data),sha256=hashlib.sha256(data).hexdigest())
        e['signature']=key.sign(u.canonical(e['manifest'])).hex()
        release={'assets':[{'name':name,'browser_download_url':f'https://github.com/{u.REPOSITORY}/releases/download/scripts-1/{name}'} for name in ['manifest.json','scripts.zip']]}
        manager=u.UpdateManager(lambda:False,lambda:None)
        manager.enabled(False)
        with patch.object(u,'download',side_effect=[u.canonical(release),u.canonical(e),data]):manager.check()
        self.assertNotIn('pending',u.read_state())
        manager.enabled(True)
        with patch.object(u,'download',side_effect=[u.canonical(release),u.canonical(e),data]):manager.check()
        self.assertEqual(u.read_state()['pending'],1)
    def test_busy_prevents_restart(self):
        u.write_state({'revision':0,'pending':1,'enabled':True})
        restart=unittest.mock.Mock(); manager=u.UpdateManager(lambda:True,restart)
        with patch.object(manager,'check'), patch.object(u.time,'sleep',side_effect=RuntimeError('end')):
            with self.assertRaises(RuntimeError):manager.loop()
        restart.assert_not_called()

if __name__=='__main__':unittest.main(verbosity=2)
