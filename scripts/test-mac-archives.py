"""Regression: sign native code inside nested archives and maintain wheel hashes."""
import base64
import csv
import hashlib
import importlib.util
import io
from pathlib import Path
import subprocess
import tempfile
import zipfile

spec = importlib.util.spec_from_file_location('mac_archives', Path(__file__).with_name('sign-mac-archives.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def zipped(entries):
    data = io.BytesIO()
    with zipfile.ZipFile(data, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in entries.items():
            archive.writestr(name, content)
            archive.getinfo(name).external_attr = 0
    return data.getvalue()


with tempfile.TemporaryDirectory(prefix='nova-sign-test-') as directory:
    root = Path(directory)
    source = root / 'fixture.c'
    source.write_text('int nova_archive_fixture(void) { return 42; }\n')
    binary = root / 'fixture.dylib'
    subprocess.run(['xcrun', 'clang', '-dynamiclib', str(source), '-o', str(binary)], check=True)
    unsigned = binary.read_bytes()
    bundle = root / 'bundle'
    bundle.mkdir()
    java_class = bytes.fromhex('cafebabe0000003d') + b'class fixture'
    jar = zipped({'native/libfixture.dylib': unsigned, 'Fixture.class': java_class, 'LICENSE': b'retained notice'})
    (bundle / 'extension.zip').write_bytes(zipped({'lib/engine.jar': jar, '../not-extracted.txt': b'kept inside zip'}))
    record = 'module.so,sha256=stale,1\nfixture.dist-info/RECORD,,\n'
    (bundle / 'fixture.whl').write_bytes(zipped({'module.so': unsigned, 'fixture.dist-info/RECORD': record}))
    plain = zipped({'Fixture.class': java_class, 'LICENSE': b'retained notice'})
    (bundle / 'plain.jar').write_bytes(plain)
    result = module.sign_archives(bundle, '-')
    assert len(result['signedNativeMembers']) == 2
    assert len(result['repackedArchives']) == 3
    assert not (root / 'not-extracted.txt').exists()
    assert (bundle / 'plain.jar').read_bytes() == plain
    with zipfile.ZipFile(bundle / 'extension.zip') as outer, zipfile.ZipFile(io.BytesIO(outer.read('lib/engine.jar'))) as inner:
        assert inner.read('LICENSE') == b'retained notice'
        assert inner.getinfo('LICENSE').external_attr == 0
        assert inner.read('Fixture.class') == java_class
        binary.write_bytes(inner.read('native/libfixture.dylib'))
        subprocess.run(['codesign', '--verify', '--strict', str(binary)], check=True)
    with zipfile.ZipFile(bundle / 'fixture.whl') as wheel:
        content = wheel.read('module.so')
        rows = list(csv.reader(io.StringIO(wheel.read('fixture.dist-info/RECORD').decode())))
        assert rows[0] == ['module.so', 'sha256=' + base64.urlsafe_b64encode(hashlib.sha256(content).digest()).decode().rstrip('='), str(len(content))]
        binary.write_bytes(content)
        subprocess.run(['codesign', '--verify', '--strict', str(binary)], check=True)
    protected = root / 'protected'
    protected.mkdir()
    signed_jar = zipped({'libfixture.dylib': unsigned, 'META-INF/UPSTREAM.SF': b'existing Java signature'})
    (protected / 'signed.jar').write_bytes(signed_jar)
    try:
        module.sign_archives(protected, '-')
        raise AssertionError('Signed Java archive should require explicit handling')
    except RuntimeError as error:
        assert 'Java signature' in str(error)
    assert (protected / 'signed.jar').read_bytes() == signed_jar
print('PASS nested archive signing, wheel integrity, notices, unchanged Java classes, and signed-JAR protection')
