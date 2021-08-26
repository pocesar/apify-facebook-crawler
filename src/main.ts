import Apify from 'apify';
import { InfoError } from './error';
import { LABELS, CSS_SELECTORS, MOBILE_HOST } from './constants';
import * as fns from './functions';
import {
    getPagesFromListing,
    getPageInfo,
    getPostUrls,
    getFieldInfos,
    getReviews,
    getPostContent,
    getPostComments,
    getServices,
    getPostInfoFromScript,
    isNotFoundPage,
    getPagesFromSearch,
} from './page';
import { statePersistor, emptyState } from './storage';
import type { Schema, FbLabel, FbSection, FbPage, FbCommentsMode, FbPost } from './definitions';

import LANGUAGES = require('./languages.json');

const { log } = Apify.utils;

const {
    getUrlLabel,
    setLanguageCodeToCookie,
    setLoginToCookie,
    normalizeOutputPageUrl,
    extractUsernameFromUrl,
    generateSubpagesFromUrl,
    stopwatch,
    executeOnDebug,
    storyFbToDesktopPermalink,
    proxyConfiguration,
    minMaxDates,
    resourceCache,
    photoToPost,
    extendFunction,
    createAddPageSearch,
    overrideUserData,
    fromStartUrls,
} = fns;

Apify.main(async () => {
    const input: Schema | null = await Apify.getInput() as any;

    if (!input || typeof input !== 'object') {
        throw new Error('Missing input');
    }

    const {
        startUrls = [],
        maxPosts = 3,
        maxPostDate,
        minPostDate,
        maxPostComments = 15,
        maxReviewDate,
        maxCommentDate,
        maxReviews = 3,
        commentsMode = 'RANKED_THREADED',
        scrapeAbout = false,
        countryCode = false,
        minCommentDate,
        scrapeReviews = true,
        scrapePosts = true,
        scrapeServices = true,
        language = 'en-US',
        user_id = null,
        auth_xs = null,
        sessionStorage = '',
        useStealth = false,
        debugLog = false,
        minPostComments,
        minPosts,
        maxConcurrency = 20,
        searchPages = [],
        searchLimit = 10,
    } = input;

    if (debugLog) {
        log.setLevel(log.LEVELS.DEBUG);
    }

    if ((!Array.isArray(startUrls) || !startUrls.length) && !searchPages?.length) {
        throw new Error('You must provide the "startUrls" input');
    }

    if (!Number.isFinite(maxPostComments)) {
        throw new Error('You must provide a finite number for "maxPostComments" input');
    }

    const proxyConfig = await proxyConfiguration({
        proxyConfig: input.proxyConfiguration,
        hint: ['RESIDENTIAL'],
        required: true,
    });

    const residentialWarning = () => {
        if (Apify.isAtHome() && !proxyConfig?.groups?.includes('RESIDENTIAL')) {
            log.warning(`!!!!!!!!!!!!!!!!!!!!!!!\n\nYou're not using RESIDENTIAL proxy group, it won't work as expected. Contact support@apify.com or on Intercom to give you proxy trial\n\n!!!!!!!!!!!!!!!!!!!!!!!`);
        }
    };


    const shaderError = () => {
        if (Apify.isAtHome() && proxyConfig?.groups?.includes('SHADER')) {
            throw new Error(`Scraping Facebook with SHADER proxy group is not allowed! Please use RESIDENTIAL proxy group. Contact our support team through the Intercom widget that should appear on the bottom right corner of your screen for help.`);
        }
    };

    residentialWarning();
    shaderError();

    let handlePageTimeoutSecs = Math.round(60 * (((maxPostComments + maxPosts) || 10) * 0.08)) + 600; // minimum 600s

    if (handlePageTimeoutSecs * 60000 >= 0x7FFFFFFF) {
        log.warning(`maxPosts + maxPostComments parameter is too high, must be less than ${0x7FFFFFFF} milliseconds in total, got ${handlePageTimeoutSecs * 60000}. Loading posts and comments might never finish or crash the scraper at any moment.`, {
            maxPostComments,
            maxPosts,
            handlePageTimeoutSecs,
            handlePageTimeout: handlePageTimeoutSecs * 60000,
        });
        handlePageTimeoutSecs = Math.floor(0x7FFFFFFF / 60000);
    }

    log.info(`Will use ${handlePageTimeoutSecs}s timeout for page`);

    if (!(language in LANGUAGES)) {
        throw new Error(`Selected language "${language}" isn't supported`);
    }

    const { map, state, persistState } = await statePersistor();
    const elapsed = stopwatch();

    const postDate = minMaxDates({
        max: minPostDate,
        min: maxPostDate,
    });

    if (scrapePosts) {
        if (postDate.maxDate) {
            log.info(`\n-------\n\nGetting posts from ${postDate.maxDate.toLocaleString()} and older\n\n-------`);
        }

        if (postDate.minDate) {
            log.info(`\n-------\n\nGetting posts from ${postDate.minDate.toLocaleString()} and newer\n\n-------`);
        }
    }

    const commentDate = minMaxDates({
        min: maxCommentDate,
        max: minCommentDate,
    });

    if (commentDate.minDate) {
        log.info(`Getting comments from ${commentDate.minDate.toLocaleString()} and newer`);
    }

    const reviewDate = minMaxDates({
        min: maxReviewDate,
    });

    if (reviewDate.minDate) {
        log.info(`Getting reviews from ${reviewDate.minDate.toLocaleString()} and newer`);
    }

    const requestQueue = await Apify.openRequestQueue();

    if (!(startUrls?.length) && !(searchPages?.length)) {
        throw new Error('No requests were loaded from startUrls');
    }

    if (proxyConfig?.groups?.includes('RESIDENTIAL')) {
        proxyConfig.countryCode = countryCode ? language.split('-')?.[1] ?? 'US' : 'US';
    }

    log.info(`Using language "${(LANGUAGES as any)[language]}" (${language})`);

    const initSubPage = async (subpage: { url: string; section: FbSection, useMobile: boolean }, request: Apify.Request) => {
        if (subpage.section === 'home') {
            const username = extractUsernameFromUrl(subpage.url);

            // initialize the page. if it's already initialized,
            // use the current content
            await map.append(username, async (value) => {
                return {
                    ...emptyState(),
                    pageUrl: normalizeOutputPageUrl(subpage.url),
                    '#url': subpage.url,
                    '#ref': request.url,
                    ...value,
                };
            });
        }

        await requestQueue.addRequest({
            url: subpage.url,
            userData: {
                override: request.userData.override,
                label: LABELS.PAGE,
                sub: subpage.section,
                ref: request.url,
                useMobile: subpage.useMobile,
            },
        }, { forefront: true });
    };

    const pageInfo = [
        ...(scrapePosts ? ['posts'] : []),
        ...(scrapeReviews ? ['reviews'] : []),
        ...(scrapeServices ? ['services'] : []),
        ...(scrapeAbout ? ['about'] : []),
    ] as FbSection[];

    const addPageSearch = createAddPageSearch(requestQueue);

    for (const search of searchPages) {
        await addPageSearch(search);
    }

    let startUrlCount = 0;

    for await (const request of fromStartUrls(startUrls)) {
        try {
            let { url } = request;
            const urlType = getUrlLabel(url);

            if (urlType === LABELS.PAGE) {
                for (const subpage of generateSubpagesFromUrl(url, pageInfo)) {
                    await initSubPage(subpage, request);
                }
            } else if (urlType === LABELS.SEARCH) {
                await addPageSearch(url);
            } else if (urlType === LABELS.LISTING) {
                await requestQueue.addRequest({
                    url,
                    userData: {
                        override: request.userData.override,
                        label: urlType,
                        useMobile: false,
                    },
                });
            } else if (urlType === LABELS.POST || urlType === LABELS.PHOTO) {
                if (LABELS.PHOTO) {
                    url = photoToPost(url) ?? url;
                }

                const username = extractUsernameFromUrl(url);

                await requestQueue.addRequest({
                    url,
                    userData: {
                        override: request.userData.override,
                        label: LABELS.POST,
                        useMobile: false,
                        username,
                        canonical: storyFbToDesktopPermalink({ url, username })?.toString(),
                    },
                });

                // this is for home
                await initSubPage(generateSubpagesFromUrl(url, [])[0], request);
            }

            startUrlCount++;
        } catch (e) {
            if (e instanceof InfoError) {
                // We want to inform the rich error before throwing
                log.warning(`------\n\n${e.message}\n\n------`, e.toJSON());
            } else {
                throw e;
            }
        }
    }

    log.info(`Starting with ${startUrlCount} URLs`);

    const cache = resourceCache([
        /rsrc\.php/,
    ]);

    const extendOutputFunction = await extendFunction({
        map: async (data: Partial<FbPage>) => data,
        output: async (data) => {
            const finished = new Date().toISOString();

            data["#version"] = 4; // current data format version
            data['#finishedAt'] = finished;

            await Apify.pushData(data);
        },
        input,
        key: 'extendOutputFunction',
        helpers: {
            state,
            LABELS,
            fns,
            postDate,
            commentDate,
            reviewDate,
        },
    });

    const extendScraperFunction = await extendFunction({
        output: async () => {}, // eslint-disable-line @typescript-eslint/no-empty-function
        key: 'extendScraperFunction',
        input,
        helpers: {
            state,
            handlePageTimeoutSecs,
            cache,
            requestQueue,
            LABELS,
            addPageSearch,
            map,
            fns,
            postDate,
            commentDate,
            reviewDate,
        },
    });

    const crawler = new Apify.PlaywrightCrawler({
        requestQueue,
        useSessionPool: true,
        sessionPoolOptions: {
            persistStateKeyValueStoreId: sessionStorage || undefined,
            maxPoolSize: sessionStorage ? 1 : undefined,
            sessionOptions: {
                maxErrorScore: 0.5,
            },
        },
        maxRequestRetries: 10,
        maxConcurrency,
        proxyConfiguration: proxyConfig,
        launchContext: {
            launchOptions: {
                devtools: debugLog,
                headless: false,
            },
        },
        browserPoolOptions: {
            maxOpenPagesPerBrowser: 1, // required to use one IP per tab
            preLaunchHooks: [async (pageId, launchContext) => {
                const { request } = crawler.crawlingContexts.get(pageId);

                const { userData: { useMobile } } = request;

                // listing need to start in a desktop version
                // page needs a mobile viewport
                const userAgent = useMobile
                    ? 'Mozilla/5.0 (Linux; Android 10; SM-A205U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.91 Mobile Safari/537.36'
                    : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 11_3_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.93 Safari/537.36';

                request.userData.userAgent = userAgent;

                launchContext.launchOptions = {
                    ...launchContext.launchOptions,
                    viewport: {
                        height: useMobile ? 1520 : 1080,
                        width: useMobile ? 720 : 1920,
                    },
                    userAgent,
                    bypassCSP: true,
                    ignoreHTTPSErrors: true,
                    locale: language,
                    hasTouch: useMobile,
                    isMobile: useMobile,
                    deviceScaleFactor: useMobile ? 2 : 1,
                };
            }],
            postPageCloseHooks: [async (pageId, browserController) => {
                if (browserController?.launchContext?.session?.isUsable() === false) {
                    log.debug('Closing browser, session is not usable');
                    try {
                        await browserController.close();
                    } catch (e) {
                        // ignore errors when it fails to close
                    }
                }
            }],
        },
        persistCookiesPerSession: sessionStorage !== '',
        handlePageTimeoutSecs, // more comments, less concurrency
        preNavigationHooks: [async ({ page, request, browserController }, gotoOptions) => {
            gotoOptions.waitUntil = request.userData.label === LABELS.POST || (request.userData.label === LABELS.PAGE && ['posts', 'reviews'].includes(request.userData.sub))
                ? 'load'
                : 'domcontentloaded';
            gotoOptions.timeout = 60000;

            await setLanguageCodeToCookie(language, page);

            if (request.userData.label === LABELS.PAGE && request.userData.sub === 'about') {
                if (!user_id || !auth_xs) {
                    throw new InfoError(`You can add User ID and Auth XS params to login ...`, {
                        url: request.url,
                        namespace: 'login',
                        userData,
                    });
                }
                await setLoginToCookie(user_id, auth_xs, page);
            }

            await executeOnDebug(async () => {
                await page.exposeFunction('logMe', (...args: any[]) => {
                    console.log(...args); // eslint-disable-line no-console
                });
            });

            await page.exposeFunction('unc', (element?: HTMLElement) => {
                try {
                    // weird bugs happen in this function, sometimes the dom element has no querySelectorAll for
                    // unknown reasons
                    if (!element) {
                        return;
                    }

                    element.className = '';
                    if (typeof element.removeAttribute === 'function') {
                        // weird bug that sometimes removeAttribute isn't a function?
                        element.removeAttribute('style');
                    }

                    if (typeof element.querySelectorAll === 'function') {
                        for (const el of [...element.querySelectorAll<HTMLElement>('*')]) {
                            el.className = ''; // removing the classes usually unhides

                            if (typeof element.removeAttribute === 'function') {
                                el.removeAttribute('style');
                            }
                        }
                    }
                } catch (e) {}
            });

            await cache(page);

            await page.addInitScript(() => {
                window.onerror = () => {};

                const f = () => {
                    for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-testid="cookie-policy-dialog-accept-button"],[data-cookiebanner="accept_button"],#accept-cookie-banner-label')) {
                        if (btn) {
                            btn.click();
                        }
                    }
                    setTimeout(f, 1000);
                };
                setTimeout(f);
            });
        }],
        postNavigationHooks: [async ({ page, request, browserController }) => {
            if (!page.isClosed()) {
                // TODO: work around mixed context bug
                if (page.url().includes(MOBILE_HOST) && !request.userData.useMobile) {
                    try {
                        await browserController.close();
                    } catch (e) {}
                    throw new InfoError(`Mismatched mobile / desktop`, {
                        namespace: 'internal',
                        url: request.url,
                    });
                }
            }
        }],
        handlePageFunction: async ({ request, page, session, response, browserController }) => {
            const { userData } = request;

            const label: FbLabel = userData.label; // eslint-disable-line prefer-destructuring

            log.debug(`Visiting page ${request.url}`, userData);

            try {
                if (page.url().includes('?next=')) {
                    throw new InfoError(`Content redirected to login page, retrying...`, {
                        url: request.url,
                        namespace: 'login',
                        userData,
                    });
                }

                if (userData.useMobile) {
                    // need to do some checks if the current mobile page is the interactive one or if
                    // it has been blocked
                    if (await page.$(CSS_SELECTORS.MOBILE_CAPTCHA)) {
                        throw new InfoError('Mobile captcha found', {
                            url: request.url,
                            namespace: 'captcha',
                            userData,
                        });
                    }

                    try {
                        await Promise.all([
                            page.waitForSelector(CSS_SELECTORS.MOBILE_META, {
                                timeout: 15000, // sometimes the page takes a while to load the responsive interactive version,
                                state: 'attached',
                            }),
                            page.waitForSelector(CSS_SELECTORS.MOBILE_BODY_CLASS, {
                                timeout: 15000, // correctly detected android. if this isn't the case, the image names will change
                                state: 'attached',
                            }),
                        ]);
                    } catch (e) {
                        throw new InfoError(`An unexpected page layout was returned by the server. This request will be retried shortly.${e.message}`, {
                            url: request.url,
                            namespace: 'mobile-meta',
                            userData,
                        });
                    }
                }

                if (!userData.useMobile && await page.$(CSS_SELECTORS.DESKTOP_CAPTCHA)) {
                    throw new InfoError('Desktop captcha found', {
                        url: request.url,
                        namespace: 'captcha',
                        userData,
                    });
                }

                if (await page.$eval('title', (el) => el.textContent === 'Error') || response.statusCode === 500) {
                    throw new InfoError('Facebook internal error, maybe it\'s going through instability, it will be retried', {
                        url: request.url,
                        namespace: 'internal',
                        userData,
                    });
                }

                if (label !== LABELS.LISTING
                    && label !== LABELS.SEARCH
                    && label !== LABELS.POST
                    && request.userData.sub !== 'posts'
                    && request.userData.sub !== 'about'
                    && response.status() === 404) {
                    request.noRetry = true;

                    // throw away if page is not available
                    // but inform the user of error
                    throw new InfoError('Content not found. This either means the page doesn\'t exist, or the section itself doesn\'t exist (about, reviews, services)', {
                        url: request.url,
                        namespace: 'isNotFoundPage',
                        userData,
                    });
                }

                await page.evaluate(() => {
                    window.onerror = () => {};
                });

                if (label === LABELS.LISTING) {
                    const start = stopwatch();
                    const pagesUrls = await getPagesFromListing(page);

                    for (const url of pagesUrls) {
                        for (const subpage of generateSubpagesFromUrl(url, pageInfo)) {
                            await initSubPage(subpage, request);
                        }
                    }

                    log.info(`Got ${pagesUrls.size} pages from listing in ${start() / 1000}s`);
                } else if (userData.label === LABELS.SEARCH) {
                    const start = stopwatch();
                    let count = 0;

                    for await (const url of getPagesFromSearch(page, searchLimit)) {
                        count++;

                        for (const subpage of generateSubpagesFromUrl(url, pageInfo)) {
                            await initSubPage(subpage, request);
                        }
                    }

                    log.info(`Got ${count} pages from search "${userData.searchTerm}" in ${start() / 1000}s`);
                } else if (userData.label === LABELS.PAGE) {
                    const username = extractUsernameFromUrl(request.url);

                    switch (userData.sub) {
                        // Main landing page
                        case 'home':
                            await map.append(username, async (value) => {
                                const {
                                    likes,
                                    messenger,
                                    title,
                                    verified,
                                    ...address
                                } = await getPageInfo(page);

                                return getFieldInfos(page, {
                                    ...value,
                                    likes,
                                    messenger,
                                    title,
                                    verified,
                                    address: {
                                        lat: null,
                                        lng: null,
                                        ...value?.address,
                                        ...address,
                                    },
                                });
                            });
                            break;
                        // Services if any
                        case 'services':
                            try {
                                const services = await getServices(page);

                                if (services.length) {
                                    await map.append(username, async (value) => {
                                        return {
                                            ...value,
                                            services: [
                                                ...(value?.services ?? []),
                                                ...services,
                                            ],
                                        };
                                    });
                                }
                            } catch (e) {
                                // it's ok to fail here, not every page has services
                                log.debug(e.message);
                            }
                            break;
                        // About if any
                        case 'about':
                            await map.append(username, async (value) => {
                                return getFieldInfos(page, {
                                    ...value,
                                });
                            });
                            break;
                        // Posts
                        case 'posts': {
                            let max = maxPosts;
                            let date = postDate;

                            const { overriden, settings } = overrideUserData(input, request);

                            if (overriden) {
                                if (settings?.maxPosts) {
                                    max = settings.maxPosts;
                                }

                                if (settings?.maxPostDate || settings?.minPostDate) {
                                    date = minMaxDates({
                                        min: settings.maxPostDate,
                                        max: settings.minPostDate,
                                    });
                                }
                            }

                            // We don't do anything here, we enqueue posts to be
                            // read on their own phase/label
                            const postCount = await getPostUrls(page, {
                                max,
                                date,
                                username,
                                requestQueue,
                                request,
                                minPosts,
                            });

                            if (maxPosts && minPosts && postCount < minPosts) {
                                throw new InfoError(`Minimum post count of ${minPosts} not met, retrying...`, {
                                    namespace: 'threshold',
                                    url: page.url(),
                                });
                            }

                            break;
                        }
                        // Reviews if any
                        case 'reviews':
                            try {
                                const reviewsData = await getReviews(page, {
                                    max: maxReviews,
                                    date: reviewDate,
                                    request,
                                });

                                if (reviewsData) {
                                    const { average, count, reviews } = reviewsData;

                                    await map.append(username, async (value) => {
                                        return {
                                            ...value,
                                            reviews: {
                                                ...(value?.reviews ?? {}),
                                                average,
                                                count,
                                                reviews: [
                                                    ...reviews,
                                                    ...(value?.reviews?.reviews ?? []),
                                                ],
                                            },
                                        };
                                    });
                                }
                            } catch (e) {
                                // it's ok for failing here, not every page has reviews
                                log.debug(e.message);
                            }
                            break;
                        // make eslint happy
                        default:
                    }
                } else if (label === LABELS.POST) {
                    const postTimer = stopwatch();

                    log.debug('Started processing post', { url: request.url });

                    // actually parse post content here, it doesn't work on
                    // mobile address
                    const { username } = userData;

                    const [postStats, content] = await Promise.all([
                        getPostInfoFromScript(page, request),
                        getPostContent(page),
                    ]);

                    const { overriden, settings } = overrideUserData(input, request);
                    let mode: FbCommentsMode = commentsMode;
                    let date: typeof commentDate = commentDate;
                    let max = maxPostComments;
                    let minComments = minPostComments;

                    if (overriden) {
                        if (settings?.minCommentDate || settings?.maxCommentDate) {
                            date = minMaxDates({
                                max: settings.minCommentDate,
                                min: settings.maxCommentDate,
                            });
                        }

                        if (settings?.maxPostComments) {
                            max = settings.maxPostComments;
                        }

                        if (settings?.commentsMode) {
                            mode = settings.commentsMode;
                        }

                        if (settings?.minPostComments) {
                            minComments = settings.minPostComments;
                        }
                    }

                    const existingPost = await map.read(username).then((p) => p?.posts?.find((post) => post.postUrl === content.postUrl));
                    const postContent: FbPost = existingPost || {
                        ...content as FbPost,
                        postStats,
                        postComments: {
                            count: 0,
                            mode,
                            comments: [],
                        },
                    };

                    if (!existingPost) {
                        await map.append(username, async (value) => {
                            return {
                                ...value,
                                posts: [
                                    postContent,
                                    ...(value?.posts ?? []),
                                ],
                            } as Partial<FbPage>;
                        });
                    }

                    const postCount = await getPostComments(page, {
                        max,
                        mode,
                        date,
                        request,
                        add: async (comment) => {
                            await map.append(username, async (value) => {
                                postContent.postComments.comments.push(comment);
                                return value;
                            });
                        },
                    });

                    await map.append(username, async (value) => {
                        postContent.postComments.count = postCount;
                        return value;
                    });

                    if (max && minComments && (postContent?.postComments?.comments?.length ?? 0) < minComments) {
                        throw new InfoError(`Minimum comment count ${minComments} not met, retrying`, {
                            namespace: 'threshold',
                            url: page.url(),
                        });
                    }

                    log.info(`Processed post in ${postTimer() / 1000}s`, { url: request.url });
                }
            } catch (e) {
                log.debug(e.message, {
                    url: request.url,
                    userData: request.userData,
                    error: e,
                });

                if (e instanceof InfoError) {
                    // We want to inform the rich error before throwing
                    log.warning(e.message, e.toJSON());

                    if (['captcha', 'mobile-meta', 'getFieldInfos', 'internal', 'login', 'threshold'].includes(e.meta.namespace)) {
                        session.retire();
                        await browserController.close(page);
                    }
                }

                throw e;
            } finally {
                await extendScraperFunction(undefined, {
                    page,
                    request,
                    session,
                    username: extractUsernameFromUrl(request.url),
                    label: 'HANDLE',
                });
            }

            log.debug(`Done with page ${request.url}`);
        },
        handleFailedRequestFunction: async ({ request, error }) => {
            // this only happens when maxRetries is
            // comprised mainly of InfoError, which is usually a problem
            // with pages
            log.exception(error, `The request failed after all ${request.retryCount} retries, last error was:`, error instanceof InfoError
                ? error.toJSON()
                : {});
        },
    });

    await extendScraperFunction(undefined, {
        label: 'SETUP',
        crawler,
    });

    if (!debugLog) {
        fns.patchLog(crawler);
    }

    await crawler.run();

    await extendScraperFunction(undefined, {
        label: 'FINISH',
        crawler,
    });

    await persistState();

    log.info('Generating dataset...');

    // generate the dataset from all the crawled pages
    for (const page of state.values()) {
        await extendOutputFunction(page, {});
    }

    residentialWarning();

    log.info(`Done in ${Math.round(elapsed() / 60000)}m!`);
});
