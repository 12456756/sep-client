import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import time
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('publisher', Path(__file__).with_name('server-pull-publisher.py'))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / 'stable'
        self.root.mkdir()
        self.work = self.base / 'private'
        self.work.mkdir()
        self.files = {}
        self.request = dict(root=str(self.root), workRoot=str(self.work), version='1.2.3', runId='1234', runAttempt='2', commit='a' * 40, artifactId='77')
        artifacts, downloads, connectors, manifests = [], [], [], []
        for platform, extensions in [('win-x64', ['exe']), ('mac-arm64', ['dmg', 'zip']), ('mac-x64', ['dmg', 'zip'])]:
            for extension in extensions:
                name = f'SEP-Client-1.2.3-{platform}.{extension}'
                for filename in [name, name + '.blockmap']:
                    data = filename.encode()
                    self.files['artifacts/' + filename] = data
                    artifacts.append(dict(name=filename, size=len(data), sha256=hashlib.sha256(data).hexdigest(), destination='1.2.3/' + filename, url=p.FEED + '1.2.3/' + filename))
                downloads.append(dict(url='1.2.3/' + name, size=len(name), sha512=base64.b64encode(hashlib.sha512(name.encode()).digest()).decode()))
        for platform in ['win32-x64', 'darwin-x64', 'darwin-arm64']:
            for component in ['dingtalk', 'feishu', 'wecom']:
                data = f'{component}-{platform}'.encode()
                digest = hashlib.sha256(data).hexdigest()
                name = f'{component}-1.0.0-{platform}-{digest}.zip'
                self.files['connector-assets/' + name] = data
                connectors.append(dict(name=name, size=len(data), sha256=digest))
        catalog = dict(version='1.2.3', artifacts=[dict(platform=platform, label=label, fileName=f'SEP-Client-1.2.3-{suffix}', url=p.FEED + f'1.2.3/SEP-Client-1.2.3-{suffix}', architecture=architecture, minimumOsVersion=minimum) for platform, suffix, label, architecture, minimum in [
            ('macos-arm64', 'mac-arm64.dmg', 'macOS · Apple 芯片', 'ARM64', 'macOS 12 或更高版本'),
            ('macos-x64', 'mac-x64.dmg', 'macOS · Intel 芯片', 'x64', 'macOS 12 或更高版本'),
            ('windows-x64', 'win-x64.exe', 'Windows · 64 位', 'x64', 'Windows 10 64 位或更高版本'),
        ]])
        for name in p.POINTERS:
            data = json.dumps(catalog).encode() if name == 'client-release.json' else b'version: 1.2.3\n'
            self.files[name] = data
            manifests.append(dict(name=name, size=len(data), sha256=hashlib.sha256(data).hexdigest()))
            (self.root / name).write_bytes(b'version: 1.2.2\n')
        self.plan = dict(schemaVersion=1, channel='stable', feed=p.FEED, version='1.2.3', runId='1234', runAttempt='2', commit='a' * 40, artifacts=artifacts, connectorArtifacts=connectors, manifests=manifests, downloads=downloads)
        self.archive = self.base / 'bundle.zip'
        self.make_archive()

    def make_archive(self, extra=None):
        self.files['server-pull-plan.json'] = json.dumps(self.plan).encode()
        with zipfile.ZipFile(self.archive, 'w') as archive:
            for name, data in self.files.items():
                archive.writestr(name, data)
            if extra:
                archive.writestr(*extra)
        self.request.update(archiveSize=self.archive.stat().st_size, archiveSha256=p.file_hash(self.archive), planSha256=hashlib.sha256(self.files['server-pull-plan.json']).hexdigest())

    def publish(self, verify=None, precheck=None):
        with p.extracted_bundle(self.archive, self.work, self.request) as (payload, plan):
            return p.publish(payload, plan, self.root, self.work, verify or (lambda *_: None), precheck or (lambda *_: None))

    def test_public_files_must_be_reachable_before_switching_manifests(self):
        def fail(*_):
            raise p.ReleaseError('installer unreachable')
        with self.assertRaisesRegex(p.ReleaseError, 'unreachable'):
            self.publish(precheck=fail)
        for name in p.POINTERS:
            self.assertEqual((self.root / name).read_bytes(), b'version: 1.2.2\n')

    def test_safe_bundle_and_successful_idempotent_publication(self):
        self.publish()
        self.publish()
        for name in p.POINTERS:
            self.assertEqual((self.root / name).read_bytes(), self.files[name])
            self.assertEqual((self.work / 'previous-manifests' / name).read_bytes(), b'version: 1.2.2\n')
        self.assertEqual(len(list((self.root / '1.2.3').iterdir())), 10)
        if os.name != 'nt':
            self.assertEqual(stat.S_IMODE((self.root / '1.2.3').stat().st_mode), 0o755)

    def test_public_verification_failure_restores_old_manifests_and_retry_succeeds(self):
        def fail(*_):
            raise p.ReleaseError('public verification failed')
        with self.assertRaisesRegex(p.ReleaseError, 'verification failed'):
            self.publish(fail)
        for name in p.POINTERS:
            self.assertEqual((self.root / name).read_bytes(), b'version: 1.2.2\n')
        self.publish()

    def test_completed_release_is_not_rolled_back_by_a_failed_repeat_verification(self):
        self.publish()
        def fail(*_):
            raise p.ReleaseError('public verification failed')
        with self.assertRaises(p.ReleaseError):
            self.publish(fail)
        self.assertEqual((self.root / p.MANIFESTS[0]).read_bytes(), self.files[p.MANIFESTS[0]])

    def test_cancel_before_switch_leaves_old_manifests(self):
        calls = 0
        def cancelled():
            nonlocal calls
            calls += 1
            if calls > 10:
                raise p.ReleaseError('release cancelled')
        with patch.object(p, 'check_active', cancelled):
            with self.assertRaisesRegex(p.ReleaseError, 'cancelled'):
                self.publish()
        self.assertEqual((self.root / p.MANIFESTS[0]).read_bytes(), b'version: 1.2.2\n')

    def test_cancel_after_switch_restores_old_manifests(self):
        def fail(*_):
            raise p.ReleaseError('release cancelled')
        with self.assertRaisesRegex(p.ReleaseError, 'cancelled'):
            self.publish(fail)
        self.assertEqual((self.root / p.MANIFESTS[1]).read_bytes(), b'version: 1.2.2\n')

    def test_changed_production_manifest_is_not_overwritten_on_retry(self):
        self.publish()
        (self.root / 'latest.yml').write_bytes(b'version: 9.0.0\n')
        with self.assertRaisesRegex(p.ReleaseError, 'changed'):
            self.publish()
        self.assertEqual((self.root / 'latest.yml').read_bytes(), b'version: 9.0.0\n')

    def test_existing_version_from_another_release_is_not_overwritten(self):
        (self.root / '1.2.3').mkdir()
        with self.assertRaisesRegex(p.ReleaseError, 'already exists'):
            self.publish()

    def test_bad_size_checksum_and_wrong_identity_fail_before_publication(self):
        for field, value in [('archiveSize', 1), ('archiveSha256', 'b' * 64), ('planSha256', 'b' * 64), ('commit', 'b' * 40)]:
            request = {**self.request, field: value}
            with self.assertRaises(p.ReleaseError):
                with p.extracted_bundle(self.archive, self.work, request):
                    self.fail('unsafe archive accepted')
        self.assertFalse((self.root / '1.2.3').exists())

    def test_unsafe_zip_entries_duplicates_and_symlinks_are_rejected(self):
        entries = [('../escape', b'x'), ('/absolute', b'x'), ('unknown.txt', b'x'), ('latest.yml', b'duplicate')]
        link = zipfile.ZipInfo('link')
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        entries.append((link, b'/etc/passwd'))
        for entry in entries:
            with self.subTest(entry=str(entry[0])):
                self.make_archive(entry)
                with self.assertRaises(p.ReleaseError):
                    with p.extracted_bundle(self.archive, self.work, self.request):
                        self.fail('unsafe archive accepted')

    def test_corrupted_installer_and_incomplete_component_set_are_rejected(self):
        name = next(name for name in self.files if name.startswith('artifacts/'))
        self.files[name] = b'wrong'
        self.make_archive()
        with self.assertRaises(p.ReleaseError):
            self.publish()
        self.plan['connectorArtifacts'] = self.plan['connectorArtifacts'][:-1]
        self.make_archive()
        with self.assertRaises(p.ReleaseError):
            self.publish()

    def test_conflicting_existing_connector_is_not_overwritten(self):
        components = self.root / 'connector-assets'
        components.mkdir()
        name = self.plan['connectorArtifacts'][0]['name']
        (components / name).write_bytes(b'bad')
        with self.assertRaises(p.ReleaseError):
            self.publish()
        self.assertEqual((components / name).read_bytes(), b'bad')

    def test_download_resumes_and_never_puts_signed_url_in_process_arguments(self):
        part = self.work / 'artifact.zip.part'
        part.write_bytes(b'partial')
        url = 'https://productionresultssa1.blob.core.windows.net/a?sig=secret'
        with patch.object(p, 'run_curl', return_value=28) as run:
            result = p.download(self.work, {**self.request, 'url': url})
        self.assertEqual(result['status'], 'retry')
        args, config = run.call_args.args
        self.assertIn('--continue-at', args)
        self.assertNotIn(url, ' '.join(args))
        self.assertIn(url, config)
        self.assertEqual(part.read_bytes(), b'partial')

    def test_completed_download_is_reused_and_wrong_complete_archive_is_not_accepted(self):
        part = self.work / 'artifact.zip.part'
        part.write_bytes(self.archive.read_bytes())
        with patch.object(p, 'run_curl') as run:
            self.assertEqual(p.download(self.work, self.request)['status'], 'ready')
            run.assert_not_called()
        part.write_bytes(b'x' * self.request['archiveSize'])
        with patch.object(p, 'run_curl', return_value=33):
            self.assertEqual(p.download(self.work, {**self.request, 'url': 'https://productionresultssa1.blob.core.windows.net/a'})['status'], 'retry')
        self.assertEqual(part.stat().st_size, 0)

    def test_urls_reject_cleartext_credentials_shell_controls_and_foreign_hosts(self):
        for value in ['http://example.com/a', 'https://example.com/a', 'https://user:secret@productionresultssa1.blob.core.windows.net/a', 'https://productionresultssa1.blob.core.windows.net/a\n', 'https://productionresultssa1.blob.core.windows.net/a"']:
            with self.assertRaises(p.ReleaseError):
                p.validate_url(value)

    def test_curl_subprocess_receives_config_by_stdin_and_is_terminated_on_cancellation(self):
        self.assertEqual(p.run_curl([sys.executable, '-c', 'import sys;sys.stdin.read();sys.exit(28)'], 'private config'), 28)
        with patch.object(p, 'check_active', side_effect=p.ReleaseError('cancelled')):
            with self.assertRaisesRegex(p.ReleaseError, 'cancelled'):
                p.run_curl([sys.executable, '-c', 'import time;time.sleep(10)'], 'private config')

    def test_public_head_checks_all_installers_and_components(self):
        sizes = {p.FEED + item['url']: item['size'] for item in self.plan['downloads']}
        sizes.update({p.FEED + 'connector-assets/' + item['name']: item['size'] for item in self.plan['connectorArtifacts']})
        class Response(io.BytesIO):
            def __init__(self, size):
                super().__init__()
                self.headers = {'Content-Length': str(size)}
        with patch.object(p, 'open_public', side_effect=lambda url, method: Response(sizes[url])) as fetch:
            p.precheck_public(self.plan)
        self.assertEqual(fetch.call_count, 14)
        with patch.object(p, 'open_public', return_value=Response(1)):
            with self.assertRaises(p.ReleaseError):
                p.precheck_public(self.plan)

    def test_public_transport_rejects_redirects_and_invalid_responses(self):
        response = SimpleNamespace(status=200, headers={'Content-Encoding': 'identity'})
        with patch.object(p, 'build_opener') as opener:
            opener.return_value.open.return_value = response
            self.assertIs(p.open_public(p.FEED + 'latest.yml', 'HEAD'), response)
            self.assertEqual(opener.return_value.open.call_args.args[0].method, 'HEAD')
            response.status = 401
            with self.assertRaises(p.ReleaseError):
                p.open_public(p.FEED + 'latest.yml')
        with self.assertRaises(p.ReleaseError):
            p.open_public('https://example.com/private')
        with self.assertRaises(p.ReleaseError):
            p.NoRedirect().redirect_request(None)

    @unittest.skipUnless(os.name == 'posix', 'Linux SSH signal and heartbeat supervision')
    def test_supervisor_requires_heartbeat_and_sanitizes_unclassified_errors(self):
        callbacks, signals = [], []
        def thread(**kwargs):
            callbacks.append(kwargs['target'])
            return SimpleNamespace(start=lambda: None)
        output, errors = io.StringIO(), io.StringIO()
        try:
            with patch.object(p.threading, 'Thread', side_effect=thread), patch.object(p.signal, 'signal', side_effect=lambda _sig, handler: signals.append(handler)), patch.object(p.sys, 'stdin', io.StringIO('heartbeat\n')), patch.object(p.sys, 'stdout', output), patch.object(p.sys, 'stderr', errors), patch.object(p, 'execute', return_value={'status': 'ready'}):
                p.supervise({})
                self.assertIn('SEP_RELEASE_RESULT=', output.getvalue())
                callbacks[0]()
                self.assertTrue(p.CANCELLED.is_set())
                p.CANCELLED.clear()
                with patch.object(p.CANCELLED, 'wait', side_effect=[False, True]), patch.object(p.time, 'monotonic', return_value=time.monotonic() + 100):
                    callbacks[1]()
                self.assertTrue(p.CANCELLED.is_set())
                p.CANCELLED.clear()
                signals[0](None, None)
                self.assertTrue(p.CANCELLED.is_set())
                p.CANCELLED.clear()
                with patch.object(p, 'execute', side_effect=RuntimeError('secret-signed-url')):
                    with self.assertRaises(SystemExit):
                        p.supervise({})
                self.assertIn('RuntimeError', errors.getvalue())
                self.assertNotIn('secret-signed-url', errors.getvalue())
        finally:
            p.CANCELLED.clear()

    @unittest.skipUnless(os.name == 'posix', 'Linux server preflight and file locks')
    def test_linux_worker_preflight_and_download_cache_identity(self):
        os.chmod(self.work, 0o700)
        base = {**self.request, 'mode': 'preflight'}
        self.assertEqual(p.execute(base)['status'], 'ready')
        os.chmod(self.work, 0o755)
        with self.assertRaisesRegex(p.ReleaseError, 'mode 700'):
            p.execute(base)
        self.assertEqual(stat.S_IMODE(self.work.stat().st_mode), 0o755)
        os.chmod(self.work, 0o700)
        request = {**base, 'mode': 'download'}
        with patch.object(p, 'download', return_value={'status': 'ready'}):
            self.assertEqual(p.execute(request)['status'], 'ready')
        cache = self.work / '1.2.3-1234-77'
        (cache / 'artifact.zip.part').write_bytes(self.archive.read_bytes())
        with patch.object(p, 'publish', return_value={'status': 'published'}):
            self.assertEqual(p.execute({**request, 'mode': 'publish'})['status'], 'published')
        with patch.object(p, 'download', return_value={'status': 'ready'}):
            self.assertEqual(p.execute(request)['status'], 'ready')
        with self.assertRaisesRegex(p.ReleaseError, 'identity changed'):
            p.execute({**request, 'archiveSha256': 'b' * 64})
        with p.release_lock(self.work / 'test.lock'):
            with self.assertRaisesRegex(p.ReleaseError, 'another'):
                with p.release_lock(self.work / 'test.lock'):
                    self.fail('lock accepted')

    def test_public_checks_download_hashes_and_exact_manifests(self):
        resources = {p.FEED + name: data for name, data in self.files.items() if name in p.POINTERS}
        for item in self.plan['downloads']:
            resources[p.FEED + item['url']] = self.files['artifacts/' + Path(item['url']).name]
        for item in self.plan['connectorArtifacts']:
            resources[p.FEED + 'connector-assets/' + item['name']] = self.files['connector-assets/' + item['name']]
        def fetch(url):
            return io.BytesIO(resources[url])
        with p.extracted_bundle(self.archive, self.work, self.request) as (payload, plan):
            p.verify_public(plan, payload, fetch)
            resources[p.FEED + 'client-release.json'] = b'old website catalog'
            with self.assertRaisesRegex(p.ReleaseError, 'manifest mismatch'):
                p.verify_public(plan, payload, fetch)
            resources[p.FEED + 'client-release.json'] = self.files['client-release.json']
            resources[p.FEED + plan['downloads'][0]['url']] = b'wrong'
            with self.assertRaises(p.ReleaseError):
                p.verify_public(plan, payload, fetch)

    def test_missing_or_stale_website_catalog_rejected_before_publication(self):
        original = self.files['client-release.json']
        for data in [b'{}', original.replace(b'1.2.3', b'1.2.2'), original.replace(b'sep.longdaoec.com', b'bad.longdaoec.com')]:
            self.files['client-release.json'] = data
            entry = next(item for item in self.plan['manifests'] if item['name'] == 'client-release.json')
            entry.update(size=len(data), sha256=hashlib.sha256(data).hexdigest())
            self.make_archive()
            with self.assertRaisesRegex(p.ReleaseError, 'catalog'):
                self.publish()
            self.assertFalse((self.root / '1.2.3').exists())
        self.plan['manifests'] = [item for item in self.plan['manifests'] if item['name'] != 'client-release.json']
        self.make_archive()
        with self.assertRaisesRegex(p.ReleaseError, 'incomplete manifest'):
            self.publish()

    def test_first_website_catalog_is_removed_on_failed_publication(self):
        (self.root / 'client-release.json').unlink()
        def fail(*_):
            raise p.ReleaseError('verification failed')
        with self.assertRaises(p.ReleaseError):
            self.publish(fail)
        self.assertFalse((self.root / 'client-release.json').exists())

    def test_third_pointer_write_failure_restores_both_ymls_and_old_catalog(self):
        write = p.write_atomic
        failed = False
        def fail_once(path, data, mode=0o600):
            nonlocal failed
            if path == self.root / 'client-release.json' and not failed:
                failed = True
                raise OSError('injected third-pointer write failure')
            return write(path, data, mode)
        with patch.object(p, 'write_atomic', side_effect=fail_once):
            with self.assertRaisesRegex(OSError, 'third-pointer'):
                self.publish()
        for name in p.POINTERS:
            self.assertEqual((self.root / name).read_bytes(), b'version: 1.2.2\n')

    def test_ssh_verification_checks_all_pointers_and_three_website_downloads(self):
        with p.extracted_bundle(self.archive, self.work, self.request) as (payload, plan):
            calls = []
            def fetch(url, method='GET'):
                calls.append((url, method))
                response = io.BytesIO(self.files[url.removeprefix(p.FEED)] if method == 'GET' else b'')
                name = url.split('/')[-1]
                response.headers = {'Content-Length': str(next((item['size'] for item in plan['artifacts'] if item['name'] == name), 0))}
                return response
            with patch.object(p, 'open_public', side_effect=fetch):
                p.verify_ssh_public(plan, payload)
            self.assertEqual(len(calls), 6)
            self.assertEqual(sum(method == 'HEAD' for _, method in calls), 3)
            with patch.object(p, 'open_public', return_value=io.BytesIO(b'old')):
                with self.assertRaisesRegex(p.ReleaseError, 'metadata mismatch'):
                    p.verify_ssh_public(plan, payload)
            def wrong_size(url, method='GET'):
                response = fetch(url, method)
                response.headers['Content-Length'] = '1'
                return response
            with patch.object(p, 'open_public', side_effect=wrong_size):
                with self.assertRaisesRegex(p.ReleaseError, 'size mismatch'):
                    p.precheck_website_downloads(plan, payload)


if __name__ == '__main__':
    unittest.main()
