import io
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
import urllib.request
from unittest.mock import patch

from application_links import application_links, LINKS_URL


CATALOG = {
    'schemaVersion': 1,
    'project': [{'key': 'rbc-demo', 'description': 'Synthetic demo'}],
    'profile': [{'key': 'github', 'description': 'Synthetic profile'}],
    'variant': [{'key': 'backend', 'description': 'Synthetic track'}],
    'destinations': [
        {'key': None, 'sourceUrls': ['https://girke.dev', 'https://girke.dev/', 'https://luigigirke.com', 'https://luigigirke.com/']},
        {'key': 'github', 'sourceUrls': ['https://github.com/example-owner']},
        {'key': 'rbc-demo', 'sourceUrls': ['https://demo.example.org/']},
    ],
}
REGISTRY = 'https://registry.example.org/api/v1/tracked-links/applications'
CODE = 'k3Vw9QpX2nR7tLzA'
TOKEN = 'x' * 40


class ApplicationLinksTests(unittest.TestCase):
    def setUp(self):
        self.config = {'applicationTracking': {'url': LINKS_URL, 'registryUrl': REGISTRY, 'token': TOKEN}}
        self.work = {'applicationId': '1a7dfb42-6971-42ea-8df2-e96ea2ce7331', 'company': 'Example', 'role': 'Developer',
                     'resumeTrack': 'engineering', 'revision': 1, 'summary': 'Reviewed summary.',
                     'sourceUrl': 'https://jobs.example.org/posting'}
        self.catalog = CATALOG
        self.result = {'code': CODE}
        self.seen = []

    def request(self, req, timeout):
        self.seen.append(req)
        payload = self.catalog if req.full_url == LINKS_URL else self.result
        return io.BytesIO(json.dumps(payload).encode())

    def test_catalog_get_and_one_direct_registration_produce_flat_links(self):
        base = f'https://girke.dev/r/{CODE}'
        self.assertEqual(application_links(self.config, self.work, request=self.request), {
            'https://girke.dev': base,
            'https://girke.dev/': base,
            'https://luigigirke.com': base,
            'https://luigigirke.com/': base,
            'https://github.com/example-owner': base + '/github',
            'https://demo.example.org/': base + '/rbc-demo',
        })
        catalog, register = self.seen
        self.assertEqual((catalog.full_url, catalog.get_method(), catalog.get_header('X-api-key')), (LINKS_URL, 'GET', None))
        self.assertEqual((register.full_url, register.get_method(), register.get_header('X-api-key')), (REGISTRY, 'POST', TOKEN))
        self.assertEqual(json.loads(register.data), dict(applicationId=self.work['applicationId'], track='backend',
                                                         company='Example', role='Developer', revision=1))

    def test_migrated_codes_get_flat_links_and_malformed_codes_fail(self):
        self.result = {'code': 'a' * 24}
        self.assertEqual(application_links(self.config, self.work, request=self.request)['https://demo.example.org/'],
                         'https://girke.dev/r/' + 'a' * 24 + '/rbc-demo')
        for code in ('x', 'https://evil.example/', CODE + '/demo', CODE + '\n'):
            self.result = {'code': code}
            with self.assertRaisesRegex(ValueError, '^application_tracking_registration_failed$'):
                application_links(self.config, self.work, request=self.request)

    def test_invalid_catalog_stops_before_registration(self):
        for destinations in (
            [{'key': 'home', 'sourceUrls': ['https://luigigirke.com']}],
            [*CATALOG['destinations'], {'key': 'project/rbc', 'sourceUrls': ['https://example.org/']}],
            [*CATALOG['destinations'], {'key': 'other', 'sourceUrls': ['https://demo.example.org/']}],
            [*CATALOG['destinations'], {'key': 'github', 'sourceUrls': ['https://other.example.org/']}],
        ):
            self.catalog = {**CATALOG, 'destinations': destinations}
            self.seen.clear()
            with self.assertRaisesRegex(ValueError, '^application_tracking_catalog_unavailable$'):
                application_links(self.config, self.work, request=self.request)
            self.assertEqual([req.get_method() for req in self.seen], ['GET'])

    def test_rejects_the_wrong_endpoints(self):
        settings = self.config['applicationTracking']
        for url in ('https://user@example.org/api/v1/tracked-links/applications',
                    'http://registry.example.org/api/v1/tracked-links/applications',
                    'https://registry.example.org/website-analytics/applications/registry',
                    REGISTRY + '?token=other'):
            settings['registryUrl'] = url
            with self.assertRaises(ValueError):
                application_links(self.config, self.work, request=self.request)
        settings.update(registryUrl=REGISTRY, url='https://evil.example/links')
        with self.assertRaises(ValueError):
            application_links(self.config, self.work, request=self.request)
        self.assertFalse(self.seen)

    @unittest.skipUnless(os.environ.get('QS302_TEST_RESUME_RENDERER'), 'requires the local résumé compiler and PDF runtime')
    def test_rendered_pdf_contains_only_registered_links_and_reuses_the_code(self):
        from pypdf import PdfReader
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'jobs'))
        from files import render_resume

        registry_url = os.environ.get('QS302_TEST_REGISTRY_URL')
        if registry_url:
            self.assertRegex(registry_url, r'^http://127\.0\.0\.1:[0-9]+/api/v1/tracked-links/applications$')
            self.config['applicationTracking']['registryUrl'] = registry_url
        registry_open = urllib.request.build_opener().open

        def fetch(req, timeout):
            self.seen.append(req)
            if req.full_url == LINKS_URL:
                return io.BytesIO(json.dumps(CATALOG).encode())
            if registry_url:
                return registry_open(req, timeout=timeout)
            return io.BytesIO(json.dumps({'code': CODE}).encode())

        with TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'Synthetic-Resume.md'
            source.write_text('# Luigi Girke\n\n[Portfolio](https://luigigirke.com) | '
                              '[GitHub](https://github.com/example-owner)\n\n## Summary\n\n'
                              'Draft summary.\n\n## Projects\n\n[Demo](https://demo.example.org/)\n')
            config_file = root / 'config.json'
            config_file.write_text(json.dumps({**self.config, 'resumePaths': {'engineering': str(source)},
                                               'rendererPath': os.environ['QS302_TEST_RESUME_RENDERER']}))
            work_file = root / 'work.json'
            work_file.write_text(json.dumps(self.work))
            with patch('application_links.urllib.request.build_opener') as opener:
                opener.return_value.open = fetch
                targets = []
                for version in ('first', 'retry'):
                    output = root / f'{version}.pdf'
                    render_resume(config_file, work_file, output, custom_document=True)
                    targets.append({
                        action['/URI'] for page in PdfReader(output).pages for ref in page.annotations or []
                        if (action := ref.get_object().get('/A')) and action.get('/S') == '/URI'
                    })

                with source.open('a') as file:
                    file.write('\n[Unknown](https://outside.example.org/)\n')
                with self.assertRaisesRegex(ValueError, '^pdf_tracking_verification_failed$'):
                    render_resume(config_file, work_file, root / 'rejected.pdf', custom_document=True)
                self.assertFalse((root / 'rejected.pdf').exists())

        root_link, = (url for url in targets[0] if url.count('/') == 4)
        self.assertRegex(root_link, r'^https://girke\.dev/r/[A-Za-z0-9]{16}$')
        self.assertEqual(targets, [{root_link, root_link + '/github', root_link + '/rbc-demo'}] * 2)
        self.assertEqual([req.get_method() for req in self.seen], ['GET', 'POST'] * 3)
        self.assertEqual(len({req.data for req in self.seen if req.get_method() == 'POST'}), 1)


if __name__ == '__main__':
    unittest.main()
