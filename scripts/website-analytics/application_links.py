"""Register a résumé revision in Quantself and build links from the public catalog."""
import json
import re
from urllib.parse import urlsplit
import urllib.request
import uuid

LINKS_URL = 'https://girke.dev/api/links'
REGISTRATION_PATH = '/api/v1/tracked-links/applications'
TRACKS = {'engineering': 'backend', 'web': 'web-cms', 'admin': 'admin-excel'}
CODE = re.compile(r'(?:[A-Za-z0-9]{8}|[A-Za-z0-9]{16}|[a-f0-9]{24})')
KEY = re.compile(r'[a-z0-9]+(?:-[a-z0-9]+)*')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def parse_url(value):
    if not isinstance(value, str) or any(character.isspace() or ord(character) < 32 for character in value):
        raise ValueError('invalid_url')
    url = urlsplit(value)
    if not url.hostname or url.username is not None or url.password is not None or '\\' in value or url.port == 0:
        raise ValueError('invalid_url')
    return url


def registry_endpoint(settings):
    value = settings.get('registryUrl')
    url = parse_url(value)
    local_http = url.scheme == 'http' and url.hostname in {'localhost', '127.0.0.1', '::1'}
    if (url.scheme != 'https' and not local_http) or url.path != REGISTRATION_PATH or url.query or url.fragment:
        raise ValueError('invalid_application_registry_url')
    return value


def read_json(opener, request, limit):
    with opener(request, timeout=5) as response:
        raw = response.read(limit + 1)
    if len(raw) > limit:
        raise ValueError('response_too_large')
    return json.loads(raw)


def catalog_aliases(catalog):
    if not isinstance(catalog, dict) or type(catalog.get('schemaVersion')) is not int or catalog['schemaVersion'] != 1:
        raise ValueError('invalid_catalog')
    destinations = catalog.get('destinations')
    if not isinstance(destinations, list) or not 1 <= len(destinations) <= 1000:
        raise ValueError('invalid_catalog')
    aliases = {}
    keys = set()
    for destination in destinations:
        if not isinstance(destination, dict) or 'key' not in destination:
            raise ValueError('invalid_catalog')
        key = destination['key']
        if key is not None and (not isinstance(key, str) or len(key) > 64 or not KEY.fullmatch(key)):
            raise ValueError('invalid_catalog_key')
        if key in keys:
            raise ValueError('duplicate_catalog_key')
        keys.add(key)
        sources = destination.get('sourceUrls')
        if not isinstance(sources, list) or not sources:
            raise ValueError('invalid_catalog_sources')
        for source in sources:
            url = parse_url(source)
            if url.scheme != 'https' or len(source) > 2048 or source in aliases:
                raise ValueError('invalid_catalog_source')
            aliases[source] = key
    if None not in keys:
        raise ValueError('missing_catalog_home')
    return aliases


def application_links(config, work, request=None):
    settings = config['applicationTracking']
    if settings.get('url', LINKS_URL) != LINKS_URL:
        raise ValueError('invalid_application_links_url')
    endpoint = registry_endpoint(settings)
    token = settings.get('token')
    if not isinstance(token, str) or len(token) < 32 or not re.fullmatch(r'[!-~]+', token):
        raise ValueError('invalid_application_links_token')
    opener = request or urllib.request.build_opener(NoRedirect()).open

    try:
        catalog = read_json(opener, urllib.request.Request(LINKS_URL, headers={'Accept': 'application/json'}), 262144)
        aliases = catalog_aliases(catalog)
    except Exception:
        raise ValueError('application_tracking_catalog_unavailable') from None

    try:
        payload = {
            'applicationId': str(uuid.UUID(work['applicationId'])),
            'company': work['company'],
            'role': work['role'],
            'track': TRACKS[work['resumeTrack']],
            'revision': work['revision'],
        }
        register = urllib.request.Request(endpoint, data=json.dumps(payload).encode(),
            headers={'Content-Type': 'application/json', 'X-API-Key': token}, method='POST')
        result = read_json(opener, register, 4096)
        code = result.get('code') if isinstance(result, dict) else None
        if not isinstance(code, str) or not CODE.fullmatch(code):
            raise ValueError('invalid_application_code')
    except Exception:
        raise ValueError('application_tracking_registration_failed') from None

    base = f'https://girke.dev/r/{code}'
    return {source: f'{base}/{key}' if key is not None else base for source, key in aliases.items()}
