"""Local-only source intake and PDF assembly. Never print private resume contents."""
import argparse
import hashlib
import html
import json
import os
import re
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import quote, urlparse, urlsplit, urlunsplit

TRACKS = {"engineering": "Software-Engineering", "web": "Web-and-CMS-Publishing", "admin": "Admin-and-Excel"}
COMMON_TRACKING_DESTINATIONS = {
    'https://www.linkedin.com/in/luigigirke', 'https://luigigirke.com',
    'https://rbc-analytics.demo.girke.dev', 'https://sitings.ca/property/',
}
TRACKING_DESTINATIONS = {
    'engineering': COMMON_TRACKING_DESTINATIONS | {'https://github.com/devdogfish', 'https://github.com/devdogfish/etpzp-sms'},
    'web': COMMON_TRACKING_DESTINATIONS | {'https://github.com/devdogfish'},
    'admin': COMMON_TRACKING_DESTINATIONS,
}
TRACKING_URL = re.compile(r'https://[A-Za-z0-9.\-]+(?::[0-9]+)?(?:[/?#][A-Za-z0-9._~:/?#@!$&*+,;=%-]*)?')
TOOLS = ["Excel", "Google Sheets", "Microsoft Office", "Word", "PowerPoint", "SQL", "Python", "JavaScript", "TypeScript", "React", "Next.js", "Node.js", "Git", "HTML", "CSS", "WordPress", "Shopify", "Webflow", "Figma", "Notion", "Airtable", "PostgreSQL", "Docker"]
SUMMARY_CAPABILITIES = (
    "software development", "front-end development", "back-end development", "full-stack development",
    "web development", "web content development", "web publishing", "CMS publishing", "content publishing", "content management",
    "content migration", "website maintenance", "e-commerce operations", "software testing", "quality assurance",
    "accessibility testing", "technical documentation", "technical support", "customer support",
    "data entry", "data analysis", "data migration", "spreadsheet reporting", "process documentation",
    "workflow automation", "project coordination", "bookkeeping", "accounts payable", "accounts receivable",
    "inventory management",
)
CAPABILITY = re.compile(
    '(' + '|'.join(re.escape(item) for item in sorted(SUMMARY_CAPABILITIES, key=len, reverse=True)) + r')(?!\w)',
    re.I,
)
CAPABILITY_LABELS = {item.casefold(): item for item in SUMMARY_CAPABILITIES}
SUMMARY_CUE = re.compile(
    r'\b(?:experience|experienced|background|skills|skilled|speciali[sz](?:e|es|ing|ation)|focus(?:ed)?|proficient)'
    r'\s+(?:in|with|on)\s+', re.I,
)
UNSUPPORTED_CLAIM = re.compile(
    r'\b(?:no|not|never|without|zero|neither|nor|lacks?|lacking|\w+n[\'’]t|seeking|learning|interested|'
    r'observed|observing|want to|looking to|hope to|plan to|would like|could gain|opportunity to|'
    r'(?:my|our|the|a)\s+(?:team|manager|employer|colleague|coworker)\b|'
    r'(?:team|employer|client|colleague|coworker)s?\s+(?:has|have|built|created|developed|maintains?|maintained))\b',
    re.I,
)
CAPABILITY_JOIN = re.compile(r'\s*[,;]\s*(?:and\s+)?|\s+(?:and|&)\s+', re.I)
SUMMARY_ROLES = {
    'software developer': 'software development',
    'software engineer': 'software development',
    'web developer': 'web development',
    'web content developer': 'web content development',
}
ROLE_LEAD = re.compile(
    r"^(?:I(?: am|['’]m)\s+)?(?:an?\s+)?(?:(?:junior|senior|full-stack|entry-level)\s+)*("
    + '|'.join(SUMMARY_ROLES) + r')\b(?!\s+(?:is|was|has|had|said)\b)', re.I,
)
BUILD = r'(?:build(?:s|ing)?|built|develop(?:s|ed|ing)?|creat(?:e|es|ed|ing))'
MAINTAIN = r'(?:maintain(?:s|ed|ing)?|updat(?:e|es|ed|ing))'
ACTION_LEAD = re.compile(
    r"^(?:I(?:['’]ve)?\b|(?:with\s+)?(?:hands-on\s+)?(?:experience|experienced|background|skills|skilled|focus(?:ed)?|"
    r"speciali[sz](?:e|es|ing|ation)|proficient)\b|" + BUILD + r'\b|' + MAINTAIN + r'\b)', re.I,
)
WEB_OBJECT = r'(?:(?:existing|client|business|public|production|custom|responsive|WordPress)\s+){0,2}(?:websites?|sites?)\b'
SHEET_OBJECT = (
    r"(?:(?:an?|the|existing|custom|[a-z-]+['’]s)\s+)?(?:(?:Excel(?:-based)?\s+)(?:[a-z-]+\s+){0,2}"
    r'(?:spreadsheets?|workbooks?|trackers?|records?|logs?|templates?)|(?:spreadsheets?|workbooks?))\b'
)
SUMMARY_ACTIONS = (
    ('software development', re.compile(
        r'\b' + BUILD + r'\s+(?:(?:full-stack|web|desktop|mobile|custom)\s+){0,2}(?:apps?|applications?|software)\b',
        re.I,
    )),
    ('web development', re.compile(r'\b' + BUILD + r'\s+' + WEB_OBJECT, re.I)),
    ('website maintenance', re.compile(r'\b' + MAINTAIN + r'\s+' + WEB_OBJECT, re.I)),
    ('spreadsheet work', re.compile(
        r'\b(?:' + BUILD + r'|' + MAINTAIN + r')\s+(?:and\s+' + MAINTAIN + r'\s+)?' + SHEET_OBJECT,
        re.I,
    )),
)
CANADIAN_REGIONS = {
    'AB': 'Alberta', 'BC': 'British Columbia', 'MB': 'Manitoba',
    'NB': 'New Brunswick', 'NL': 'Newfoundland and Labrador', 'NS': 'Nova Scotia',
    'NT': 'Northwest Territories', 'NU': 'Nunavut', 'ON': 'Ontario',
    'PE': 'Prince Edward Island', 'QC': 'Quebec', 'SK': 'Saskatchewan', 'YT': 'Yukon',
}


def personal_from_header(header):
    """Extract explicit contact facts locally; do not infer eligibility or history."""
    name = next((line[2:].strip() for line in header.splitlines() if line.startswith('# ')), '')
    name = re.sub('<[^>]+>', '', name).strip('* ')
    parts = name.split()
    email = re.search(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}', header)
    phone = re.search(r'(?:\+?\d[\s().-]*){10,15}', header)
    personal = {'firstName': parts[0] if parts else '', 'lastName': ' '.join(parts[1:]), 'email': email.group(0) if email else '', 'phone': phone.group(0).strip() if phone else ''}
    region_names = {**CANADIAN_REGIONS, **{name: name for name in CANADIAN_REGIONS.values()}}
    region_pattern = '|'.join(re.escape(name) for name in sorted(region_names, key=len, reverse=True))
    # Scope to the contact header, so an employer's location cannot become the
    # applicant's city. Keep only a unique explicit city/province pair.
    plain = html.unescape(re.sub('<[^>]+>', ' ', header))
    locations = set()
    for match in re.finditer(r"(?<![A-Za-z])([A-Z][A-Za-z .'-]{1,40}),\s*(" + region_pattern + r')\b', plain):
        city = re.sub(r'^(?:Location|Address|Based in)\s*:?\s*', '', match.group(1)).strip()
        if city and len(city.split()) <= 4:
            locations.add((city, region_names[match.group(2)]))
    if len(locations) == 1:
        personal['city'], personal['region'] = next(iter(locations))
        personal['country'] = 'Canada'
    postal_codes = set(re.findall(r'\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\s?\d[ABCEGHJ-NPRSTV-Z]\d\b', plain, re.I))
    if len(postal_codes) == 1:
        compact = next(iter(postal_codes)).replace(' ', '').upper()
        personal['postalCode'] = compact[:3] + ' ' + compact[3:]
    return personal


def save_private(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix('.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, indent=2)
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def summary_span(text, allow_last=False):
    matches = list(re.finditer(r'^## Summary\s*\n', text, re.M))
    if len(matches) != 1:
        raise ValueError('invalid_summary')
    start = matches[0].end()
    next_heading = re.search(r'^## ', text[start:], re.M)
    if next_heading is None:
        if allow_last:
            return start, len(text)
        raise ValueError('missing_resume_sections')
    return start, start + next_heading.start()


def source_summary_format(text):
    """Read only top-level bullet shape from the source summary."""
    try:
        start, end = summary_span(text)
    except ValueError:
        return None
    count = 0
    for line in text[start:end].splitlines():
        if not line.strip():
            continue
        if re.match(r'^ {0,3}[-*+]\s+\S', line):
            count += 1
        elif not count or not re.match(r'^(?: {2,}|\t)\S', line):
            return None
    return {'kind': 'bullets', 'count': count} if 1 <= count <= 12 else None


def source_summary_capabilities(text):
    """Project positive capability phrases to fixed labels without copying prose."""
    try:
        start, end = summary_span(text)
    except ValueError:
        return []
    summary = re.sub(r'!?\[[^\]\n]+\]\([^)]+\)|<[^>]+>|https?://\S+', ' ', text[start:end])
    summary = re.sub(r'[*_`]', '', summary)
    capabilities = []
    for statement in re.split(r'\n[ \t]*\n+|\n(?=[ \t]*[-–—•]\s)|(?<=[.!?])\s+', summary):
        statement = re.sub(r'^[-–—•]\s+', '', ' '.join(statement.split()))
        if UNSUPPORTED_CLAIM.search(statement):
            continue
        role = ROLE_LEAD.match(statement)
        if not role and not ACTION_LEAD.match(statement):
            continue
        candidates = [(0, SUMMARY_ROLES[role.group(1).casefold()])] if role else []
        for cue in SUMMARY_CUE.finditer(statement):
            position = cue.end()
            while match := CAPABILITY.match(statement, position):
                label = CAPABILITY_LABELS[match.group(1).casefold()]
                candidates.append((match.start(), label))
                join = CAPABILITY_JOIN.match(statement, match.end())
                if not join:
                    break
                position = join.end()
        for label, action in SUMMARY_ACTIONS:
            candidates.extend((match.start(), label) for match in action.finditer(statement))
        for _, label in sorted(candidates):
            if label not in capabilities:
                capabilities.append(label)
    return capabilities


def profile_hash(text):
    return hashlib.sha256(text.encode()).hexdigest()


SUMMARY_PUBLIC_TERMS = sorted(set(TOOLS + [
    'Web Content Developer', 'Web Developer', 'Software Developer', 'Software Engineer',
    'Full-Stack Developer', 'Full Stack Developer', 'Front-End Developer', 'Back-End Developer',
    'Content Developer', 'Frontend Developer', 'Backend Developer', 'Intern', 'Contractor',
    'Microsoft Access', 'Access', 'Outlook', 'SharePoint', 'Microsoft SharePoint', 'CMS', 'SEO', 'API', 'APIs', 'UI', 'UX',
    'PHP', 'Laravel', 'Symfony', 'Vue', 'Vue.js', 'Angular', 'Svelte', 'C#', 'C++',
    'Java', 'MySQL', 'SQLite', 'MongoDB', 'AWS', 'Azure', 'Linux', 'Windows',
    'Adobe Experience Manager', 'AEM', 'Selenium', 'Playwright', 'Jest', 'Vitest',
    'Built', 'Created', 'Maintained', 'Developed', 'Managed', 'Produced', 'Updated',
    'Supported', 'Published', 'Prepared', 'Coordinated', 'Tracked', 'Processed',
    'Resolved', 'Designed', 'Worked', 'Wrote', 'Automated', 'Delivered', 'Documented',
    'Reviewed', 'Led', 'Rebuilt', 'Implemented', 'Reduced', 'Cut', 'Moved', 'Promoted',
    'Shipped', 'Launched', 'Collaborated', 'Work', 'Experience',
]), key=len, reverse=True)


def anonymous_summary(text):
    """Keep factual summary clauses locally; hide contact data and unknown proper names.

    This uses deterministic text operations, never a model. Unknown capitalized or
    mixed-case terms are opaque references. Only fixed public role/tool/action names
    survive. The source Markdown and private identity strings never leave this process.
    """
    start, end = summary_span(text)
    summary = text[start:end].strip()
    header = text.split('## Summary', 1)[0]
    private = personal_from_header(header)
    for value in sorted(set(private.values()), key=len, reverse=True):
        if value and len(value) > 2:
            summary = re.sub(r'(?<!\w)' + re.escape(value) + r'(?!\w)', '[private reference]', summary, flags=re.I)
    summary = re.sub(r'!?\[([^\]\n]*)\]\([^)]+\)', r'\1 [private reference]', summary)
    summary = re.sub(r'<[^>]*>', ' ', summary)
    summary = re.sub(r'\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b', '[private reference]', summary)
    summary = re.sub(r'(?<!\d)(?:\+?\d[\s().-]*){10,15}(?!\d)', '[private reference]', summary)
    summary = re.sub(r'\s*\((?:19|20)\d{2}\s*[–—-]\s*(?:(?:19|20)\d{2}|present)\)', '', summary, flags=re.I)
    summary = re.sub(r'\b(?:19|20)\d{2}[-/]\d{1,2}(?:[-/]\d{1,2})?\b', '[private date]', summary)
    # Protect only explicit public vocabulary before removing domains/proper names.
    # Private names were removed first, so a coincidental tool/name match stays hidden.
    protected = []
    for term in SUMMARY_PUBLIC_TERMS:
        pattern = r'(?<![\w])' + re.escape(term) + r'(?![\w])'
        def protect(match):
            protected.append(match.group())
            return f'\ue000{len(protected) - 1}\ue001'
        summary = re.sub(pattern, protect, summary)
    summary = re.sub(r'https?://[^\s<>()]+|\b(?:[a-z0-9](?:[a-z0-9-]{0,62})\.)+[a-z]{2,63}(?:[/?#][^\s<>()]*)?',
                     '[private reference]', summary, flags=re.I)
    summary = re.sub(r'\b[A-Za-z0-9_-]*[A-Z][A-Za-z0-9_+./&-]*(?:[ \t]+[A-Za-z0-9_-]*[A-Z][A-Za-z0-9_+./&-]*)*',
                     '[private reference]', summary)
    summary = re.sub(r'\ue000(\d+)\ue001', lambda match: protected[int(match.group(1))], summary)
    return summary


def initialize(source, directory):
    paths, profiles, legacy_profiles, personal = {}, {}, {}, {}
    for track, pattern in TRACKS.items():
        matches = list((Path(source) / 'md').glob(f'*{pattern}*Resume.md'))
        if len(matches) != 1:
            raise ValueError('resume_variant_not_found')
        paths[track] = str(matches[0])
        text = matches[0].read_text()
        header = text.split('## Summary', 1)[0]
        if not personal:
            personal = personal_from_header(header)
        skills = [tool for tool in TOOLS if re.search(r'(?<!\w)' + re.escape(tool) + r'(?!\w)', text, re.I)]
        legacy = f'Resume focus: {pattern.replace("-", " ")}.\nTools mentioned in this resume: {", ".join(skills)}.'
        capabilities = source_summary_capabilities(text)
        profile = 'Factual baseline from the existing resume Summary (private references redacted):\n' + anonymous_summary(text)
        legacy_profiles[track] = legacy
        profiles[track] = {'approved': True, 'text': profile, 'generatedTextHash': profile_hash(profile)}
        if summary_format := source_summary_format(text):
            profiles[track]['summaryFormat'] = summary_format
    root = Path(directory)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(root, 0o700)
    if not (root / 'private.json').exists():
        save_private(root / 'private.json', {'personal': personal, 'resumePaths': paths})
    else:
        existing = json.loads((root / 'private.json').read_text())
        # Fill absent aliases only. Explicit user values, including blank ones,
        # remain authoritative and are never overwritten by rediscovery.
        additions = {key: value for key, value in personal.items() if key not in existing.get('personal', {}) and value}
        if additions:
            existing['personal'] = {**existing.get('personal', {}), **additions}
            save_private(root / 'private.json', existing)
    profile_path = root / 'profiles.json'
    previous = json.loads(profile_path.read_text()) if profile_path.exists() else {}
    stored = {**previous}
    for track, generated in profiles.items():
        current = previous.get(track)
        if current is None:
            stored[track] = generated
            continue
        updated = {**current}
        current_text = current.get('text')
        if isinstance(current_text, str) and (
            current_text == legacy_profiles[track] or current.get('generatedTextHash') == profile_hash(current_text)
        ):
            updated.update(text=generated['text'], generatedTextHash=generated['generatedTextHash'])
        updated.pop('summaryFormat', None)
        if 'summaryFormat' in generated:
            updated['summaryFormat'] = generated['summaryFormat']
        stored[track] = updated
    if stored != previous:
        save_private(profile_path, stored)
    print(json.dumps({'resumeVariants': len(paths), 'profilesNeedReview': any(not value.get('approved') for value in stored.values())}))


def url_from_cell(cell):
    if cell is None:
        return ''
    if cell.hyperlink and cell.hyperlink.target:
        return cell.hyperlink.target
    raw = str(cell.value or '')
    match = re.search(r'HYPERLINK\(\s*"([^"]+)"', raw, re.I) or re.search(r'linkLocation=(https?://.*?), friendlyName=', raw)
    return match.group(1) if match else raw


def infer_track(role):
    if re.search(r'engineer|software|developer|programmer|\bQA\b|\bSDET\b', role, re.I):
        return 'engineering'
    if re.search(r'CMS|web|content|publish|digital|SEO|e.?commerce|wordpress', role, re.I):
        return 'web'
    return 'admin'


def truthy(value):
    return value is True or str(value).strip().lower() in ('true', 'yes', '1')


def classify_imported_status(source_status, source_label, description, location, role=''):
    """Translate legacy workbook exclusions without inventing an Owner decision."""
    if source_status not in ('skipped', 'draft'):
        return source_status
    if source_label == 'halifax-sales-and-hospitality-job-tracker.xlsx / Jobs':
        return 'saved_for_later' if location and not re.search(r'\bremote\b', location, re.I) else 'draft'
    if source_label != 'e2e-job-automation-ideas.xlsx / Actual listings':
        return 'draft'
    if re.search(r'^Availability checked \S+: closed\.', description, re.M):
        return 'disqualified'
    reason = re.search(r'^Exclusion reason: (.+)$', description, re.M)
    evidence = reason.group(1).split(' | Page check ', 1)[0] if reason else ''
    if reason and re.search(r'^Listing status: stale$', description, re.M) and re.search(r'\bPage check \d{4}-\d{2}-\d{2}: stale\b', reason.group(1)):
        return 'disqualified'
    sales_role = re.search(r'\b(?:sales|retail associate|store associate|account executive|business development representative)\b', role, re.I)
    sales_support = re.search(r'\b(?:operations|analyst|commission|compensation|sourcer|customer service|talent|enablement)\b', role, re.I)
    in_person = re.search(r'\b(?:in[- ]person|on[- ]site|hybrid|office[- ]based)\b', f'{location} {evidence}', re.I)
    if sales_role and not sales_support and in_person:
        return 'saved_for_later'
    if source_status == 'draft':
        return 'draft'
    geographic_requirements = (
        r'^(?:Remote role restricted to |Role location listed as United States$|Restricted to another province or city$)',
        r'^(?:Toronto office; hybrid role$|Remote role requires .+ residence$|Occasional visit to .+ office required;)',
        r'^Remote work(?:/location)? restricted to (?!Canada(?:;|\.|$))',
        r'^Remote work/location restricted to Canada; remote; .+ location requirement shown;',
    )
    if any(re.search(pattern, evidence, re.I) for pattern in geographic_requirements):
        return 'disqualified'
    return 'draft'


def extract_workbook(path):
    import openpyxl
    workbook = openpyxl.load_workbook(path, data_only=False)
    records = []
    for sheet in workbook:
        if sheet.title not in ('Actual listings', 'Jobs'):
            continue
        rows = list(sheet.iter_rows())
        header_index = next((i for i, row in enumerate(rows[:15]) if 'Employer' in [c.value for c in row] and any(c.value in ('Listing URL', 'Apply URL') for c in row)), None)
        if header_index is None:
            continue
        headers = [str(cell.value or '') for cell in rows[header_index]]
        for row in rows[header_index + 1:]:
            cells = dict(zip(headers, row))
            def value(key):
                cell = cells.get(key)
                return str(cell.value or '').strip() if cell else ''
            company = value('Employer')
            role = value('Actual job title') or value('Role')
            if not company or not role:
                continue
            url = url_from_cell(cells.get('Listing URL')) or url_from_cell(cells.get('Apply URL'))
            parsed = urlparse(url)
            if parsed.scheme not in ('https', 'http') or not parsed.hostname:
                raise ValueError('invalid_listing_url')
            status = 'draft'
            context = []
            if sheet.title == 'Actual listings':
                if truthy(cells['Excluded from apply list'].value):
                    status = 'skipped'
                for key in ('Matching routine duty', 'Listing status', 'Stated experience', 'Skill / complexity evidence', 'Exclusion reason'):
                    if value(key):
                        context.append(f'{key}: {value(key)}')
            else:
                historical = value('Application Status').lower()
                status = 'applied' if historical in ('applied', 'submitted') else 'rejected' if historical == 'rejected' else 'skipped'
                context.append('Earlier sales and hospitality tracker. Resume choice requires review before reopening.')
                context.append('Previous application status: ' + historical)
                if value('Applied Date'):
                    context.append('Original applied date: ' + value('Applied Date'))
                if value('Requirements / Watch-outs'):
                    context.append('Requirements: ' + value('Requirements / Watch-outs'))
            location = value('Location / remote') or value('Location')
            salary = value('Posted pay') or value('Pay')
            for label, text in [('Location details', location), ('Pay details', salary)]:
                if len(text) > 200:
                    context.append(f'{label}: {text}')
            compact = lambda text: text if len(text) <= 200 else text[:197] + '...'
            source_label = f'{Path(path).name} / {sheet.title}'
            description = '\n'.join(context)[:12000]
            status = classify_imported_status(status, source_label, description, location, role)
            records.append({'company': company, 'role': role, 'sourceUrl': url, 'resumeTrack': infer_track(role), 'location': compact(location), 'salary': compact(salary), 'sourceLabel': source_label, 'sourceStatus': status, 'description': description})
    workbook.close()
    return records


def import_sources(source, output):
    root = Path(source)
    records = []
    for name in ('e2e-job-automation-ideas.xlsx', 'halifax-sales-and-hospitality-job-tracker.xlsx'):
        if (root / name).exists():
            records.extend(extract_workbook(root / name))
    if not records:
        raise ValueError('no_job_records')
    save_private(output, {'applications': records})
    print(json.dumps({'records': len(records), 'drafts': sum(row['sourceStatus'] == 'draft' for row in records), 'historicalOrExcluded': sum(row['sourceStatus'] != 'draft' for row in records)}))


def replace_summary(text, summary, allow_last=False):
    if not summary.strip() or len(summary) > 2000 or '\n#' in summary:
        raise ValueError('invalid_summary')
    start, end = summary_span(text, allow_last=allow_last)
    return text[:start] + '\n' + summary.strip() + '\n\n' + text[end:]


def contact_header_end(text, custom_document=False):
    if custom_document:
        first_heading = re.search(r'^## ', text, re.M)
        if first_heading is None:
            raise ValueError('invalid_resume_summary')
        return first_heading.start()
    return summary_span(text)[0]


def replace_contact_email(text, personal, custom_document=False):
    """Apply the selected category email locally without changing source or layout."""
    email = personal.get('email', '')
    if not email:
        return text
    if not re.fullmatch(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}', email):
        raise ValueError('invalid_contact_email')
    start = contact_header_end(text, custom_document)
    header = text[:start]
    original = personal_from_header(header).get('email')
    if not original:
        raise ValueError('resume_contact_email_not_found')
    return header.replace(original, email) + text[start:]


class CurrentContactRequired(ValueError):
    def __init__(self, fields):
        self.fields = fields
        super().__init__(f'current_contact_{fields[0]}_required')


def replace_contact_phone(text, personal, custom_document=False):
    """Use only the current saved phone; an absent value never revives the source."""
    start = contact_header_end(text, custom_document)
    header = text[:start]
    original = personal_from_header(header).get('phone', '')
    phone = personal.get('phone', '')
    if not original:
        return text
    if not phone:
        raise CurrentContactRequired(['phone'])
    digits = re.sub(r'\D', '', phone)
    if not re.fullmatch(r'\+?[0-9 ().-]+', phone) or not 10 <= len(digits) <= 15:
        raise ValueError('invalid_contact_phone')
    old_digits = re.sub(r'\D', '', original)
    def substitute(match):
        # The contact pattern includes separators; retain closing link brackets,
        # punctuation and line breaks after its final digit.
        value = re.sub(r'[^0-9]+$', '', match.group(0))
        if re.sub(r'\D', '', value) != old_digits:
            return match.group(0)
        replacement = ('+' if phone.startswith('+') else '') + digits if header[max(0, match.start()-4):match.start()] == 'tel:' else phone
        return replacement + match.group(0)[len(value):]
    header = re.sub(r'(?:\+?\d[\s().-]*){10,15}', substitute, header)
    return header + text[start:]


def resume_tracking_links(config, track, work=None):
    if config.get('applicationTracking'):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'website-analytics'))
        from application_links import application_links
        if work is None:
            raise ValueError('application_tracking_requires_application')
        return application_links(config, work)
    if 'resumeTrackingLinks' not in config:
        return {}
    links = config['resumeTrackingLinks']
    if not isinstance(links, dict) or links.keys() != TRACKING_DESTINATIONS.keys():
        raise ValueError('invalid_resume_tracking_tracks')
    for variant, destinations in TRACKING_DESTINATIONS.items():
        replacements = links[variant]
        if not isinstance(replacements, dict) or replacements.keys() != destinations:
            raise ValueError('invalid_resume_tracking_destinations')
        for url in replacements.values():
            if not isinstance(url, str) or not TRACKING_URL.fullmatch(url):
                raise ValueError('invalid_resume_tracking_url')
            parsed = urlparse(url)
            if not parsed.hostname or not parsed.hostname.strip('.') or parsed.port == 0 or url in TRACKING_DESTINATIONS['engineering']:
                raise ValueError('invalid_resume_tracking_url')
        if len(set(replacements.values())) != len(replacements):
            raise ValueError('duplicate_resume_tracking_url')
    return links[track]


def pdf_web_url(url):
    """Normalize a web destination as represented in a browser-generated PDF."""
    if not isinstance(url, str) or re.search(r'[\s\\\x00-\x1f\x7f]', url):
        return None
    try:
        parsed = urlsplit(url)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username is not None:
            return None
        hostname = parsed.hostname
        host = f'[{hostname}]' if ':' in hostname else hostname.encode('idna').decode('ascii')
        default_port = 443 if parsed.scheme == 'https' else 80
        if parsed.port not in (None, default_port):
            host += f':{parsed.port}'
        return quote(urlunsplit(parsed._replace(netloc=host, path=parsed.path or '/')),
                     safe=":/?#[]@!$&'()*+,;=%")
    except (ValueError, UnicodeError):
        return None


def markdown_web_links(source):
    import markdown

    class Anchors(HTMLParser):
        def __init__(self):
            super().__init__()
            self.urls = set()

        def handle_starttag(self, tag, attrs):
            if tag == 'a' and (url := pdf_web_url(dict(attrs).get('href'))):
                self.urls.add(url)

    anchors = Anchors()
    anchors.feed(markdown.markdown(source, extensions=['extra', 'sane_lists', 'nl2br']))
    anchors.close()
    return anchors.urls


def pdf_tracking_verified(reader, links, retained=None, *, application_tracking=False, direct_links=()):
    targets = set()
    for page in reader.pages:
        for reference in page.annotations or []:
            annotation = reference.get_object()
            action = annotation.get('/A')
            if annotation.get('/Subtype') == '/Link' and action is not None:
                action = action.get_object()
                if action.get('/S') == '/URI':
                    targets.add(action.get('/URI'))
    originals = {pdf_web_url(url) for url in links}
    replacements = set(links.values())
    expected_direct = set(direct_links) - originals - {pdf_web_url(url) for url in replacements}
    actual_web_links = set()
    for url in targets:
        if url in replacements:
            continue
        if isinstance(url, str) and url.lower().startswith(('http:', 'https:', '//')):
            actual_web_links.add(pdf_web_url(url))
        elif application_tracking and not isinstance(url, str):
            return False
    return (targets.issuperset(links.values() if retained is None else (links[key] for key in retained))
            and actual_web_links.isdisjoint(originals)
            and expected_direct <= actual_web_links
            and (not application_tracking or actual_web_links <= expected_direct))


def render_resume(config_path, work_path, output, *, custom_document=False):
    import shutil
    import subprocess
    import tempfile
    import unicodedata
    config = json.loads(Path(config_path).read_text())
    work = json.loads(Path(work_path).read_text())
    source_path = Path(config['resumePaths'][work['resumeTrack']])
    source = source_path.read_text()
    personal = config.get('personal', {})
    start = contact_header_end(source, custom_document)
    original = personal_from_header(source[:start])
    missing = [field for field in ('email', 'phone') if original.get(field) and not personal.get(field)]
    if missing:
        raise CurrentContactRequired(missing)
    tracking = resume_tracking_links(config, work['resumeTrack'], work)
    import markdown
    from pypdf import PdfReader
    revised = replace_summary(source, work['summary'], allow_last=custom_document)
    revised = replace_contact_email(revised, personal, custom_document)
    revised = replace_contact_phone(revised, personal, custom_document)
    renderer = Path(config.get('rendererPath') or source_path.parent / 'render_resumes.py')
    if not renderer.is_file():
        raise ValueError('original_renderer_unavailable')
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Keep the original basename: the established renderer selects track-specific
    # typography and branded metadata from it. Never edit or copy its CSS.
    with tempfile.TemporaryDirectory(prefix='render-', dir=output.parent) as folder:
        temporary_source = Path(folder) / source_path.name
        temporary_source.write_text(revised)
        os.chmod(temporary_source, 0o600)
        executable = config.get('rendererPython', sys.executable)
        environment = {key: os.environ[key] for key in ('PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL') if key in os.environ}
        command = [executable, str(renderer), folder]
        if custom_document:
            command.append('--custom-document')
        if config.get('applicationTracking'):
            command.append('--optional-tracking-links')
        if tracking:
            command.append('--tracking-links')
        result = subprocess.run(command, input=json.dumps(tracking) if tracking else None, text=True,
                                env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                timeout=120, check=False)
        produced = temporary_source.with_suffix('.pdf')
        if result.returncode or not produced.is_file():
            raise ValueError('original_renderer_failed')
        retained = None
        if (custom_document or config.get('applicationTracking')) and tracking:
            retained = json.loads(produced.with_suffix('.tracking.json').read_text())
            if (not isinstance(retained, list) or not all(isinstance(key, str) and key in tracking for key in retained)
                    or len(retained) != len(set(retained))):
                raise ValueError('pdf_tracking_verification_failed')
        shutil.copyfile(produced, output)
    os.chmod(output, 0o600)
    reader = PdfReader(str(output))
    authored_markdown = work.get('resumeMarkdown', work['summary']) if custom_document else work['summary']
    direct_links = markdown_web_links(authored_markdown)
    if (tracking or direct_links) and not pdf_tracking_verified(
        reader, tracking, retained, application_tracking=bool(config.get('applicationTracking')), direct_links=direct_links
    ):
        output.unlink(missing_ok=True)
        raise ValueError('pdf_tracking_verification_failed')
    extracted = ' '.join((page.extract_text() or '') for page in reader.pages)
    def normalized(text):
        text = unicodedata.normalize('NFKC', text).replace('\u00ad', '')
        # The established compiler applies typographic quotes during rendering.
        text = text.translate(str.maketrans({'\u2018': "'", '\u2019': "'", '\u201c': '"', '\u201d': '"'}))
        return ' '.join(re.sub('[\u2022\u25cf\u25aa]', ' ', text).split())
    # Inline links and formatting can end next to punctuation without a space.
    visible_summary = html.unescape(re.sub(r'<[^>]*>', '', markdown.markdown(work['summary'])))
    normalized_summary = normalized(visible_summary)
    normalized_text = normalized(extracted)
    if normalized_summary not in normalized_text:
        output.unlink(missing_ok=True)
        raise ValueError('pdf_summary_verification_failed')
    if config.get('personal', {}).get('email') and config['personal']['email'] not in extracted:
        output.unlink(missing_ok=True)
        raise ValueError('pdf_contact_verification_failed')
    if personal.get('phone') and normalized(personal['phone']) not in normalized_text:
        output.unlink(missing_ok=True)
        raise ValueError('pdf_phone_verification_failed')
    metadata = {
        'pages': len(reader.pages),
        'sha256': hashlib.sha256(output.read_bytes()).hexdigest(),
        'templateSha256': hashlib.sha256(source.encode()).hexdigest(),
        'rendererSha256': hashlib.sha256(renderer.read_bytes()).hexdigest(),
        'applicationId': work['applicationId'], 'revision': work['revision'],
    }
    save_private(output.with_suffix('.manifest.json'), metadata)
    save_private(output.with_suffix('.work.json'), {k: work[k] for k in ('applicationId', 'revision', 'resumeTrack', 'company', 'role', 'sourceUrl', 'summary')})
    output.with_suffix('.md').write_text(revised)
    os.chmod(output.with_suffix('.md'), 0o600)
    return metadata


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command', required=True)
    init = sub.add_parser('init'); init.add_argument('--source', required=True); init.add_argument('--home', required=True)
    intake = sub.add_parser('import'); intake.add_argument('--source', required=True); intake.add_argument('--output', required=True)
    pdf = sub.add_parser('pdf'); pdf.add_argument('--private-config', required=True); pdf.add_argument('--work', required=True); pdf.add_argument('--output', required=True)
    args = parser.parse_args()
    if args.command == 'init': initialize(args.source, args.home)
    elif args.command == 'import': import_sources(args.source, args.output)
    else: print(json.dumps(render_resume(args.private_config, args.work, args.output)))


if __name__ == '__main__':
    try:
        main()
    except CurrentContactRequired as error:
        print(json.dumps({'error': str(error), 'fields': error.fields}))
        sys.exit(1)
    except Exception:
        # Tracebacks can contain filenames and private text. Deliberately bounded.
        print(json.dumps({'error': 'local_file_operation_failed'}))
        sys.exit(1)
