import { z } from 'zod';
import { exactBrowserPosting, readBrowserConfig, reviewedBrowserUrl } from './private-browser-config';

const label = z.string().min(1).max(400);
const notice = z.string().min(1).max(4_000);
const path = z.string().startsWith('/').max(1_024).refine(value =>
  !value.startsWith('//') && !/[?#\\\r\n]/.test(value));
const selector = z.string().min(1).max(400);
const form = z.strictObject({
  selector,
  resumeSelector: selector,
  fields: z.record(selector, z.enum(['firstName', 'lastName', 'fullName', 'email', 'phone', 'city', 'region', 'country',
    'postalCode', 'addressLine1', 'linkedin', 'website'])),
});
const common = z.strictObject({
  sources: z.array(reviewedBrowserUrl).min(1).max(8),
  url: reviewedBrowserUrl,
  listingUrl: reviewedBrowserUrl,
  listingPath: path,
  company: label,
  role: label,
});
const targetSchema = z.discriminatedUnion('portal', [
  common.extend({ portal: z.literal('greenhouse'), sourceTitle: label, applicationTitle: label }),
  common.extend({
    portal: z.literal('rippling'),
    sourceListing: reviewedBrowserUrl, sourceHeading: label, sourceLinkHref: path, sourceLinkLabel: label,
    listingTitle: label, listingHeading: label, applicationTitle: label, applicationHeading: label, receiptHeading: label,
  }),
  common.extend({
    portal: z.literal('branded'),
    sourceListing: reviewedBrowserUrl, pageTitle: label, form, headingSelector: selector,
    verificationSelector: selector, verificationResponse: selector,
    receipt: z.strictObject({ rootSelector: selector, heading: label, prefix: label, suffix: label }),
    requiredControls: z.array(z.tuple([selector, label])).min(1).max(40),
    optionalControl: z.tuple([selector, label]),
  }),
  common.extend({
    portal: z.literal('taleo'),
    sourceApply: reviewedBrowserUrl, sourceTitle: label, applicationTitle: label, applicationHeading: label,
    policyUrl: reviewedBrowserUrl, policyNotice: notice, agreementPath: path,
  }),
  common.extend({ portal: z.literal('jazzhr') }),
  common.extend({ portal: z.literal('workable'),
    radioNames: z.array(z.string().regex(/^QA_[A-Za-z0-9_]+$/)).max(30) }),
  common.extend({
    portal: z.literal('manatal'), form, termsControl: selector, termsLabel: notice, termsPath: path, privacyPath: path,
  }),
]);

function hasQueryKeys(url: URL, keys: string[]) {
  return url.searchParams.size === keys.length && keys.every(key => url.searchParams.getAll(key).length === 1);
}

function matchesPortal(target: z.infer<typeof targetSchema>) {
  const url = new URL(target.url);
  const listing = new URL(target.listingUrl);
  const listingPath = listing.pathname.replace(/\/$/, '');
  switch (target.portal) {
    case 'greenhouse': {
      const returnUrl = url.searchParams.get('b') ?? '';
      const returnPage = reviewedBrowserUrl.safeParse(returnUrl).success ? new URL(returnUrl) : undefined;
      return url.hostname === 'job-boards.greenhouse.io' && target.listingPath === '/embed/job_app' &&
        url.pathname === target.listingPath && hasQueryKeys(url, ['for', 'token', 'b']) &&
        hasQueryKeys(listing, ['gh_jid']) && /^\d{1,15}$/.test(listing.searchParams.get('gh_jid') ?? '') &&
        listing.searchParams.get('gh_jid') === url.searchParams.get('token') &&
        returnPage?.hostname.replace(/^www\./, '') === listing.hostname.replace(/^www\./, '') &&
        returnPage.pathname.replace(/\/$/, '') === listingPath &&
        /^[a-z\d_-]+$/i.test(url.searchParams.get('for') ?? '');
    }
    case 'rippling': {
      const route = listingPath.match(/^\/([a-z\d_-]+)\/jobs\/([a-f\d-]{36})$/i);
      return url.hostname === 'ats.rippling.com' && listing.origin === url.origin && !listing.search &&
        listingPath === target.listingPath && url.pathname === listingPath + '/apply' &&
        hasQueryKeys(url, ['jobBoardSlug', 'jobId', 'step']) && route?.[1] === url.searchParams.get('jobBoardSlug') &&
        route?.[2] === url.searchParams.get('jobId') && /^[a-z0-9_-]{1,32}$/i.test(url.searchParams.get('step') ?? '');
    }
    case 'taleo': {
      const sourceApply = new URL(target.sourceApply);
      return url.hostname.endsWith('.taleo.net') && url.pathname === target.listingPath &&
        url.origin === sourceApply.origin && hasQueryKeys(url, ['job']) && hasQueryKeys(sourceApply, ['job']) &&
        !!url.searchParams.get('job') && url.search === sourceApply.search;
    }
    case 'branded':
      return listingPath === target.listingPath && !listing.search && url.href === listing.href &&
        new URL(target.sourceListing).origin === listing.origin;
    case 'jazzhr':
      return url.hostname.endsWith('.applytojob.com') && url.pathname === target.listingPath &&
        !url.search && listing.href === url.href;
    case 'manatal':
    case 'workable':
      return url.hostname === (target.portal === 'manatal' ? 'www.careers-page.com' : 'apply.workable.com') &&
        listingPath === target.listingPath && listing.origin === url.origin && !url.search && !listing.search &&
        url.pathname.replace(/\/$/, '') === listingPath + '/apply';
  }
}

const targets = z.array(targetSchema.refine(matchesPortal, 'Unverified browser target')).max(50).refine(entries => {
  const sources = entries.flatMap(entry => entry.sources.map(exactBrowserPosting));
  return new Set(sources).size === sources.length;
});

export function directBrowserTarget(sourceUrl: string) {
  const source = exactBrowserPosting(sourceUrl);
  if (!source) return;
  return readBrowserConfig('direct-browser-targets.json', targets)
    ?.find(target => target.sources.some(candidate => exactBrowserPosting(candidate) === source));
}
