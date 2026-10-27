'use strict';

const dns = require('dns').promises;
const net = require('net');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

// In-memory cache for official eBay OAuth application token
let ebayTokenCache = {
  token: null,
  expiresAt: 0,
  key: null
};

/**
 * Returns the appropriate eBay API base URL (sandbox or production).
 */
function getEbayApiBaseUrl() {
  const env = (process.env.EBAY_ENV || '').toLowerCase();
  const clientId = process.env.EBAY_CLIENT_ID || '';
  if (env === 'sandbox' || clientId.includes('-SBX-') || clientId.startsWith('SBX-')) {
    return 'https://api.sandbox.ebay.com';
  }
  return 'https://api.ebay.com';
}

/**
 * Checks if an IP is within private, loopback, or link-local ranges.
 */
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    // 127.0.0.0/8 (loopback)
    if (parts[0] === 127) return true;
    // 10.0.0.0/8 (private)
    if (parts[0] === 10) return true;
    // 172.16.0.0/12 (private)
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.168.0.0/16 (private)
    if (parts[0] === 192 && parts[1] === 168) return true;
    // 169.254.0.0/16 (link-local)
    if (parts[0] === 169 && parts[1] === 254) return true;
    // 0.0.0.0
    if (parts[0] === 0) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    // fe80::/10 link-local
    if (lower.startsWith('fe80:')) return true;
    // fc00::/7 unique local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    return false;
  }
  return true;
}

/**
 * Validates a URL against SSRF attacks before requesting it.
 */
async function validateUrlForSsrf(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL format');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https protocols are supported');
  }

  const hostname = parsed.hostname;
  if (!hostname || hostname === 'localhost') {
    throw new Error('Access to localhost is prohibited');
  }

  // Resolve hostname to IP addresses
  try {
    const lookup = await dns.lookup(hostname, { all: true });
    for (const record of lookup) {
      if (isPrivateIp(record.address)) {
        throw new Error(`Access to private address ${record.address} is prohibited`);
      }
    }
  } catch (err) {
    if (err.message.includes('prohibited')) throw err;
    throw new Error(`Failed to resolve host ${hostname}: ${err.message}`);
  }

  return parsed;
}

/**
 * Parses user input to extract eBay item ID or normalized URL.
 */
function parseUrlOrItemId(input) {
  const str = String(input || '').trim();
  // Check if bare 12-digit eBay item ID
  if (/^\d{12}$/.test(str)) {
    return {
      type: 'ebay',
      ebayItemId: str,
      url: `https://www.ebay.com/itm/${str}`
    };
  }

  // Check if eBay URL
  const ebayMatch = str.match(/ebay\.com\/itm\/(?:[^\/]+\/)?(\d{12})/i);
  if (ebayMatch) {
    return {
      type: 'ebay',
      ebayItemId: ebayMatch[1],
      url: `https://www.ebay.com/itm/${ebayMatch[1]}`
    };
  }

  // Generic URL
  if (/^https?:\/\//i.test(str)) {
    return {
      type: 'generic',
      ebayItemId: null,
      url: str
    };
  }

  return {
    type: 'unknown',
    ebayItemId: null,
    url: str
  };
}

/**
 * Obtains an official eBay application OAuth token using client credentials.
 */
async function getEbayAppToken() {
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;

  if (!clientId || !clientSecret) return null;

  const baseUrl = getEbayApiBaseUrl();
  const cacheKey = `${clientId}:${baseUrl}`;
  const now = Date.now();
  if (ebayTokenCache.key === cacheKey && ebayTokenCache.token && ebayTokenCache.expiresAt > now + 60000) {
    return ebayTokenCache.token;
  }

  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const postData = 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope';

  return new Promise((resolve) => {
    const req = https.request(`${baseUrl}/identity/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${creds}`,
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 8000
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) {
            ebayTokenCache.token = json.access_token;
            ebayTokenCache.expiresAt = now + (json.expires_in * 1000);
            ebayTokenCache.key = cacheKey;
            resolve(json.access_token);
          } else {
            console.warn('[eBay API] Failed to get OAuth token:', json);
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', (err) => {
      console.warn('[eBay API] Token request error:', err.message);
      resolve(null);
    });

    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Strategy A: Fetch item details using official eBay Browse API.
 */
async function fetchFromEbayBrowseApi(ebayItemId, zipCode = '08879') {
  const token = await getEbayAppToken();
  if (!token) return null;

  const baseUrl = getEbayApiBaseUrl();
  return new Promise((resolve) => {
    const url = `${baseUrl}/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=${encodeURIComponent(ebayItemId)}`;
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
      'X-EBAY-C-ENDUSERCTX': `contextualLocation=country=US,zip=${encodeURIComponent(zipCode)}`
    };

    const req = https.get(url, { headers, timeout: 8000 }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            return resolve(null);
          }
          const item = JSON.parse(data);
          const priceVal = parseFloat(item.price?.value || 0);
          
          let shippingVal = 0;
          let freeShipping = false;
          let shippingMode = 'amount';

          const shippingOptions = item.shippingOptions || [];
          if (shippingOptions.length > 0) {
            const firstOpt = shippingOptions[0];
            const cost = parseFloat(firstOpt.shippingCost?.value || 0);
            if (cost === 0 || firstOpt.shippingCostType === 'FREE') {
              freeShipping = true;
              shippingMode = 'free';
              shippingVal = 0;
            } else {
              shippingVal = cost;
              shippingMode = 'amount';
            }
          }

          resolve({
            ok: true,
            source: 'api',
            ebayItemId,
            title: item.title || '',
            seller: item.seller?.username || '',
            price: priceVal,
            shipping: shippingVal,
            freeShipping,
            shippingMode,
            condition: item.condition || '',
            ended: item.estimatedAvailabilities?.[0]?.estimatedAvailabilityStatus === 'OUT_OF_STOCK',
            url: item.itemWebUrl || `https://www.ebay.com/itm/${ebayItemId}`
          });
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/**
 * Safe HTTP fetch with SSRF verification, redirect checks, size cap (2MB), and timeout (8s).
 */
async function safeFetchHtml(targetUrl, maxRedirects = 3) {
  let currentUrl = targetUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const parsed = await validateUrlForSsrf(currentUrl);
    const client = parsed.protocol === 'https:' ? https : http;

    const result = await new Promise((resolve, reject) => {
      const options = {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Sec-Ch-Ua': '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"Windows"',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1'
        },
        timeout: 8000
      };

      const req = client.get(parsed, options, (res) => {
        // Handle redirect
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          const nextLoc = new URL(res.headers.location, currentUrl).href;
          res.resume(); // discard body
          return resolve({ redirect: nextLoc });
        }

        if (res.statusCode < 200 || res.statusCode >= 400) {
          res.resume();
          return resolve({ error: `HTTP ${res.statusCode}` });
        }

        let totalBytes = 0;
        const chunks = [];
        res.on('data', chunk => {
          totalBytes += chunk.length;
          if (totalBytes > 2 * 1024 * 1024) { // 2MB limit
            req.destroy(new Error('Response exceeded 2MB limit'));
          } else {
            chunks.push(chunk);
          }
        });

        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({ body, finalUrl: currentUrl });
        });
      });

      req.on('error', err => reject(err));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timed out'));
      });
    });

    if (result.redirect) {
      currentUrl = result.redirect;
    } else {
      return result;
    }
  }

  throw new Error('Too many redirects');
}

/**
 * Strategy B: Direct HTML / JSON-LD / OpenGraph parser.
 */
async function scrapeUrlMetadata(targetUrl, ebayItemId = null) {
  const fetchRes = await safeFetchHtml(targetUrl);
    if (fetchRes.error) {
      const msg = fetchRes.error.includes('403')
        ? 'eBay blocked direct scraping (HTTP 403). Enter listing details manually or use eBay API keys.'
        : `Could not auto-fetch listing (${fetchRes.error}). Please enter details manually.`;
      return { ok: false, reason: fetchRes.error, message: msg };
    }

  const html = fetchRes.body || '';

  // Check for eBay bot-check / verification page
  if (
    html.includes('id="captcha"') ||
    html.includes('challenge-running') ||
    html.includes('Security Measure') ||
    html.includes('verify that you are human')
  ) {
    return { ok: false, reason: 'blocked', message: "eBay blocked the automated request. Please enter listing details manually." };
  }

  let title = '';
  let price = 0;
  let shipping = 0;
  let freeShipping = false;
  let shippingMode = 'amount';
  let seller = '';
  let ended = false;

  // 1. Try parsing JSON-LD Schema (common on eBay, WooCommerce, Shopify, etc.)
  const jsonLdMatches = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  if (jsonLdMatches) {
    for (const tag of jsonLdMatches) {
      const content = tag.replace(/<script[^>]*>|<\/script>/gi, '').trim();
      try {
        const parsed = JSON.parse(content);
        const product = parsed['@graph']
          ? parsed['@graph'].find(item => item['@type'] === 'Product') || parsed['@graph'][0]
          : parsed;

        if (product && (product['@type'] === 'Product' || product.offers)) {
          if (product.name && !title) title = product.name;
          const offers = Array.isArray(product.offers) ? product.offers[0] : product.offers;
          if (offers) {
            if (offers.price && !price) price = parseFloat(offers.price);
            if (offers.availability && String(offers.availability).includes('OutOfStock')) {
              ended = true;
            }
            if (offers.shippingDetails?.shippingRate?.value !== undefined) {
              const shipVal = parseFloat(offers.shippingDetails.shippingRate.value);
              if (shipVal === 0) {
                freeShipping = true;
                shippingMode = 'free';
              } else {
                shipping = shipVal;
              }
            }
          }
        }
      } catch {
        // Ignore JSON-LD parse errors
      }
    }
  }

  // 2. Fallback Title parsing
  if (!title) {
    const ogTitle = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
    if (ogTitle) {
      title = ogTitle[1].replace(/\|.*$/i, '').trim();
    } else {
      const titleTag = html.match(/<title>([^<]+)<\/title>/i);
      if (titleTag) {
        title = titleTag[1].replace(/\|.*$/i, '').replace(/- eBay$/i, '').trim();
      }
    }
  }

  // 3. Fallback Seller parsing
  const sellerMatch =
    html.match(/"seller":\{"username":"([^"]+)"/i) ||
    html.match(/seller-persona[^>]*>.*?<span[^>]*class="[^"]*ux-textspans--BOLD[^"]*"[^>]*>([^<]+)<\/span>/is) ||
    html.match(/class="mbg-nw">([^<]+)</i);
  if (sellerMatch) {
    seller = sellerMatch[1].trim();
  }

  // 4. Fallback Price parsing
  if (!price) {
    const priceMatch =
      html.match(/itemprop=["']price["'][^>]*content=["']([\d.]+)["']/i) ||
      html.match(/class=["'][^"']*x-price-primary[^"']*["'][^>]*>.*?([\d,]+\.\d{2})/is) ||
      html.match(/id=["']prcIsum["'][^>]*>.*?([\d,]+\.\d{2})/is);
    if (priceMatch) {
      price = parseFloat(priceMatch[1].replace(/,/g, ''));
    }
  }

  // 5. Fallback Shipping parsing
  if (!freeShipping && shipping === 0) {
    if (/Free\s+(?:Standard|Economy|Shipping|Delivery)/i.test(html) || /Free\s+\d+-\w+\s+day\s+shipping/i.test(html)) {
      freeShipping = true;
      shippingMode = 'free';
      shipping = 0;
    } else {
      const shipMatch = html.match(/(?:shipping|shipping-cost)[^>]*>.*?\$([\d,]+\.\d{2})/is);
      if (shipMatch) {
        shipping = parseFloat(shipMatch[1].replace(/,/g, ''));
        shippingMode = 'amount';
      }
    }
  }

  // Check ended status
  if (/This listing was ended by the seller/i.test(html) || /out of stock/i.test(html)) {
    ended = true;
  }

  return {
    ok: true,
    source: 'scrape',
    ebayItemId,
    title,
    seller: seller || (targetUrl.includes('ebay.com') ? 'eBay' : new URL(targetUrl).hostname),
    price,
    shipping,
    freeShipping,
    shippingMode,
    condition: 'Used',
    ended,
    url: targetUrl
  };
}

/**
 * Main entry point: Fetch metadata for a given URL or eBay item ID.
 */
async function fetchListingMetadata(input, zipCode = '08879') {
  const parsed = parseUrlOrItemId(input);
  if (parsed.type === 'unknown') {
    return { ok: false, reason: 'Invalid input. Please enter an eBay URL, Item ID, or vendor URL.' };
  }

  // Strategy A: If eBay item ID and API credentials exist, use official API
  if (parsed.ebayItemId && process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET) {
    try {
      const apiRes = await fetchFromEbayBrowseApi(parsed.ebayItemId, zipCode);
      if (apiRes && apiRes.ok) return apiRes;
    } catch (err) {
      console.warn('[eBay API] Error fetching via Browse API, falling back to scrape:', err.message);
    }
  }

  // Strategy B: Zero-key direct scraper
  try {
    return await scrapeUrlMetadata(parsed.url, parsed.ebayItemId);
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * Verifies if eBay credentials are configured and can generate an OAuth token.
 */
async function checkEbayApiCredentials() {
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return {
      configured: false,
      valid: false,
      environment: null,
      message: 'eBay API credentials are not set in environment or .env'
    };
  }

  const baseUrl = getEbayApiBaseUrl();
  const isSandbox = baseUrl.includes('sandbox');
  const envName = isSandbox ? 'sandbox' : 'production';
  const token = await getEbayAppToken();

  if (token) {
    return {
      configured: true,
      valid: true,
      environment: envName,
      message: `eBay API credentials verified successfully (${envName.toUpperCase()} OAuth token generated).`
    };
  }

  return {
    configured: true,
    valid: false,
    environment: envName,
    message: `eBay API credentials failed authentication with ${envName} endpoint`
  };
}

module.exports = {
  validateUrlForSsrf,
  parseUrlOrItemId,
  fetchListingMetadata,
  checkEbayApiCredentials,
  getEbayAppToken
};
