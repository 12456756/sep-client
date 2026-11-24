"""Dependency-free download-server worker, invoked over authenticated SSH stdin."""

import base64
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit
from urllib.request import build_opener, HTTPRedirectHandler, Request
import zipfile

FEED = 'https://sep.longdaoec.com/sep-client/stable/'
MANIFESTS = ['latest.yml', 'latest-mac.yml']
POINTERS = MANIFESTS + ['client-release.json']
CANCELLED = threading.Event()
MAX_ARCHIVE = 8 * 1024 ** 3


class ReleaseError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise ReleaseError(message)


def check_active():
    require(not CANCELLED.is_set(), 'release cancelled or SSH heartbeat lost')


def regular(path, size=None):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_size > 0, 'unsafe or empty release file')
    if size is not None:
        require(info.st_size == size, 'release file size mismatch')


def directory(path):
    require(path.is_absolute() and path.resolve() == path and not path.is_symlink() and path.is_dir(), 'unsafe release directory')


def file_hash(path, algorithm='sha256'):
    digest = hashlib.new(algorithm)
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            check_active()
            digest.update(chunk)
    return digest.hexdigest()


def verify_file(path, item):
    regular(path, item['size'])
    require(file_hash(path) == item['sha256'], 'release file checksum mismatch')


def write_atomic(path, data, mode=0o600):
    descriptor, temporary = tempfile.mkstemp(prefix='.sep-write-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def validate_url(value):
    require(isinstance(value, str) and not any(c.isspace() or ord(c) < 32 or c in '\\"' for c in value), 'invalid artifact download URL')
    url = urlsplit(value)
    require(url.scheme == 'https' and not url.username and not url.password and not url.fragment and url.port in (None, 443), 'invalid artifact download URL')
    require(bool(url.hostname) and url.hostname.endswith(('.blob.core.windows.net', '.actions.githubusercontent.com')), 'invalid artifact download URL')


def validate_plan(plan, request):
    require(isinstance(plan, dict) and plan.get('schemaVersion') == 1 and plan.get('channel') == 'stable' and plan.get('feed') == FEED, 'invalid release plan')
    for key in ['version', 'runId', 'runAttempt', 'commit']:
        require(plan.get(key) == request[key], 'release identity mismatch')
    version = plan['version']
    require(bool(re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', version)), 'invalid stable version')
    expected = {f'SEP-Client-{version}-{platform}.{ext}{suffix}' for platform, extensions in [('win-x64', ['exe']), ('mac-arm64', ['dmg', 'zip']), ('mac-x64', ['dmg', 'zip'])] for ext in extensions for suffix in ['', '.blockmap']}
    artifacts = plan.get('artifacts', [])
    require(len(artifacts) == 10 and {item['name'] for item in artifacts} == expected, 'incomplete installer set')
    connectors = plan.get('connectorArtifacts', [])
    require(len(connectors) == 9, 'incomplete connector set')
    targets = set()
    for item in connectors:
        match = re.fullmatch(r'(dingtalk|feishu|wecom)-\d+\.\d+\.\d+-(win32-x64|darwin-x64|darwin-arm64)-([a-f0-9]{64})\.zip', item['name'])
        require(match is not None and match[3] == item['sha256'], 'invalid connector name')
        targets.add((match[1], match[2]))
    require(len(targets) == 9, 'duplicate connector target')
    manifests = plan.get('manifests', [])
    require(len(manifests) == 3 and {item['name'] for item in manifests} == set(POINTERS), 'incomplete manifest set')
    records = {'server-pull-plan.json': None}
    for prefix, items in [('artifacts/', artifacts), ('connector-assets/', connectors), ('', manifests)]:
        for item in items:
            require(isinstance(item['name'], str) and re.fullmatch(r'[A-Za-z0-9.-]+', item['name']), 'unsafe release name')
            require(type(item['size']) is int and 0 < item['size'] <= MAX_ARCHIVE, 'invalid release file size')
            require(re.fullmatch(r'[a-f0-9]{64}', item['sha256']) is not None, 'invalid release file checksum')
            if prefix == 'artifacts/':
                require(item.get('destination') == f'{version}/{item["name"]}' and item.get('url') == FEED + item['destination'], 'invalid artifact destination')
            records[prefix + item['name']] = item
    downloads = plan.get('downloads', [])
    expected_downloads = {f'{version}/{name}' for name in expected if not name.endswith('.blockmap')}
    require(len(downloads) == 5 and {item['url'] for item in downloads} == expected_downloads, 'incomplete public download set')
    for item in downloads:
        require(isinstance(item['sha512'], str) and re.fullmatch(r'[A-Za-z0-9+/]{86}==', item['sha512']) and len(base64.b64decode(item['sha512'], validate=True)) == 64, 'invalid public checksum')
        require(item['size'] == records['artifacts/' + item['url'].split('/')[-1]]['size'], 'public size mismatch')
    return records


@contextmanager
def extracted_bundle(archive, work, request):
    regular(archive, request['archiveSize'])
    require(file_hash(archive) == request['archiveSha256'], 'artifact archive checksum mismatch')
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        require(len(entries) <= 30 and len({entry.filename for entry in entries}) == len(entries), 'duplicate or excessive archive entries')
        info = bundle.getinfo('server-pull-plan.json')
        require(0 < info.file_size <= 1024 * 1024, 'invalid release plan size')
        data = bundle.read(info)
        require(hashlib.sha256(data).hexdigest() == request['planSha256'], 'release plan checksum mismatch')
        plan = json.loads(data)
        records = validate_plan(plan, request)
        files = set()
        for entry in entries:
            mode = entry.external_attr >> 16
            if entry.is_dir():
                require(entry.filename in ('artifacts/', 'connector-assets/'), 'unsafe archive directory')
                require(stat.S_IFMT(mode) in (0, stat.S_IFDIR), 'unsafe archive directory type')
                continue
            require(stat.S_IFMT(mode) in (0, stat.S_IFREG), 'unsafe archive file type')
            require(entry.filename in records and not entry.flag_bits & 1, 'unsafe archive path or encrypted file')
            if records[entry.filename] is not None:
                require(entry.file_size == records[entry.filename]['size'], 'archive file size mismatch')
            files.add(entry.filename)
        require(files == set(records), 'incomplete release archive')
        required = sum(entry.file_size for entry in entries)
        require(shutil.disk_usage(work).free > required + 64 * 1024 ** 2, 'insufficient private release disk space')
        with tempfile.TemporaryDirectory(prefix='payload-', dir=work) as temporary:
            payload = Path(temporary)
            for name, item in records.items():
                check_active()
                if item is None:
                    continue
                path = payload / name
                path.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(name) as source, path.open('xb') as output:
                    for chunk in iter(lambda: source.read(1024 * 1024), b''):
                        check_active()
                        output.write(chunk)
                verify_file(path, item)
            validate_client_release((payload / 'client-release.json').read_bytes(), plan)
            yield payload, plan


def run_curl(args, config):
    with subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, text=True) as process:
        process.stdin.write(config)
        process.stdin.close()
        try:
            while process.poll() is None:
                check_active()
                time.sleep(0.25)
            return process.returncode
        except BaseException:
            process.terminate()
            process.wait(timeout=10)
            raise


def download(work, request):
    part = work / 'artifact.zip.part'
    if part.exists() or part.is_symlink():
        require(not part.is_symlink() and part.is_file(), 'unsafe download cache')
        size = part.stat().st_size
        if size == request['archiveSize'] and file_hash(part) == request['archiveSha256']:
            return {'status': 'ready'}
        if size >= request['archiveSize']:
            part.write_bytes(b'')
    validate_url(request['url'])
    args = ['curl', '--config', '-', '--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--continue-at', '-', '--connect-timeout', '20', '--max-time', '300', '--speed-time', '45', '--speed-limit', '16384', '--max-filesize', str(request['archiveSize']), '--output', str(part)]
    code = run_curl(args, 'url = ' + json.dumps(request['url']) + '\n')
    if code:
        if code == 33:
            part.write_bytes(b'')
        return {'status': 'retry', 'curlExitCode': code}
    regular(part, request['archiveSize'])
    if file_hash(part) != request['archiveSha256']:
        part.write_bytes(b'')
        return {'status': 'retry', 'reason': 'archive checksum mismatch'}
    return {'status': 'ready'}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise ReleaseError('unexpected public download redirect')


def open_public(url, method='GET'):
    require(url.startswith(FEED), 'invalid public release URL')
    response = build_opener(NoRedirect).open(Request(url, headers={'Accept-Encoding': 'identity'}, method=method), timeout=30)
    require(response.status == 200 and response.headers.get('Content-Encoding', 'identity') == 'identity', 'invalid public download response')
    return response


def precheck_public(plan):
    paths = [(item['url'], item['size']) for item in plan['downloads']]
    paths += [('connector-assets/' + item['name'], item['size']) for item in plan['connectorArtifacts']]
    for path, size in paths:
        check_active()
        with open_public(FEED + path, 'HEAD') as response:
            require(response.headers.get('Content-Length') == str(size), 'public file missing or size mismatch before manifest switch')
    print('All public release files reachable before manifest switch', flush=True)


def validate_client_release(data, plan):
    require(len(data) <= 65536, 'oversized website catalog')
    try:
        value = json.loads(data)
    except (ValueError, UnicodeError):
        raise ReleaseError('invalid website catalog JSON') from None
    version = plan['version']
    expected = []
    for platform, suffix, label, architecture, minimum in [
        ('macos-arm64', 'mac-arm64.dmg', 'macOS · Apple 芯片', 'ARM64', 'macOS 12 或更高版本'),
        ('macos-x64', 'mac-x64.dmg', 'macOS · Intel 芯片', 'x64', 'macOS 12 或更高版本'),
        ('windows-x64', 'win-x64.exe', 'Windows · 64 位', 'x64', 'Windows 10 64 位或更高版本'),
    ]:
        name = f'SEP-Client-{version}-{suffix}'
        url = FEED + version + '/' + name
        require(any(item['name'] == name and item['url'] == url for item in plan['artifacts']), 'website installer differs from verified plan')
        expected.append(dict(platform=platform, label=label, fileName=name, url=url, architecture=architecture, minimumOsVersion=minimum))
    require(value == dict(version=version, artifacts=expected), 'website catalog differs from verified plan')
    return value


def precheck_website_downloads(plan, payload):
    catalog = validate_client_release((payload / 'client-release.json').read_bytes(), plan)
    sizes = {item['name']: item['size'] for item in plan['artifacts']}
    for item in catalog['artifacts']:
        with open_public(item['url'], 'HEAD') as response:
            require(response.headers.get('Content-Length') == str(sizes[item['fileName']]), 'website installer missing or size mismatch')


def verify_ssh_public(plan, payload):
    for name in POINTERS:
        with open_public(FEED + name) as response:
            require(response.read(1024 * 1024 + 1) == (payload / name).read_bytes(), 'public release metadata mismatch')
    precheck_website_downloads(plan, payload)


def verify_public(plan, payload, fetch=open_public):
    for name in POINTERS:
        with fetch(FEED + name) as response:
            require(response.read(1024 * 1024 + 1) == (payload / name).read_bytes(), 'public manifest mismatch')
    items = [(item, item['url'], 'sha512', base64.b64decode(item['sha512']).hex()) for item in plan['downloads']]
    items += [(item, 'connector-assets/' + item['name'], 'sha256', item['sha256']) for item in plan['connectorArtifacts']]
    for item, path, algorithm, expected in items:
        check_active()
        deadline = time.monotonic() + 120
        digest, size = hashlib.new(algorithm), 0
        with fetch(FEED + path) as response:
            for chunk in iter(lambda: response.read(1024 * 1024), b''):
                check_active()
                require(time.monotonic() < deadline, 'public verification timed out')
                size += len(chunk)
                require(size <= item['size'], 'public download size mismatch')
                digest.update(chunk)
        require(size == item['size'] and digest.hexdigest() == expected, 'public download size or checksum mismatch')
        print('Verified public download: ' + path, flush=True)


def manifest_snapshot(root):
    result = {}
    for name in POINTERS:
        path = root / name
        if path.exists() or path.is_symlink():
            regular(path)
            require(path.stat().st_size <= 1024 * 1024, 'oversized production manifest')
            result[name] = path.read_bytes()
        else:
            result[name] = None
    return result


def publish(payload, plan, root, work, verify=verify_public, precheck=precheck_public):
    directory(root)
    directory(work)
    target = root / plan['version']
    state_path = work / 'transaction.json'
    identity = {key: plan[key] for key in ['version', 'runId', 'runAttempt', 'commit']}
    if state_path.exists():
        regular(state_path)
        state = json.loads(state_path.read_bytes())
        require(state['identity'] == identity, 'publication transaction identity changed')
        before = {name: None if value is None else base64.b64decode(value, validate=True) for name, value in state['before'].items()}
    else:
        require(not target.exists() and not target.is_symlink(), 'version directory already exists')
        before = manifest_snapshot(root)
        backup = work / 'previous-manifests'
        backup.mkdir(mode=0o700, exist_ok=True)
        directory(backup)
        for name, data in before.items():
            if data is not None:
                write_atomic(backup / name, data)
        state = dict(identity=identity, before={name: None if data is None else base64.b64encode(data).decode() for name, data in before.items()})
        write_atomic(state_path, json.dumps(state).encode())
    desired = {name: (payload / name).read_bytes() for name in POINTERS}
    current = manifest_snapshot(root)
    for name, data in current.items():
        require(data in (before[name], desired[name]), 'production manifest changed; refusing overwrite')
    if (work / 'success.json').exists():
        require(current == desired, 'a completed release is no longer current; refusing republish')
        verify(plan, payload)
        return {'status': 'published', 'version': plan['version'], 'verifiedInstallers': 5, 'verifiedComponents': 9}
    components = root / 'connector-assets'
    components.mkdir(mode=0o755, exist_ok=True)
    directory(components)
    for item in plan['connectorArtifacts']:
        destination = components / item['name']
        if destination.exists() or destination.is_symlink():
            verify_file(destination, item)
        else:
            # A hard link publishes a complete immutable component without replacing an existing one.
            with tempfile.TemporaryDirectory(prefix='.sep-component-', dir=root) as temporary:
                pending = Path(temporary) / item['name']
                shutil.copyfile(payload / 'connector-assets' / item['name'], pending)
                os.chmod(pending, 0o644)
                verify_file(pending, item)
                os.link(pending, destination)
    check_active()
    if target.exists() or target.is_symlink():
        directory(target)
        require({entry.name for entry in target.iterdir()} == {item['name'] for item in plan['artifacts']}, 'existing version directory changed')
        for item in plan['artifacts']:
            verify_file(target / item['name'], item)
    else:
        require(shutil.disk_usage(root).free > sum(item['size'] for item in plan['artifacts']) + 64 * 1024 ** 2, 'insufficient publication disk space')
        with tempfile.TemporaryDirectory(prefix='.sep-version-', dir=root) as temporary:
            stage = Path(temporary) / plan['version']
            stage.mkdir(mode=0o755)
            for item in plan['artifacts']:
                check_active()
                path = stage / item['name']
                shutil.copyfile(payload / 'artifacts' / item['name'], path)
                os.chmod(path, 0o644)
                verify_file(path, item)
            os.rename(stage, target)
    check_active()
    precheck(plan)
    check_active()
    for name, data in manifest_snapshot(root).items():
        require(data in (before[name], desired[name]), 'production manifest changed before switching')
    switched = False
    try:
        switched = True
        for name in POINTERS:
            check_active()
            write_atomic(root / name, desired[name], 0o644)
        print('Update manifests switched; verifying public downloads', flush=True)
        verify(plan, payload)
        check_active()
        write_atomic(work / 'success.json', json.dumps(dict(identity=identity, publishedAt=time.time(), method='server-pull', verifiedInstallers=5, verifiedComponents=9)).encode())
    except BaseException:
        if switched:
            # Rollback does not consult the cancellation flag: it must finish after cancellation.
            for name, current in manifest_snapshot(root).items():
                require(current in (before[name], desired[name]), 'production changed during rollback; manual inspection required')
            for name, data in before.items():
                if data is None:
                    (root / name).unlink(missing_ok=True)
                else:
                    write_atomic(root / name, data, 0o644)
            print('Restored previous update manifests', flush=True)
        raise
    return {'status': 'published', 'version': plan['version'], 'verifiedInstallers': 5, 'verifiedComponents': 9}


@contextmanager
def release_lock(path):
    import fcntl
    require(not path.is_symlink(), 'unsafe release lock')
    with path.open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ReleaseError('another server-pull release is active') from None
        yield


def execute(request):
    require(sys.version_info >= (3, 10) and os.name == 'posix', 'server requires Linux Python 3.10 or later')
    root, private = Path(request['root']), Path(request['workRoot'])
    directory(root)
    require(str(root) != '/' and private.is_absolute() and private.resolve() == private and not private.is_symlink(), 'unsafe private release path')
    require(private != root and root not in private.parents and private not in root.parents, 'private release files must be outside the public directory')
    require(re.fullmatch(r'\d+\.\d+\.\d+', request['version']), 'invalid release version')
    require(shutil.which('curl') is not None and os.access(root, os.W_OK), 'curl or publication write permission unavailable')
    private.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory(private)
    require(private.stat().st_mode & 0o077 == 0 and private.stat().st_uid == os.geteuid(), 'private release directory must be owned by the SSH user with mode 700')
    if request['mode'] == 'preflight':
        require(not (root / request['version']).exists(), 'version directory already exists')
        require(shutil.disk_usage(private).free >= 8 * 1024 ** 3 and shutil.disk_usage(root).free >= 4 * 1024 ** 3, 'insufficient release disk space')
        return {'status': 'ready', 'python': sys.version.split()[0]}
    for key in ['runId', 'runAttempt', 'artifactId']:
        require(re.fullmatch(r'[1-9]\d*', request[key]), 'invalid release identity')
    require(re.fullmatch(r'[a-f0-9]{40}', request['commit']) is not None, 'invalid release commit')
    require(type(request['archiveSize']) is int and 0 < request['archiveSize'] <= MAX_ARCHIVE, 'invalid archive size')
    require(all(re.fullmatch(r'[a-f0-9]{64}', request[key]) for key in ['archiveSha256', 'planSha256']), 'invalid archive checksum')
    work = private / f"{request['version']}-{request['runId']}-{request['artifactId']}"
    work.mkdir(mode=0o700, exist_ok=True)
    directory(work)
    require(work.stat().st_mode & 0o077 == 0 and work.stat().st_uid == os.geteuid(), 'unsafe private download cache permissions')
    identity = {key: request[key] for key in ['root', 'version', 'runId', 'runAttempt', 'commit', 'artifactId', 'archiveSize', 'archiveSha256', 'planSha256']}
    with release_lock(private / 'publish.lock'):
        marker = work / 'identity.json'
        if marker.exists():
            regular(marker)
            require(json.loads(marker.read_bytes()) == identity, 'download cache identity changed')
        else:
            write_atomic(marker, json.dumps(identity).encode())
        if request['mode'] == 'download':
            return download(work, request)
        require(request['mode'] == 'publish', 'unknown server release mode')
        with extracted_bundle(work / 'artifact.zip.part', work, request) as (payload, plan):
            return publish(payload, plan, root, work)


def supervise(request):
    # EOF or a missing heartbeat means Actions was cancelled or its SSH route disconnected.
    last_heartbeat = [time.monotonic()]

    def heartbeat():
        while sys.stdin.readline():
            last_heartbeat[0] = time.monotonic()
        CANCELLED.set()

    def watchdog():
        while not CANCELLED.wait(5):
            if time.monotonic() - last_heartbeat[0] > 45:
                CANCELLED.set()

    def stop(_signum, _frame):
        CANCELLED.set()

    for sig in [signal.SIGTERM, signal.SIGINT, signal.SIGHUP]:
        signal.signal(sig, stop)
    threading.Thread(target=heartbeat, daemon=True).start()
    threading.Thread(target=watchdog, daemon=True).start()
    try:
        result = execute(request)
        print('SEP_RELEASE_RESULT=' + json.dumps(result), flush=True)
    except Exception as error:
        message = str(error) if isinstance(error, ReleaseError) else type(error).__name__
        print('Server release failed: ' + message, file=sys.stderr, flush=True)
        sys.exit(1)
