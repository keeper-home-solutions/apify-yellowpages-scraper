const Apify = require('apify');
const axios = require('axios');

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
    const sOk = input.search && input.search.trim().length > 0;
    const lOk = input.location && input.location.trim().length > 0;

    if ((!sOk || !lOk) && !input.startUrls) {
        throw new Error(
            'Either "search" and "location" attributes or "startUrls" attribute has to be set!',
        );
    }

    // Add URLs to requestQueue
    if (input.search && input.location) {
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
                    const text = jThis.find(selector).text().trim();
                    return text.length > 0 ? text : undefined;
                };
                const email = jThis.find('.email-business').attr('href');
                const businessSlug = jThis.find('a.business-name').attr('href');

                // const testElem = '<section id="details-card"><h2 class="section-title">Details</h2><p class="phone"><span>Phone: </span> (972) 460-6860</p><p><span>Address: </span>1070 South Kimball Avenue Suite 131, Southlake, TX 76092</p><p class="website"><span>Website: </span><a href="http://www.berkeys.com" data-analytics="{&quot;adclick&quot;:true,&quot;events&quot;:&quot;event7,event5&quot;,&quot;category&quot;:&quot;8008999&quot;,&quot;impression_id&quot;:&quot;9598ad2c-aa8d-4481-afcb-80ad733d9842&quot;,&quot;listing_id&quot;:&quot;1001861031254&quot;,&quot;item_id&quot;:-1,&quot;listing_type&quot;:&quot;sub&quot;,&quot;ypid&quot;:&quot;478332101&quot;,&quot;content_provider&quot;:&quot;GUMP&quot;,&quot;srid&quot;:&quot;00be56a0-d9dc-4b8c-8c8a-97d0b73e195e&quot;,&quot;item_type&quot;:&quot;listing&quot;,&quot;lhc&quot;:&quot;8008999&quot;,&quot;ldir&quot;:&quot;DAMZ&quot;,&quot;rate&quot;:5,&quot;hasTripAdvisor&quot;:false,&quot;pid&quot;:&quot;800000002273642818&quot;,&quot;geography&quot;:&quot;Southlake, TX&quot;,&quot;mip_claimed_status&quot;:&quot;mip_claimed&quot;,&quot;mip_ypid&quot;:&quot;478332101&quot;,&quot;advertiser_listing_id&quot;:&quot;1001861031254&quot;,&quot;advertiser_ypid&quot;:&quot;478332101&quot;,&quot;click_id&quot;:6,&quot;module&quot;:&quot;details&quot;,&quot;target&quot;:&quot;website&quot;,&quot;act&quot;:2,&quot;dku&quot;:&quot;http://www.berkeys.com&quot;,&quot;supermedia&quot;:true,&quot;LOC&quot;:&quot;http://www.berkeys.com&quot;}" rel="nofollow noopener" target="_blank" data-impressed="1">http://www.berkeys.com</a></p></section>';

                // Get address from testElem by searching "Address: " and removing the element that includes the search string
                const address = getText('.adr')
                    || jThis.find("#details-card p:contains('Address:')")
                        .text()
                        .replace('Address:', '')
                        .trim();
                    // || jThis.find('#details-card').
                    // || jThis
                    //     .find('.adr')
                    //     .nextUntil('p')
                    //     .toArray()
                    //     .map((l) => {
                    //         const txt = $(l).text().trim();
                    //         return txt.length > 0 ? txt.padEnd(txt.length + 1, ' ') : undefined;
                    //     })
                    //     .join(', ');
                const categories = jThis
                    .find('.categories a')
                    .toArray()
                    .map((c) => $(c).text().trim());
                const rating = jThis.find('.result-rating').attr('class');
                const rCount = getText('.result-rating .count');
                const website = jThis
                    .find('a.track-visit-website')
                    .attr('href');
                const reviewSnippet = getText('.snippet');
                const isInfoSnippet = reviewSnippet && reviewSnippet.includes('From Business');
                const image = jThis.find('a.photo img').attr('src');
                const result = {
                    isAd: getText('.ad-pill') === 'Ad' || undefined,
                    url: businessSlug ? `https://www.yellowpages.com${businessSlug}` : undefined,
                    name: getText('.info .n a'),
                    address: address.length > 0 ? address : undefined,
                    email: email ? email.split(':')[1] : undefined,
                    phone: getText('.info .phone'),
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
