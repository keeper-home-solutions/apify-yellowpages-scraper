const Apify = require('apify');
const axios = require('axios');
const cheerio = require('cheerio');

const { log } = Apify.utils;

Apify.main(async () => {
    // eslint-disable-next-line prefer-const
    let input = await Apify.getInput();

    if (input?.startUrls[0]?.requestsFromUrl) {
        const externalUrls = await axios.get(input.startUrls[0].requestsFromUrl).then((resp) => resp.data);
        let urlArr = [];
        try {
            urlArr = JSON.parse(externalUrls);
        } catch (e) {
            urlArr = externalUrls.split('\n').filter((link) => link !== '').map((link) => {
                return { url: link };
            });
        }
        input.startUrls = urlArr;
    }

    const dataset = await Apify.openDataset();
    const requestQueue = await Apify.openRequestQueue();

    // Check input
    const sOk = input?.search && input?.search.trim().length > 0;
    const lOk = input?.location && input?.location.trim().length > 0;

    if ((!sOk || !lOk) && !input.startUrls) {
        throw new Error(
            'Either "search" and "location" attributes or "startUrls" attribute has to be set!',
        );
    }

    // Add URLs to requestQueue
    if (input?.search && input?.location) {
        const term = encodeURIComponent(input.search.trim());
        const loc = encodeURIComponent(input.location.trim());
        await requestQueue.addRequest({
            url: `https://www.yellowpages.com/search?search_terms=${term}&geo_location_terms=${loc}`,
        });
    }

    if (input.startUrls) {
        for (const sUrl of input.startUrls) {
            const request = typeof sUrl === 'string' ? { url: sUrl } : sUrl;
            if (!request.url || typeof request.url !== 'string') {
                throw new Error(`Invalid startUrl: ${JSON.stringify(sUrl)}`);
            }
            await requestQueue.addRequest(request);
        }
    }

    // Parse extendOutputFunction
    let extendOutputFunction = null;

    if (input.extendOutputFunction) {
        try {
            // eslint-disable-next-line no-eval
            extendOutputFunction = eval(input.extendOutputFunction);
        } catch (e) {
            throw new Error(
                `extendOutputFunction is not a valid JavaScript! Error: ${e}`,
            );
        }

        if (typeof extendOutputFunction !== 'function') {
            throw new Error(
                `extendOutputFunction is not a function! Please fix it or use just default output!`,
            );
        }
    }

    // Parse rating value from element class
    const nums = ['one', 'two', 'three', 'four', 'five'];
    const parseRating = (aClass) => {
        for (let i = 0; i < nums.length; i++) {
            if (aClass.includes(nums[i])) {
                return aClass.includes('half') ? i + 1.5 : i + 1;
            }
        }
        return undefined;
    };

    const proxyConfiguration = await Apify.createProxyConfiguration(input.proxyConfiguration);

    // Create and run crawler
    const crawler = new Apify.CheerioCrawler({
        requestQueue,
        proxyConfiguration,
        handlePageFunction: async ({
            request,
            $,
        }) => {
            const { url } = request;

            // Process result list
            const results = [];
            const resultElems = $('.search-results .result');

            for (const r of resultElems.toArray()) {
                const jThis = $(r);
                const getText = (selector) => {
                    const text = jThis.find(selector).text();
                    return text.length > 0 ? text : undefined;
                };
                const businessSlug = jThis.find('a.business-name').attr('href');

                // Get extended data from detail page
                const res = await axios.get(`https://www.yellowpages.com${businessSlug}`);
                const d = cheerio.load(res.data);
                const email = d('.email-business').attr('href');

                let address = null;
                const addrElem = jThis.find('.adr');
                if (addrElem.children().length > 0) {
                    address = addrElem.children().get().map((t) => t.textContent).join(' ');
                } else {
                    address = addrElem.contents().text().trim();
                }
                const categories = jThis
                    .find('.categories a')
                    .toArray()
                    .map((c) => $(c).text().trim());
                const rating = jThis.find('.result-rating').attr('class');
                const rCount = getText('.result-rating .count')?.trim();
                const website = jThis
                    .find('a.track-visit-website')
                    .attr('href');
                const reviewSnippet = getText('.snippet')?.trim();
                const isInfoSnippet = reviewSnippet && reviewSnippet.includes('From Business');
                const image = jThis.find('a.photo img').attr('src');
                const result = {
                    isAd: getText('.ad-pill')?.trim() === 'Ad' || undefined,
                    url: businessSlug ? `https://www.yellowpages.com${businessSlug}` : undefined,
                    name: getText('.info .n a')?.trim(),
                    address: address.length > 0 && !address.includes('Serving the') ? address : undefined,
                    email: email ? email.split(':')[1] : undefined,
                    phone: getText('.info .phone')?.trim(),
                    website,
                    rating: rating ? parseRating(rating) : undefined,
                    ratingCount: rCount
                        ? parseFloat(rCount.match(/\d+/)[0])
                        : undefined,
                    reviewSnippet: isInfoSnippet ? undefined : reviewSnippet,
                    infoSnippet: isInfoSnippet
                        ? reviewSnippet.slice(15)
                        : undefined,
                    image: image ? image.split('_')[0] : undefined,
                    categories: categories.length > 0 ? categories : undefined,
                };

                if (extendOutputFunction) {
                    try {
                        Object.assign(
                            result,
                            await extendOutputFunction($, jThis),
                        );
                    } catch (e) {
                        log.exception(e, 'extendOutputFunction error:');
                    }
                }

                results.push(result);
            }

            // Check maximum result count
            if (input.maxItems) {
                const count = (await dataset.getInfo()).cleanItemCount;
                if (count + results.length >= input.maxItems) {
                    const allowed = input.maxItems - count;
                    if (allowed > 0) {
                        await dataset.pushData(results.slice(0, allowed));
                    }
                    return process.exit(0);
                }
            }

            log.info(`Found ${results.length} results.`, { url });

            // Store results and enqueue next page
            await dataset.pushData(results);

            const nextUrl = $('.pagination .next').attr('href');

            if (nextUrl) {
                const nextPageReq = await requestQueue.addRequest({
                    url: `http://www.yellowpages.com${nextUrl}`,
                });

                if (!nextPageReq.wasAlreadyPresent) {
                    log.info('Found next page, adding to queue...', { url });
                }
            } else {
                log.info('No next page found', { url });
            }
        },
    });
    await crawler.run();
});
