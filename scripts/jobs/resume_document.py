"""Stage a private customized document for the existing résumé compiler."""
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path

from files import CurrentContactRequired, render_resume, save_private, summary_span


HEADER = '# {{fullName}}\n\n{{contact}}\n\n'


def render_custom(config_path, work_path, output):
    config = json.loads(Path(config_path).read_text())
    work = json.loads(Path(work_path).read_text())
    document = work['resumeMarkdown']
    if not document.startswith(HEADER) or len(document) > 48_000:
        raise ValueError('invalid_resume_document')
    body = document[len(HEADER):]
    # Reject raw HTML and Markdown constructs that load external resources.
    if re.search(r'[<>]|!\s*\[|\{\{|\}\}|\{:[^}]*\}|&(?!lt;|gt;)(?:#(?:x[\da-f]+|\d+)|[a-z]+);|\b(?:file|javascript|vbscript|data):', body, re.I):
        raise ValueError('invalid_resume_document')
    source_path = Path(config['resumePaths'][work['resumeTrack']])
    source = source_path.read_text()
    source_summary = re.search(r'^## Summary[ \t]*\n', source, re.M)
    if not source_summary:
        raise ValueError('invalid_resume_document')
    start, end = summary_span(body, allow_last=True)
    if body[start:end].strip() != work['summary']:
        raise ValueError('invalid_resume_summary')
    output = Path(output)
    with tempfile.TemporaryDirectory(prefix='custom-resume-', dir=output.parent) as directory:
        custom_source = Path(directory) / source_path.name
        custom_source.write_text(source[:source_summary.start()] + body)
        os.chmod(custom_source, 0o600)
        staged = Path(directory) / 'config.json'
        save_private(staged, {
            **config,
            'resumePaths': {**config['resumePaths'], work['resumeTrack']: str(custom_source)},
            'rendererPath': config.get('rendererPath') or str(source_path.parent / 'render_resumes.py'),
        })
        render_resume(staged, work_path, output, custom_document=True)
    manifest_path = output.with_suffix('.manifest.json')
    manifest = json.loads(manifest_path.read_text())
    manifest['templateSha256'] = hashlib.sha256(source.encode()).hexdigest()
    save_private(manifest_path, manifest)
    saved_work = output.with_suffix('.work.json')
    save_private(saved_work, {**json.loads(saved_work.read_text()), 'resumeMarkdown': document})


if __name__ == '__main__':
    try:
        render_custom(*sys.argv[1:])
    except CurrentContactRequired as error:
        print(json.dumps({'error': str(error), 'fields': error.fields}))
        sys.exit(1)
    except Exception:
        sys.exit(1)
