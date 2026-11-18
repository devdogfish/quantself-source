import importlib.util
import io
import json
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('job_files', Path(__file__).with_name('files.py'))
files = importlib.util.module_from_spec(spec)
spec.loader.exec_module(files)


class TriageClassificationTest(unittest.TestCase):
    def test_source_evidence_distinguishes_excluded_saved_and_unknown(self):
        actual = 'e2e-job-automation-ideas.xlsx / Actual listings'
        sales = 'halifax-sales-and-hospitality-job-tracker.xlsx / Jobs'
        classify = files.classify_imported_status
        self.assertEqual(classify('skipped', sales, '', 'Halifax, NS', 'Retail sales associate'), 'saved_for_later')
        self.assertEqual(classify('applied', sales, '', 'Halifax, NS'), 'applied')
        self.assertEqual(classify('draft', actual, '', 'Toronto, ON · On-site', 'Sales representative'), 'saved_for_later')
        self.assertEqual(classify('skipped', actual, 'Exclusion reason: Toronto office; hybrid role', 'Toronto, ON', 'Sales representative'), 'saved_for_later')
        self.assertEqual(classify('skipped', actual, 'Listing status: stale\nExclusion reason: Page check 2026-11-08: stale — Exact job closed.', 'On-site', 'Sales representative'), 'disqualified')
        self.assertEqual(classify('skipped', actual, 'Exclusion reason: Remote role restricted to the United States', 'Remote', 'Support analyst'), 'disqualified')
        self.assertEqual(classify('skipped', actual, 'Listing status: unverified\nExclusion reason: Exact URL showed a sign-in wall.', 'Remote'), 'draft')


class ResumeAssemblyTest(unittest.TestCase):
    def test_tracking_config_requires_known_complete_maps_and_safe_urls(self):
        def config():
            return {'resumeTrackingLinks': {
                track: {url: f'https://tracker.example/{track}/{index}?source=resume&k=v'
                        for index, url in enumerate(sorted(destinations))}
                for track, destinations in files.TRACKING_DESTINATIONS.items()
            }}

        self.assertEqual(files.resume_tracking_links({}, 'web'), {})
        self.assertEqual(files.resume_tracking_links(config(), 'web'), config()['resumeTrackingLinks']['web'])
        for value in (None, {}, {'web': {}}, {**config()['resumeTrackingLinks'], 'other': {}}):
            with self.assertRaisesRegex(ValueError, 'invalid_resume_tracking_tracks'):
                files.resume_tracking_links({'resumeTrackingLinks': value}, 'web')
        for invalid in ({}, {'https://unknown.example': 'https://tracker.example/extra'}):
            broken = config()
            broken['resumeTrackingLinks']['admin'] = invalid
            with self.assertRaisesRegex(ValueError, 'invalid_resume_tracking_destinations'):
                files.resume_tracking_links(broken, 'web')
        for url in ('http://tracker.example/a', 'https://user:pass@tracker.example/a',
                    'https://tracker.example/a)[Injected](https://evil.example',
                    'https://tracker.example/\n# injected', 'https:///path', 'https://luigigirke.com'):
            broken = config()
            broken['resumeTrackingLinks']['engineering']['https://luigigirke.com'] = url
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, 'invalid_resume_tracking_url'):
                files.resume_tracking_links(broken, 'web')

    def test_tracking_requires_pdf_uri_annotations_and_rejects_original_destinations(self):
        class PdfObject(dict):
            def get_object(self):
                return self

        def annotation(url, kind='/Link'):
            return PdfObject({'/Subtype': kind, '/A': PdfObject({'/S': '/URI', '/URI': url})})

        targets = {'https://luigigirke.com': 'https://tracker.example/portfolio',
                   'https://sitings.ca/property/': 'https://tracker.example/sitings'}
        first, second = targets.values()
        page = SimpleNamespace(annotations=[annotation(first), annotation(second)])
        reader = SimpleNamespace(pages=[SimpleNamespace(annotations=None), page])
        self.assertTrue(files.pdf_tracking_verified(reader, targets))
        page.annotations.append(annotation('https://luigigirke.com/'))
        self.assertFalse(files.pdf_tracking_verified(reader, targets))
        page.annotations = [annotation(first), annotation(second, '/Text')]
        self.assertFalse(files.pdf_tracking_verified(reader, targets))
        self.assertTrue(files.pdf_tracking_verified(reader, targets, ['https://luigigirke.com']))
        page.annotations.append(annotation('https://sitings.ca/property/'))
        self.assertFalse(files.pdf_tracking_verified(reader, targets, ['https://luigigirke.com']))

        direct = 'https://example.com/part_(b)?a=1&b=2'
        expected = {'https://rbccm.com/', direct}
        page.annotations = [annotation(first), annotation(second), annotation('https://rbccm.com/'), annotation(direct)]
        verify_application = lambda: files.pdf_tracking_verified(reader, targets, application_tracking=True, direct_links=expected)
        self.assertTrue(verify_application())
        page.annotations.append(annotation('https://unknown.example/'))
        self.assertFalse(verify_application())
        page.annotations.pop()
        page.annotations.pop()
        self.assertFalse(verify_application())
        page.annotations.append(annotation(direct))
        page.annotations[0] = annotation('https://luigigirke.com/')
        self.assertFalse(verify_application())

    def test_current_phone_replaces_header_and_tel_target_without_changing_facts(self):
        text = '# Synthetic Person\n[+1 (555) 234-5678](tel:+15552345678)\n## Summary\nApproved facts.\n## Experience\n+1 (555) 234-5678 remains a source fact.\n'
        updated = files.replace_contact_phone(text, {'phone': '+1 (555) 987-6543'})
        self.assertIn('[+1 (555) 987-6543](tel:+15559876543)', updated)
        self.assertEqual(updated[updated.index('## Summary'):], text[text.index('## Summary'):])
        with self.assertRaises(ValueError): files.replace_contact_phone(text, {})
        with self.assertRaises(ValueError): files.replace_contact_phone(text, {'phone': '+1 555 987 6543\nInjected'})

    def test_category_email_changes_only_header_and_link_target(self):
        text = '# Synthetic Person\n[old@example.test](mailto:old@example.test)\n## Summary\nApproved facts.\n## Experience\nold@example.test factual source.\n'
        updated = files.replace_contact_email(text, {'email': 'new@example.test'})
        self.assertIn('[new@example.test](mailto:new@example.test)', updated)
        self.assertEqual(updated[updated.index('## Summary'):], text[text.index('## Summary'):])
        self.assertEqual(files.replace_contact_email(text, {}), text)
        with self.assertRaises(ValueError): files.replace_contact_email(text, {'email': 'unsafe\n# injected'})

    def test_only_summary_changes(self):
        before = '# Synthetic Person\n\nContact stays local.\n\n## Summary\n\nOld summary.\n\n## Professional Experience\n\nFactual experience **unchanged**.\n\n## Education\nOriginal education.\n'
        after = files.replace_summary(before, 'Reviewed summary.')
        self.assertEqual(after.split('## Summary')[0], before.split('## Summary')[0])
        self.assertEqual(after[after.index('## Professional Experience'):], before[before.index('## Professional Experience'):])
        self.assertIn('Reviewed summary.', after)
        self.assertNotIn('Old summary.', after)
        original_bullets = '- One\n- Two\n  continued\n- Three\n- Four\n- Five'
        with_bullets = before.replace('Old summary.', original_bullets)
        self.assertEqual(files.source_summary_format(with_bullets), {'kind': 'bullets', 'count': 5})
        self.assertIsNone(files.source_summary_format(before))
        self.assertIsNone(files.source_summary_format(before.replace('Old summary.', '\n'.join(['- Point'] * 13))))
        self.assertEqual(files.source_summary_format(files.replace_summary(with_bullets, '- Reviewed one\n- Reviewed two')),
                         {'kind': 'bullets', 'count': 2})

    def test_ambiguous_sections_and_heading_injection_rejected(self):
        for text, summary in [('# Resume\nNo summary', 'New'), ('## Summary\nOld\n## Summary\nTwo\n## Education\nText', 'New'), ('## Summary\nOld\n## Education\nText', 'New\n## Experience\nFake')]:
            with self.assertRaises(ValueError): files.replace_summary(text, summary)

    def test_url_sources_include_formula_and_legacy_cached_hyperlink(self):
        class Cell:
            hyperlink = None
            def __init__(self, value): self.value = value
        self.assertEqual(files.url_from_cell(Cell('=HYPERLINK("https://example.com/role/123","Apply")')), 'https://example.com/role/123')
        self.assertEqual(files.url_from_cell(Cell('HYPERLINK is not implemented. linkLocation=https://example.com/role/456, friendlyName=Apply')), 'https://example.com/role/456')
        self.assertEqual(files.url_from_cell(None), '')

    def test_explicit_contact_location_is_local_and_ambiguous_locations_are_omitted(self):
        contact = files.personal_from_header('# Synthetic Person\n\nExample Town, NS | test@example.com | +1 555 234 5678')
        self.assertEqual(contact['city'], 'Example Town')
        self.assertEqual(contact['region'], 'Nova Scotia')
        self.assertEqual(contact['country'], 'Canada')
        ambiguous = files.personal_from_header('# Synthetic Person\nExample Town, NS\nOther Town, ON')
        self.assertNotIn('city', ambiguous)
        self.assertNotIn('country', ambiguous)

    def test_summary_projects_explicit_capabilities_in_order_without_private_prose(self):
        resume = """# Synthetic Person
Header mentions software testing.

## Summary

Experience in **workflow automation**, data entry, and CMS publishing at Synthetic Employer since 2011.
No experience in accounts payable, bookkeeping, or customer support.
I don’t have experience in project coordination.
I have no
experience in web development.
My team has experience in technical support.
Interested in gaining experience in accessibility testing.
Background in [data analysis](https://private.example/path) and process documentation.
Skilled in data entry and content migration.
Contact private@example.test or +1 555 234 5678.

## Professional Experience
Experience in accounts receivable and inventory management. Uses Python.
"""
        expected = ['workflow automation', 'data entry', 'CMS publishing', 'content migration']
        self.assertEqual(files.source_summary_capabilities(resume), expected)
        self.assertEqual(files.source_summary_capabilities(resume + '\n## Summary\nDuplicate.'), [])
        bullet_summary = """## Summary
- Software developer building desktop applications for Example Employer.
- Web content developer maintaining and updating client websites.
- Created and maintained ExampleEmployer's Excel tracker for 7 years.
- Employer built mobile apps while I shadowed.
- Our team maintains public websites.
- I have no
  experience in project coordination.
## Experience
- Built a private tool.
"""
        self.assertEqual(files.source_summary_capabilities(bullet_summary), [
            'software development', 'web content development', 'website maintenance', 'spreadsheet work',
        ])

    def test_initialize_preserves_factual_source_and_refreshes_only_generated_profiles(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            md = root / 'md'
            md.mkdir()
            home = root / 'local'
            for track, pattern in files.TRACKS.items():
                summary = 'Experience in data entry at Private Employer, maintaining ~800 profiles in Excel.'
                if track == 'web':
                    summary = '\n'.join('- ' + sentence for sentence in [summary, 'Two.', 'Three.', 'Four.', 'Five.'])
                (md / f'Synthetic-{pattern}-Resume.md').write_text(
                    f'# Synthetic Person\n\n## Summary\n\n{summary}\n'
                    '\n## Experience\nPython and Excel.\n'
                )
            files.save_private(home / 'profiles.json', {
                'engineering': {
                    'approved': False,
                    'text': 'Resume focus: Software Engineering.\nTools mentioned in this resume: Excel, Python.',
                },
                'web': {'approved': True, 'text': 'User-authored approved profile.'},
            })
            with redirect_stdout(io.StringIO()):
                files.initialize(root, home)
            profiles = json.loads((home / 'profiles.json').read_text())
            self.assertEqual(profiles['web'], {'approved': True, 'text': 'User-authored approved profile.',
                                              'summaryFormat': {'kind': 'bullets', 'count': 5}})
            self.assertFalse(profiles['engineering']['approved'])
            self.assertIn('Experience in data entry', profiles['engineering']['text'])
            self.assertIn('maintaining ~800 profiles in Excel', profiles['admin']['text'])
            self.assertNotIn('Private Employer', json.dumps(profiles))
            self.assertNotIn('Python', profiles['admin']['text'])
            admin = next(md.glob('*Admin-and-Excel*'))
            admin.write_text(admin.read_text().replace('data entry', 'bookkeeping'))
            with redirect_stdout(io.StringIO()):
                files.initialize(root, home)
            refreshed = json.loads((home / 'profiles.json').read_text())
            self.assertIn('Experience in bookkeeping', refreshed['admin']['text'])
            self.assertEqual(refreshed['web'], profiles['web'])

    def test_anonymous_summary_retains_metrics_and_removes_identifiers_locally(self):
        text = '''# Synthetic Person
Example Town, NS | private@example.test | +1 555 234 5678
## Summary
- Web Content Developer at Private Bank (2024–2026), handling ~10 changes daily.
- Built an Excel tracker of ~800 profiles for Synthetic Person.
- Cut searches from hours or days to under 1 hour; visited privatebank.example/path.
- Built Next.js components for Secret Client and maintained 4 sites.
- Contact private@example.test or +1 555 234 5678; worked in Example Town.
## Professional Experience
This private section must never enter model input.
'''
        value = files.anonymous_summary(text)
        for hidden in ['Synthetic', 'Person', 'Private Bank', '2024', '2026', 'Secret Client',
                       'privatebank.example', 'private@example.test', '555', 'Example Town', 'private section']:
            self.assertNotIn(hidden, value)
        for evidence in ['Web Content Developer', '~10 changes daily', 'Excel tracker of ~800 profiles',
                         'hours or days to under 1 hour', 'Next.js components', 'maintained 4 sites']:
            self.assertIn(evidence, value)


if __name__ == '__main__': unittest.main()
