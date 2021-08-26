import type { FbLabel } from './definitions';

export const MOBILE_HOST = 'm.facebook.com';
export const MOBILE_ADDRESS = `{MOBILE_HOST}`;
export const DESKTOP_HOST = 'www.facebook.com';
export const DESKTOP_ADDRESS = `https://${DESKTOP_HOST}`;

export const LABELS: Record<FbLabel, FbLabel> = {
    LISTING: 'LISTING',
    SEARCH: 'SEARCH',
    PAGE: 'PAGE',
    PHOTO: 'PHOTO',
    POST: 'POST',
};

export const CSS_SELECTORS = {
    SEE_MORE: '[src*="HOn-DOfNHK1"],[src*="ZfrShcKhxxi"]',
    POST_TIME: 'abbr',
    POST_CONTAINER: '[role="feed"] [role="article"]',
    PAGE_TRANSPARENCY: '[img*="ot671xmFQRs"]',
    MOBILE_CAPTCHA: 'img[src*="/captcha/"]',
    DESKTOP_CAPTCHA: '[data-captcha-class]',
    MOBILE_META: 'meta[name="viewport"]',
    PAGE_NAME: 'meta[property="og:title"]',
    VERIFIED: 'img[src*="y4dAXG_mKhh"]',
    VALID_PAGE: 'meta[property="og:url"]',
    META_DESCRIPTION: 'meta[name="description"]',
    MOBILE_BODY_CLASS: 'body.touch.x2.android',
    COMMENTS_CONTAINER: 'form[rel="async"] ul',
    MOBILE_LOADING_INDICATOR: '[data-sigil*="m-loading-indicator-animate"][style]',
    LOAD_COMMENTS: '[role="article"] a[role="button"]:not([ajaxify]):not([target="_blank"])',
    LOAD_MORE_COMMENTS: 'form[rel="async"] div a[role="button"][href="#"]:not([data-ordering]):not([ajaxify])',
    LDJSON: 'head script[type="application/ld+json"]',
    COMMENT_ORDER: 'form[rel="async"] [data-ordering]',
    SERVICES: 'ul li ul li[id]',
};

export const PSN_POST_TYPE_BLACKLIST = [
    'EntCoverPhotoEdgeStory',
    'EntVideoCreationStory',
    'EntProfilePictureEdgeStory',
];
