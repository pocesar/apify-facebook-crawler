import Apify from 'apify';
import type { ElementHandle, Route, Response as HTTPResponse, Page } from 'playwright';
import * as moment from 'moment';
import * as vm from 'vm';

import { InfoError } from './error';
import { CSS_SELECTORS, MOBILE_HOST, DESKTOP_HOST, DESKTOP_ADDRESS, LABELS } from './constants';
import type { FbLocalBusiness, FbSection, FbLabel, FbReview, Schema, FbError, FbGraphQl, FbFT } from './definitions';

const { log, sleep } = Apify.utils;

/**
 * Monkey-patch the handleRequestFunction failed... error
 */
export const patchLog = (crawler: Apify.BasicCrawler) => {
    const originalException = crawler.log.exception.bind(crawler.log);
    crawler.log.exception = (...args) => {
        if (!args?.[1]?.includes('handleRequestFunction')) {
            originalException(...args);
        }
    };
};

/**
 * Transform a input.startUrls, parse requestsFromUrl items as well,
 * into regular urls. Returns an async generator that should be iterated over.
 *
 * @example
 *   for await (const req of fromStartUrls(input.startUrls)) {
 *     await requestQueue.addRequest(req);
 *   }
 *
 */
export const fromStartUrls = async function* (startUrls: any[], name = 'STARTURLS') {
    const rl = await Apify.openRequestList(name, startUrls);

    let rq: Apify.Request | null;

    // eslint-disable-next-line no-cond-assign
    while (rq = await rl.fetchNextRequest()) {
        yield rq;
    }
};

export const isError = (value: FbError | FbGraphQl | null): value is FbError => {
    return !!(value && ('errors' in value));
};

export const createAddPageSearch = (requestQueue: Apify.RequestQueue) => async (termOrUrl?: string) => {
    if (!termOrUrl) {
        return;
    }

    const { url, searchTerm } = (() => {
        const nUrl = new URL(`/public`, DESKTOP_ADDRESS);
        nUrl.searchParams.set('type', 'pages');
        nUrl.searchParams.set('init', 'dir');
        nUrl.searchParams.set('nomc', '0');
        let query: string | null;

        if (!termOrUrl.includes('facebook.com')) {
            query = termOrUrl;
        } else {
            const parsed = new URL(termOrUrl, DESKTOP_ADDRESS);
            query = parsed.searchParams.get('query');
        }

        if (query) {
            nUrl.searchParams.set('query', query);
        }

        return {
            url: nUrl.toString(),
            searchTerm: query,
        };
    })();

    if (!searchTerm || !url) {
        return;
    }

    log.debug('Adding search', { url, searchTerm });

    await requestQueue.addRequest({
        url,
        userData: {
            label: LABELS.SEARCH,
            searchTerm,
        },
    });
};

/**
 * Takes a story.php and turns into a cleaned desktop permalink.php
 */
export const storyFbToDesktopPermalink = ({ url, postId, username }: { url?: string | null, postId?: string, username?: string }) => {
    if (!url) {
        return null;
    }

    const parsed = new URL(url, DESKTOP_ADDRESS);
    parsed.host = DESKTOP_HOST;

    if (!postId) {
        if (parsed.searchParams.has('story_fbid')
            && parsed.searchParams.has('id')
            && !parsed.pathname.includes('/photos')
            && !parsed.pathname.includes('/video')) {
            parsed.pathname = '/permalink.php';
        }
    } else if (!parsed.pathname.includes('/permalink.php') || !parsed.pathname.includes('/story.php')) {
        parsed.pathname = `${username || parsed.pathname.split('/', 2)[1]}/posts/${postId}`;
    }

    parsed.searchParams.forEach((_, key) => {
        if (!(parsed.pathname.includes('/posts') ? [] : ['story_fbid', 'id', 'substory_index', 'type']).includes(key)) {
            parsed.searchParams.delete(key);
        }
    });

    parsed.searchParams.delete('__tn__'); // force deletion

    return parsed;
};

/**
 * Convert date types to milliseconds.
 * Supports years '2020', '2010-10-10', 1577836800000, 1577836800, '2020-01-01T00:00:00.000Z'
 *
 * Returns "Infinity" if value is not provided or falsy
 */
export function convertDate(value: string | number | Date | undefined | null, isoString: true): string;
export function convertDate(value?: string | number | Date | null): number; // eslint-disable-line no-redeclare
export function convertDate(value?: string | number | Date | null, isoString = false) { // eslint-disable-line no-redeclare
    if (!value) {
        return isoString ? '2100-01-01T00:00:00.000Z' : Infinity;
    }

    if (value instanceof Date) {
        return isoString ? value.toISOString() : value.getTime();
    }

    let tryConvert = new Date(value);

    // catch values less than year 2002
    if (Number.isNaN(tryConvert.getTime()) || `${tryConvert.getTime()}`.length < 13) {
        if (typeof value === 'string') {
            // convert seconds to miliseconds
            tryConvert = new Date(value.length >= 13 ? +value : +value * 1000);
        } else if (typeof value === 'number') {
            // convert seconds to miliseconds
            tryConvert = new Date(`${value}`.length >= 13 ? value : value * 1000);
        }
    }

    return isoString ? tryConvert.toISOString() : tryConvert.getTime();
}

/**
 * Resolves a promise from the outside
 */
export const deferred = <T = any>() => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    let resolve: (value?: T | PromiseLike<T>) => void = () => {};
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    let reject: (error: Error) => void = () => {};
    let resolved = false;

    const promise = new Promise<T | undefined>((r1, r2) => {
        resolve = (arg) => {
            if (!resolved) {
                resolved = true;
                r1(arg);
            }
        };

        reject = (arg) => {
            if (!resolved) {
                resolved = true;
                setTimeout(() => {
                    r2(arg);
                });
            }
        };
    });

    return {
        promise,
        resolve,
        reject,
        get resolved() {
            return resolved;
        },
    };
};

/**
 * Simple stopwatch to measure long running interactions in milliseconds
 */
export const stopwatch = () => {
    const start = Date.now();

    return () => Date.now() - start;
};

/**
 * Execute the callback if the current log level is DEBUG, no-op
 * if not. Removes the need of checking inline
 */
export const executeOnDebug = async (cb: () => Promise<void>) => {
    if (cb && log.getLevel() === log.LEVELS.DEBUG) {
        await cb();
    }
};

/**
 * Remove duplicates from array while filtering falsy values
 */
export const uniqueNonEmptyArray = <T extends any[]>(value: T) => [...new Set(value)].filter(s => s);

/**
 * A helper function to evaluate the same callback in an ElementHandle
 * array, in parallel
 */
export const evaluateFilterMap = async <E extends Element, C extends (el: E) => Promise<any>>(els: ElementHandle<E>[], map: C) => {
    type MapReturn = NonNullable<C extends (...args: any) => PromiseLike<infer R> ? R : any>;

    const values: MapReturn[] = [];

    for (const el of els) {
        try {
            const result = await el.evaluate(map);

            if (result !== undefined && result !== null) {
                values.push(result as unknown as MapReturn);
            }
        } catch (e) {
            // suppress errors, show them on debug
            log.debug(e.message, { values });
        }
    }

    return values;
};

/**
 * Get option overrides from userData
 */
export const overrideUserData = (input: Schema, request: Apify.RequestOptions): { overriden: boolean, settings: Partial<Schema> } => {
    if (!request.userData?.override) {
        return {
            overriden: false,
            settings: {},
        };
    }

    const { override } = request.userData;

    log.debug('Overriden', { override });

    return {
        overriden: true,
        settings: {
            ...input,
            ...override,
        },
    };
};

/**
 * Puppeteer $$ wrapper that gives some context and info
 * if the selector is missing
 */
export const createPageSelector = <E extends Element, C extends (els: ElementHandle<E>[], page: Page) => Promise<any>>(selector: string, namespace: string, map: C) => {
    type MapReturn = NonNullable<C extends (...args: any) => Promise<infer R> ? R : any>;

    return async (page: Page, wait = 0): Promise<MapReturn> => {
        if (page.isClosed()) {
            return map([], page);
        }

        if (!(await page.$$(selector)).length) {
            if (wait > 0) {
                try {
                    await page.waitForSelector(selector, {
                        timeout: wait,
                        state: 'attached',
                    });
                } catch (e) {
                    if (e.name !== 'TimeoutError') {
                        // a non timeout error means something else, we need
                        // to rethrow. a TimeoutError is expected
                        throw e;
                    }
                }

                throw new InfoError(`"${namespace}" page selector not found`, {
                    namespace,
                    selector,
                    url: page.url(),
                });
            }
        }

        return map(await page.$$(selector), page); // never fails, returns [] when not found
    };
};

/**
 * Find a field by image and get it's adjacent div text
 */
export const createSelectorFromImageSrc = (names: string[]) => {
    const selectors = names.map(name => `img[src*="${name}.png"]`).join(',');

    return async (page: Page) => {
        try {
            const content = await page.$$eval(selectors, async (els) => {
                return els.map((el) => {
                    const closest = el.closest('div[id]');

                    if (!closest) {
                        return '';
                    }

                    const textDiv = closest.querySelector<HTMLDivElement>(':scope > div');

                    if (!textDiv) {
                        return '';
                    }

                    window.unc(textDiv);

                    return `${textDiv.innerText || ''}`.trim();
                }).filter(s => s);
            });

            if (!content.length) {
                throw new InfoError('Empty content', {
                    namespace: 'createSelectorFromImageSrc',
                    selector: selectors,
                    url: page.url(),
                });
            }

            return content;
        } catch (e) {
            if (e instanceof InfoError) {
                throw e;
            }

            await executeOnDebug(async () => {
                await Apify.setValue(`image-selector--${names.join('~')}--${Math.random()}`, await page.content() as any, { contentType: 'text/html' });
            });

            throw new InfoError('Image selector not found', {
                namespace: 'createSelectorFromImageSrc',
                selector: selectors,
                url: page.url(),
            });
        }
    };
};

/**
 * Text selectors that uses image names as a starting point
 */
export const imageSelectors = {
    checkins: createSelectorFromImageSrc(['a0b87sO1_bq', '9Zt6zuj8e1D', '2lBnDDIRCyn']),
    website: createSelectorFromImageSrc(['TcXGKbk-rV1', 'xVA3lB-GVep', 'EaDvTjOwxIV', 'aE7VLFYMYdl', '_E0siE7VRxg', 'ZWx4MakmUd4', 'D9kpGIZvg_a']),
    categories: createSelectorFromImageSrc(['Knsy-moHXi6', 'LwDWwC1d0Rx', '3OfQvJdYD_W', 'Esxx6rJcLfG', 'Ae8V14AHXF3', 'I5oOkD-Jgg9', '6QbEglrVsx', 'IRzVOVKydTh']),
    email: createSelectorFromImageSrc(['C1eWXyukMez', 'vKDzW_MdhyP', 'vPTKpTJr2Py', '7wycyFqCurV', 'usNPpfkTtic']),
    info: createSelectorFromImageSrc(['u_owK2Sz5n6', 'fTt3W6Nw8z-', 'ufx6pe0BYZ9', 'nUK82gYKq3c', 'EXVJNaeBMtn']), // about / founded
    impressum: createSelectorFromImageSrc(['7Pg05R2u_QQ', 'xJ79lPp3fxx', 'W1Gz3-6Jba9']),
    instagram: createSelectorFromImageSrc(['EZj5-1P4vhh', 'kupnBwrQuQt', '4BDZkGZPYV7']),
    twitter: createSelectorFromImageSrc(['IP-E0-f5J0m', '4D5dB8JnGdq', 'ITwSn0piq6L']),
    youtube: createSelectorFromImageSrc(['MyCpzAb80U1']),
    overview: createSelectorFromImageSrc(['uAsvCr33XaU', 'J7QgCgbppF8']),
    awards: createSelectorFromImageSrc(['rzXNHRgEfui', 'catvAig7x2x']),
    mission: createSelectorFromImageSrc(['z-wfU5xgk6Z', '3vccp1jK8fn']),
    address: createSelectorFromImageSrc(['h2e1qHNjIzG', 'ya-WX5CZARc', 'PwUkFLBBA85']),
    phone: createSelectorFromImageSrc(['6oGknb-0EsE', 'znYEAkatLCe', 'BaiUsFiMGWy', 'BkWgVZPGfa0']),
    priceRange: createSelectorFromImageSrc(['q-WY9vrfkFZ', 'cAfaJdw2ZpN', 'RoNYAkqnZi0']),
    products: createSelectorFromImageSrc(['bBMZ-3vnEih', '9gnPGIXZf0x', 'kqozvTg_ESH']),
    transit: createSelectorFromImageSrc(['uQHLMTQ0fUS', 'hHYECN5fVxU']),
    payment: createSelectorFromImageSrc(['Dx9c291MaDt', '8qES65kbIT8']),
};

/**
 * General page selectors
 */
export const pageSelectors = {
    searchResults: createPageSelector('#pagelet_loader_initial_browse_result div > a > span', 'searchResults', async (els) => {
        if (!els?.length) {
            return;
        }

        return evaluateFilterMap(els, async (el) => {
            return el.closest<HTMLAnchorElement>('a[href]')?.href;
        });
    }),
    // eslint-disable-next-line max-len
    verified: createPageSelector('#msite-pages-header-contents > div:not([class]):not([id]) > div:not([class]):not([id])', 'mobilePageHeader', async (els) => {
        if (!els.length) {
            return;
        }

        return !!(await els[0].$(CSS_SELECTORS.VERIFIED));
    }),
    messenger: createPageSelector('a[href^="https://m.me"]', 'messenger', async (els) => {
        if (!els.length) {
            return '';
        }

        return els[0].evaluate(async (el) => (el as HTMLLinkElement).href);
    }),
    // returns LD+JSON page information
    ld: createPageSelector(CSS_SELECTORS.LDJSON, 'ld', async (els) => {
        if (!els.length) {
            return [] as FbLocalBusiness[];
        }

        return evaluateFilterMap(els, async (el) => {
            const jsonContent = el.innerHTML;

            if (!jsonContent) {
                return;
            }

            return JSON.parse(jsonContent) as FbLocalBusiness;
        });
    }),
    // get metadata from posts
    posts: createPageSelector(CSS_SELECTORS.POST_TIME, 'posts', async (els) => {
        return evaluateFilterMap(els, async (el) => {
            const article = el.closest<HTMLDivElement>('article');

            if (article) {
                const isPinned = !!(article.parentElement?.querySelector('article ~ img'));
                const url = article.querySelector<HTMLAnchorElement>('a[href^="/story.php"]')?.href;

                if (!url) {
                    return null;
                }

                const { ft } = article.dataset;

                const value = (() => {
                    try {
                        const result = {
                            ft: JSON.parse(ft as any) as FbFT,
                            url,
                            isPinned,
                        };

                        return result;
                    } catch (e) {
                        return null;
                    }
                })();

                try {
                    article.parentElement!.parentElement!.parentElement!.remove();
                    await new Promise((r) => setTimeout(r, 1000));

                    window.scrollBy({ top: window.innerHeight });
                    window.scrollBy({ top: 0 });
                } catch (e) {} // eslint-disable-line

                return value;
            }
        });
    }),
    // get the review average
    reviewAverage: createPageSelector('[style*="background-color: #4267B2;"]', 'reviewAverage', async (els) => {
        if (!els.length) {
            return 0;
        }

        return els[0].evaluate(async (el: HTMLDivElement) => {
            const parent = el.closest<HTMLDivElement>('[style="padding: 0 0 0 0"]');

            if (!parent || !parent.innerText) {
                return 0;
            }

            window.unc(parent);

            return (parent.innerText ? +parent.innerText.replace(/,/g, '.') : 0) || 0;
        });
    }),
    reviews: createPageSelector('abbr[data-store]', 'reviews', async (els): Promise<FbReview[]> => {
        if (!els.length) {
            return [];
        }

        return (await evaluateFilterMap(els, async (el) => {
            const { store } = (el as HTMLSpanElement).dataset;

            if (!store) {
                return null;
            }

            const parse: { time: number } = JSON.parse(store);

            if (!parse || !parse.time) {
                return null;
            }

            const container = el.closest<HTMLDivElement>('div:not([id]):not([class]) > [data-ntid]');

            container?.querySelectorAll('.text_exposed_hide').forEach(te => te.remove()); // emulate "see more"

            window.unc(container);

            const joinInnerText = (selector: string) => [...(container?.querySelectorAll<HTMLDivElement>(selector) ?? [])].map((s) => {
                window.unc(s);
                return s.innerText;
            });

            const title = joinInnerText('[data-nt="FB:TEXT4"]').join('\n') || null;
            const text = joinInnerText('[data-gt]').join('\n') || null;
            const attributes = joinInnerText('[data-nt="FB:EXPANDABLE_TEXT"]').map((s) => s.split('・')).flat();
            const url = container?.querySelector<HTMLAnchorElement>('a[aria-label]')?.href ?? null;

            return {
                title,
                text,
                attributes,
                url,
                date: parse.time,
            };
        })).map((s): FbReview => ({ ...s, canonical: null, date: convertDate(s.date, true) }));
    }),
    latLng: createPageSelector('[style*="static_map.php"]', 'latLng', async (els) => {
        if (!els.length) {
            return { lat: null, lng: null };
        }

        return els[0].evaluate(async (el) => {
            const matches = (el as HTMLImageElement).style.backgroundImage.match(/marker_list%5B0%5D=([^%]+)%2C([^&]+)&/);

            if (!matches || !matches[1] || !matches[2]) {
                return {
                    lat: null,
                    lng: null,
                };
            }

            return {
                lat: +matches[1] || null,
                lng: +matches[2] || null,
            };
        });
    }),
};

/**
 * Takes any Facebook URL and create a page mobile version of it.
 *
 * Forcing /pg/ makes it easy to ensure that the url being accessed is
 * actually a page, as it errors in personal profiles.
 *
 * @throws {TypeError} Throws with malformed urls
 * @param filterParams
 *  Setting to true for removing everything. Using an array of strings acts like a
 *  whitelist, contains parameters that should not be deleted.
 */
export const normalizeToMobilePageUrl = (url: string, filterParams: string[] | boolean = false): string => {
    const parsedUrl = new URL(url);

    if (!parsedUrl.pathname.startsWith('/pg')) {
        parsedUrl.pathname = `/pg/${parsedUrl.pathname.split(/\//g).filter(s => s).join('/')}`;
    }

    if (parsedUrl.hostname !== MOBILE_HOST) {
        parsedUrl.hostname = MOBILE_HOST;
    }

    parsedUrl.searchParams.forEach((_, key) => {
        // query parameters, like refsrc, ref
        if (Array.isArray(filterParams) && filterParams.includes(key)) {
            return;
        }

        if (!filterParams) {
            return;
        }

        parsedUrl.searchParams.delete(key);
    });

    return parsedUrl.toString();
};

/**
 * Take any URL and make a properly formed page url.
 */
export const normalizeOutputPageUrl = (url: string) => {
    const parsedUrl = new URL(url);

    parsedUrl.protocol = 'https:';
    parsedUrl.hostname = DESKTOP_HOST;
    parsedUrl.searchParams.forEach((_, key) => {
        // delete all query strings, like refsrc, ref
        parsedUrl.searchParams.delete(key);
    });
    parsedUrl.pathname = parsedUrl.pathname.replace('/pg/', '');

    return parsedUrl.toString();
};

/**
 * Sets the cookie on the page to the selected locale
 */
export const setLanguageCodeToCookie = async (language: string, page: Page) => {
    await page.context().addCookies([
        {
            domain: '.facebook.com',
            secure: true,
            name: 'locale',
            path: '/',
            value: language.replace('-', '_'),
        },
    ]);
};

/**
 * Sets the cookie on the page to login
 */
export const setLoginToCookie = async (user: string, xs: string, page: Page) => {
    await page.context().addCookies([
        {
            domain: '.facebook.com',
            secure: true,
            name: 'xs',
            path: '/',
            value: xs,
        },
    ]);
    await page.context().addCookies([
        {
            domain: '.facebook.com',
            secure: true,
            name: 'c_user',
            path: '/',
            value: user,
        },
    ]);
};

/**
 * Workaround the /photos/ url
 */
export const photoToPost = (url: string) => {
    const matches = `${url}`.match(/\/photos\/a\.(\d+)/);

    if (matches?.[1]) {
        return storyFbToDesktopPermalink({ url, postId: matches[1] })?.toString();
    }

    return url;
};

/**
 * Detect the type of url start
 *
 * @throws {InfoError}
 */
export const getUrlLabel = (url: string): FbLabel => {
    if (!url) {
        throw new InfoError('Invalid url provided', {
            url,
            namespace: 'getUrlLabel',
        });
    }

    const parsedUrl = new URL(url);

    // works with m.facebook.com, lang-country.facebook.com, www.latest.facebook.com
    if (parsedUrl.hostname.includes('facebook.com')) {
        if (parsedUrl.pathname.includes('/groups/')) {
            throw new InfoError(`Group urls are not supported`, {
                url,
                namespace: 'getUrlLabel',
            });
        }

        if (parsedUrl.pathname.includes('/profile.php')) {
            throw new InfoError(`Profile urls are not supported`, {
                url,
                namespace: 'getUrlLabel',
            });
        }

        if (parsedUrl.pathname.startsWith('/biz/')) {
            return LABELS.LISTING;
        }

        if (/\/photos\/a\.\d+/.test(parsedUrl.pathname)) {
            return LABELS.PHOTO;
        }

        if (/\/posts\/\d+/.test(parsedUrl.pathname)) {
            return LABELS.POST;
        }

        if (/\/(pg)?\/?[a-z0-9.\-%]+\/?/i.test(parsedUrl.pathname)) {
            return LABELS.PAGE;
        }
    }

    throw new InfoError('Invalid Facebook url provided or could not be determined', {
        url,
        namespace: 'getUrlLabel',
    });
};

/**
 * Generates subsection urls from the main page url
 */
export const generateSubpagesFromUrl = (
    url: string,
    pages: FbSection[] = ['posts', 'about', 'reviews', 'services'],
) => {
    const base = normalizeToMobilePageUrl(url, true)
        .split('/', 5) // we are interested in https://m.facebook.com/pg/pagename
        .join('/');

    const urls: Array<{
        useMobile: boolean;
        url: string;
        section: FbSection;
    }> = [{ url: base.toString(), section: 'home', useMobile: true }];

    return urls.concat(pages.map(sub => {
        const subUrl = new URL(base);

        subUrl.pathname += `/${sub}`;
        subUrl.hostname = MOBILE_HOST;

        return {
            url: subUrl.toString(),
            section: sub,
            useMobile: true,
        };
    }));
};

/**
 * Extract the Facebook page name from the url, which are unique
 *
 * @throws {InfoError}
 */
export const extractUsernameFromUrl = (url: string) => {
    if (!url) {
        throw new InfoError('Empty url', {
            url,
            namespace: 'extractUsernameFromUrl',
        });
    }

    const matches = url.match(/facebook.com(?:\/pg)?\/([^/]+)/);

    if (!matches || !matches[1]) {
        throw new InfoError('Couldn\'t match username in url', {
            url,
            namespace: 'extractUsernameFromUrl',
        });
    }

    return matches[1];
};

export interface ScrollUntilOptions {
    selectors?: string[];
    /**
     * Returning true means stop
     */
    maybeStop?: (param: {
        count: number;
        scrollChanged: boolean;
        bodyChanged: boolean;
        scrollSize: number;
        heightSize: number;
    }) => Promise<boolean>;
    sleepMillis: number;
    doScroll?: () => boolean;
}

/**
 * Scrolls until find a selector or stop from the outside
 */
export const scrollUntil = async (page: Page, { doScroll = () => true, sleepMillis, selectors = [], maybeStop }: ScrollUntilOptions) => {
    const scrolls = new Set<number>();
    const heights = new Set<number>();
    let count = 0;
    let lastCount = 0;
    const url = page.url();

    const isChanging = (histogram: Set<number>, num: number) => {
        if (num === undefined || num === null) {
            return false;
        }

        if (histogram.size <= lastCount) {
            return false;
        }

        lastCount = histogram.size;

        return [...histogram].every(val => (num !== val));
    };

    const shouldContinue = async ({ scrollChanged, bodyChanged }: {
            scrollChanged: boolean;
            bodyChanged: boolean;
        }) => {
        if (page.isClosed()) {
            return false;
        }

        if (selectors.length) {
            const foundSelectors = await page.evaluate(async (sels: string[]) => {
                return sels.some((z) => {
                    return [...document.querySelectorAll(z)].some(el => (window.innerHeight - el.getBoundingClientRect().top > 0));
                });
            }, selectors);

            if (foundSelectors) {
                // found a selector
                log.debug('Found selectors', { selectors, url });

                return false;
            }
        }

        if (maybeStop && await maybeStop({
            count,
            scrollChanged,
            bodyChanged,
            heightSize: heights.size,
            scrollSize: scrolls.size,
        })) {
            // stop from the outside
            return false;
        }

        return true;
    };

    log.debug('Scrolling page', {
        url,
        selectors,
    });

    // eslint-disable-next-line no-constant-condition
    while (true) {
        await sleep(sleepMillis);

        if (doScroll()) {
            await sleep(sleepMillis);

            if (page.isClosed()) {
                break;
            }

            await page.evaluate(() => {
                window.scrollBy({
                    top: Math.round(window.innerHeight / 1.15) || 100,
                });
            });

            await sleep(sleepMillis);

            if (page.isClosed()) {
                break;
            }

            const lastScroll = await page.evaluate(async () => window.scrollY);
            const scrollChanged = isChanging(scrolls, lastScroll);

            if (lastScroll) {
                scrolls.add(lastScroll);
            }

            if (page.isClosed()) {
                break;
            }

            const bodyHeight = await page.evaluate(async () => document.body.scrollHeight);
            const bodyChanged = isChanging(heights, bodyHeight);

            if (bodyHeight) {
                heights.add(bodyHeight);
            }

            log.debug('Scroll data', {
                url,
                scrollChanged,
                lastScroll,
                scrolls: [...scrolls],
                bodyChanged,
                bodyHeight,
                heights: [...heights],
                count,
            });

            // wait more and more for each expected length
            await sleep(sleepMillis);

            if (!await shouldContinue({ scrollChanged, bodyChanged })) {
                break;
            }

            count++;
        }
    }

    log.debug('Stopped scrolling', { url });
};

/**
 * Click "See More" independently of language
 */
export const clickSeeMore = async (page: Page) => {
    let clicks = 0;

    for (const seeMore of await page.$$(CSS_SELECTORS.SEE_MORE)) {
        try {
            if (page.isClosed()) {
                break;
            }

            log.info('Clicking see more', { url: page.url() });

            const promise = page.waitForResponse((r: HTTPResponse) => {
                return r.url().includes('ajax/bootloader-endpoint');
            }, { timeout: 10000 });

            await seeMore.evaluate(async (e: HTMLDivElement) => {
                e.closest<HTMLDivElement>('[role="button"]')?.click();
            });
            await promise;

            await sleep(2000);

            clicks++;

            break;
        } catch (e) {
            log.debug(`See more error: ${e.message}`, { url: page.url() });
        }
    }

    if (clicks === 0) {
        log.debug('No See more found', { url: page.url() });
    }

    return clicks > 0;
};

/**
 * Do a generic check when using Apify Proxy
 */
export const proxyConfiguration = async ({
    proxyConfig,
    required = true,
    force = Apify.isAtHome(),
    blacklist = ['GOOGLESERP'],
    hint = [],
}: {
    proxyConfig: any,
    required?: boolean,
    force?: boolean,
    blacklist?: string[],
    hint?: string[],
}) => {
    const configuration = await Apify.createProxyConfiguration(proxyConfig);

    // this works for custom proxyUrls
    if (required) {
        if (!configuration || (!configuration.usesApifyProxy && !configuration.proxyUrls?.length) || !configuration.newUrl()) {
            throw new Error(`\n=======\nYou're required to provide a valid proxy configuration\n\n=======`);
        }
    }

    // check when running on the platform by default
    if (force) {
        // only when actually using Apify proxy it needs to be checked for the groups
        if (configuration?.usesApifyProxy) {
            if (blacklist.some((blacklisted) => configuration.groups?.includes(blacklisted))) {
                throw new Error(`\n=======\nThese proxy groups cannot be used in this actor. Choose other group or contact support@apify.com to give you proxy trial:\n\n*  ${blacklist.join('\n*  ')}\n\n=======`);
            }

            // specific non-automatic proxy groups like RESIDENTIAL, not an error, just a hint
            if (hint.length && !hint.some((group) => configuration.groups?.includes(group))) {
                Apify.utils.log.info(`\n=======\nYou can pick specific proxy groups for better experience:\n\n*  ${hint.join('\n*  ')}\n\n=======`);
            }
        }
    }

    return configuration as Apify.ProxyConfiguration | undefined;
};

export interface MinMax {
    min?: number | string;
    max?: number | string;
}

const parseTimeUnit = (value: any) => {
    if (!value) {
        return null;
    }

    if (value === 'today' || value === 'yesterday') {
        return (value === 'today' ? moment() : moment().subtract(1, 'day')).startOf('day');
    }

    const [, number, unit] = `${value}`.match(/^(\d+)\s?(minute|second|day|hour|month|year|week)s?$/i) || [];

    if (+number && unit) {
        return moment().subtract(+number, unit as any);
    }

    return moment(value);
};

export type MinMaxDates = ReturnType<typeof minMaxDates>

/**
 * Generate a function that can check date intervals depending on the input
 */
export const minMaxDates = ({ min, max }: MinMax) => {
    const minDate = parseTimeUnit(min);
    const maxDate = parseTimeUnit(max);

    if (minDate && maxDate && maxDate.diff(minDate) < 0) {
        throw new Error(`Minimum date ${minDate.toString()} needs to be less than max date ${maxDate.toString()}`);
    }

    return {
        /**
         * cloned min date, if set
         */
        get minDate() {
            return minDate?.clone();
        },
        /**
         * cloned max date, if set
         */
        get maxDate() {
            return maxDate?.clone();
        },
        /**
         * compare the given date/timestamp to the time interval
         */
        compare(time: string | number) {
            const base = moment(time);
            return (minDate ? minDate.diff(base) <= 0 : true) && (maxDate ? maxDate.diff(base) >= 0 : true);
        },
    };
};

const images = {
    png: {
        contentType: 'image/png',
        body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVQYV2P4DwABAQEAWk1v8QAAAABJRU5ErkJggg==', 'base64'),
    },
    gif: {
        contentType: 'image/gif',
        body: Buffer.from('R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs=', 'base64'),
    },
    jpg: {
        contentType: 'image/jpeg',
        body: Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64'),
    },
};

/**
 * Cache page resources depending on regex paths
 */
export const resourceCache = (paths: RegExp[]) => {
    // Cache resources to ease the data transfer
    const cache = new Map<string, {
        loaded: boolean,
        contentType?: string,
        content?: Buffer,
        headers?: any
    }>();

    return async (page: Page) => {
        const response = async (res: HTTPResponse) => {
            try {
                if (page.isClosed()) {
                    await cleanup();
                    return;
                }

                if (['script', 'stylesheet'].includes(res.request().resourceType())) {
                    const url = res.url();
                    const content = cache.get(url);

                    if (content && !content.loaded) {
                        const buffer = await res.body();

                        /* eslint-disable */
                        const {
                            date,
                            expires,
                            'last-modified': lastModified,
                            'content-length': contentLength,
                            ...headers
                        } = res.headers();
                        /* eslint-enable */

                        cache.set(url, {
                            contentType: res.headers()['content-type'],
                            loaded: buffer.length > 0,
                            content: buffer,
                            headers,
                        });
                    }
                }
            } catch (e) {
                await cleanup();
                log.debug('Cache error', { e: e.message });
            }
        };

        const request = async (route: Route) => {
            if (page.isClosed()) {
                await cleanup();
                return;
            }

            const req = route.request();

            const url = req.url();

            try {
                if ([
                    '.woff',
                    '.webp',
                    '.mov',
                    '.mpeg',
                    '.mpg',
                    '.mp4',
                    '.woff2',
                    '.ttf',
                    '.ico',
                    'static_map.php',
                    'ajax/bz',
                ].some((resource) => url.includes(resource))) {
                    await route.abort();
                    return;
                }

                if (req.resourceType() === 'image') {
                    // serve empty images so the `onload` events don't fail
                    if (url.includes('.jpg') || url.includes('.jpeg')) {
                        return await route.fulfill(images.jpg);
                    }

                    if (url.includes('.png')) {
                        return await route.fulfill(images.png);
                    }

                    if (url.includes('.gif')) {
                        return await route.fulfill(images.gif);
                    }
                } else if (['script', 'stylesheet'].includes(req.resourceType()) && paths.some((path) => path.test(url))) {
                    const content = cache.get(url);

                    // log.debug('Cache', { url, headers: content?.headers, type: content?.contentType, length: content?.content?.length });

                    if (content?.loaded === true) {
                        return await route.fulfill({
                            body: content.content,
                            status: 200,
                            contentType: content.contentType,
                            headers: content.headers,
                        });
                    }

                    cache.set(url, {
                        loaded: false,
                    });
                }

                await route.continue();
            } catch (e) {
                await cleanup();
                log.debug('Resource cache', { e: e.message });
            }
        };

        const cleanup = async () => {
            try {
                await page.unroute('**/*');
                page.off('response', response);
            } catch (e) {
                log.debug('Cache', { error: e.message });
            }
        };

        await page.route('**/*', request);
        page.on('response', response);
    };
};

export const dateRangeItemCounter = (minMax: MinMaxDates) => {
    let total = 0;
    const max = {
        older: 0,
        newer: 0,
    };
    const min = {
        older: 0,
        newer: 0,
    };
    let outOfRange = 0;
    let empty = 0;
    let inRange = 0;
    let calls = 0;
    const willCheckRange = !!minMax.maxDate && !!minMax.minDate;

    return {
        stats() {
            return {
                total,
                outOfRange,
                max,
                min,
                empty,
                calls,
                inRange,
            };
        },
        empty(predicate: boolean) {
            calls++;

            if (predicate) {
                empty++;
            }

            log.debug('empty', { calls, predicate, empty });
        },
        add(value: number) {
            calls++;

            total += value;

            log.debug('add', { calls, value, total });
        },
        time(value: string | number) {
            const compare = minMax.compare(value);

            if (!compare) {
                log.debug('out of range', { value });
                outOfRange++;
                if (minMax.maxDate) {
                    if ((minMax.maxDate.diff(value) ?? 0) > 0) {
                        log.debug('max older', { value });
                        max.older++;
                    } else if ((minMax.maxDate.diff(value) ?? 0) < 0) {
                        log.debug('max newer', { value });
                        max.newer++;
                    }
                }

                if (minMax.minDate) {
                    if ((minMax.minDate.diff(value) ?? 0) < 0) {
                        log.debug('min newer', { value });
                        min.newer++;
                    } else if ((minMax.minDate.diff(value) ?? 0) > 0) {
                        log.debug('min older', { value });
                        min.older++;
                    }
                }
            } else {
                log.debug('in range', { value });
                inRange++;
            }

            return compare;
        },
        isOver() {
            // eslint-disable-next-line no-nested-ternary
            return calls > 0 && total > 0
                ? (willCheckRange && inRange > 0 ? (outOfRange / total) + (inRange / total) > 0.95 : false)
                    || (empty ? empty / total > 0.8 : false)
                : false;
        },
    };
};

type PARAMS<T, CUSTOMDATA = any> = T & {
    Apify: typeof Apify;
    customData: CUSTOMDATA;
    request: Apify.Request;
};

/**
 * Compile a IO function for mapping, filtering and outputing items.
 * Can be used as a no-op for interaction-only (void) functions on `output`.
 * Data can be mapped and filtered twice.
 *
 * Provided base map and filter functions is for preparing the object for the
 * actual extend function, it will receive both objects, `data` as the "raw" one
 * and "item" as the processed one.
 *
 * Always return a passthrough function if no outputFunction provided on the
 * selected key.
 */
export const extendFunction = async <RAW, INPUT extends Record<string, any>, MAPPED, HELPERS extends Record<string, any>>({
    key,
    output,
    filter,
    map,
    input,
    helpers,
}: {
    key: string,
    map?: (data: RAW, params: PARAMS<HELPERS>) => Promise<MAPPED>,
    output?: (data: MAPPED, params: PARAMS<HELPERS>) => Promise<void>,
    filter?: (obj: { data: RAW, item: MAPPED }, params: PARAMS<HELPERS>) => Promise<boolean>,
    input: INPUT,
    helpers: HELPERS,
}) => {
    const base = {
        ...helpers,
        Apify,
        customData: input.customData || {},
    } as PARAMS<HELPERS>;

    const evaledFn = (() => {
        // need to keep the same signature for no-op
        if (typeof input[key] !== 'string' || input[key].trim() === '') {
            return new vm.Script('({ item }) => item');
        }

        try {
            return new vm.Script(input[key], {
                lineOffset: 0,
                produceCachedData: false,
                displayErrors: true,
                filename: `${key}.js`,
            });
        } catch (e) {
            throw new Error(`"${key}" parameter must be a function`);
        }
    })();

    /**
     * Returning arrays from wrapper function split them accordingly.
     * Normalize to an array output, even for 1 item.
     */
    const splitMap = async (value: any, args: any) => {
        const mapped = map ? await map(value, args) : value;

        if (!Array.isArray(mapped)) {
            return [mapped];
        }

        return mapped;
    };

    return async <T extends Record<string, any>>(data: RAW, args: T) => {
        const merged = { ...base, ...args };

        for (const item of await splitMap(data, merged)) {
            if (filter && !(await filter({ data, item }, merged))) {
                continue; // eslint-disable-line no-continue
            }

            const result = await (evaledFn.runInThisContext()({
                ...merged,
                data,
                item,
            }));

            for (const out of (Array.isArray(result) ? result : [result])) {
                if (output) {
                    if (out !== null) {
                        await output(out, merged);
                    }
                    // skip output
                }
            }
        }
    };
};
