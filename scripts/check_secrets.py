"""Reject Hugging Face credentials and private build material in tracked files."""

import re
import subprocess
from pathlib import Path


def credential_risk(name, content):
    if '.private/' in name or '.app/' in name or name.endswith('.dmg') or (name.endswith('.zip') and 'private' in Path(name).name.lower()):
        return 'private build material'
    if re.search(rb'hf_[A-Za-z0-9]{20,}', content):
        return 'possible credential'
    return None


def main():
    root = Path(__file__).resolve().parent.parent
    files = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).split(b'\0')
    findings = []
    for raw in files:
        if not raw:
            continue
        name = raw.decode('utf-8')
        path = root / name
        risk = credential_risk(name, path.read_bytes() if path.is_file() else b'')
        if risk:
            findings.append(name + ' (' + risk + ')')
    if findings:
        # Report file names only; never print credential matches.
        raise SystemExit('Do not publish these files:\n' + '\n'.join(findings))
    print('Secret check passed: no Hugging Face tokens or private build material in tracked files.')


if __name__ == '__main__':
    main()
