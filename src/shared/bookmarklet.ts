import { z } from 'zod';
import type { ProjectPayload, Part, Offering, BundleMapping, VendorProfile } from './types.js';
import { isValidHttpUrl } from './types.js';

export const BookmarkletPayloadSchema = z.object({
  url: z.string().trim().refine((val) => isValidHttpUrl(val), {
    message: 'url must be valid http/https',
  }),
  canonicalUrl: z.string().trim().refine((val) => isValidHttpUrl(val), {
    message: 'canonicalUrl must be valid http/https',
  }).optional().default(''),
  vendorHost: z.string().trim().max(150).default(''),
  partName: z.string().trim().max(300).default(''),
  partNumber: z.string().trim().max(100).optional().default(''),
  vendorSku: z.string().trim().max(100).optional().default(''),
  brand: z.string().trim().max(100).optional().default(''),
  price: z.number().nullable().optional().default(null),
  currency: z.string().trim().max(10).default('USD'),
  packageYield: z.number().int().min(1).max(10000).default(1),
  bundleKeywordsFound: z.array(z.string().max(100)).default([]),
  isLikelyBundleOrPack: z.boolean().default(false),
  shippingCost: z.number().nullable().optional().default(null),
  freeShippingDetected: z.boolean().default(false),
  shippingNote: z.string().trim().max(250).optional().default(''),
  inStock: z.boolean().default(true),
  extractionSource: z.array(z.string().max(50)).default([]),
  capturedAt: z.number().optional().default(() => Date.now()),
  installKey: z.string().trim().max(128).optional().default(''),
});

export type BookmarkletPayload = z.infer<typeof BookmarkletPayloadSchema>;

export interface VerifiedBookmarkletCommit {
  bomAction: 'ATTACH_EXISTING' | 'CREATE_NEW';
  targetBomPartId: string | null;
  partName: string;
  partNumber: string;
  price: number;
  packageYield: number;
  shippingCost: number;
  vendorName: string;
  referenceUrl: string;
  vendorSku?: string;
  brand?: string;
  shippingRuleNote?: string;
  inStock?: boolean;
}

export const VENDOR_SHIPPING_PRESETS: Record<
  string,
  {
    vendorName: string;
    defaultShipping: number;
    freeShippingThreshold: number | null;
    note: string;
  }
> = {
  'amazon.com': {
    vendorName: 'Amazon',
    defaultShipping: 6.99,
    freeShippingThreshold: 35.0,
    note: 'Free shipping over $35 (or $0 with Prime)',
  },
  'fcpeuro.com': {
    vendorName: 'FCP Euro',
    defaultShipping: 8.99,
    freeShippingThreshold: 49.0,
    note: 'Free shipping on orders over $49',
  },
  'bhphotovideo.com': {
    vendorName: 'B&H Photo',
    defaultShipping: 6.99,
    freeShippingThreshold: 49.0,
    note: 'Free expedited shipping on orders over $49',
  },
  'digikey.com': {
    vendorName: 'DigiKey',
    defaultShipping: 6.99,
    freeShippingThreshold: 100.0,
    note: 'Standard $6.99 ground shipping; free on qualifying orders over $100',
  },
  'mouser.com': {
    vendorName: 'Mouser Electronics',
    defaultShipping: 7.99,
    freeShippingThreshold: null,
    note: 'UPS/FedEx ground baseline ~$7.99',
  },
  'mcmaster.com': {
    vendorName: 'McMaster-Carr',
    defaultShipping: 9.5,
    freeShippingThreshold: null,
    note: 'Courier/ground shipping billed at cost per order',
  },
  'grainger.com': {
    vendorName: 'Grainger',
    defaultShipping: 10.0,
    freeShippingThreshold: null,
    note: 'Standard ground shipping or free branch pickup',
  },
  'rockauto.com': {
    vendorName: 'RockAuto',
    defaultShipping: 9.99,
    freeShippingThreshold: null,
    note: 'Per-warehouse ground shipping (~$9.99 per warehouse)',
  },
  'microcenter.com': {
    vendorName: 'Micro Center',
    defaultShipping: 5.99,
    freeShippingThreshold: null,
    note: 'In-store pickup ($0) or standard parcel shipping',
  },
  'newegg.com': {
    vendorName: 'Newegg',
    defaultShipping: 0.0,
    freeShippingThreshold: 0.0,
    note: 'Free standard shipping on most items',
  },
};

export function normalizePartNumber(pn: string | null | undefined): string {
  return String(pn || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export function isAmazonAsin(val: string | null | undefined): boolean {
  const trimmed = String(val || '').trim();
  return /^B0[A-Z0-9]{8}$/i.test(trimmed);
}

export function isInvalidOrModelPartNumber(pn: string | null | undefined): boolean {
  const trimmed = String(pn || '').trim();
  if (!trimmed) return true;
  if (
    /^(does not apply|n\/a|none|not applicable|na|null|undefined|unbranded|oem|genuine|see description)$/i.test(
      trimmed
    )
  ) {
    return true;
  }
  // Amazon ASINs (e.g. B0DKFMSMYK) are store catalog IDs (vendorSku), not manufacturer part numbers
  if (isAmazonAsin(trimmed)) {
    return true;
  }
  // Vehicle model names or generic words without any digits (e.g. "CHEVY CORVETTE") are not part numbers
  if (!/\d/.test(trimmed)) {
    return true;
  }
  return false;
}

export function extractPartNumberFromTitle(title: string | null | undefined): string {
  const raw = String(title || '').trim();
  if (!raw) return '';
  const tokens = raw
    .replace(/[()[\],/\\|]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ''))
    .filter(Boolean);

  let bestCandidate = '';
  let bestScore = 0;

  for (const tok of tokens) {
    if (tok.length < 4 || tok.length > 22) continue;
    if (!/^[A-Za-z0-9-]+$/.test(tok)) continue;
    // Skip 4-digit years (1950-2039) or year ranges like 2014-2019, 14-19
    if (/^(19[5-9]\d|20[0-3]\d)(-(19[5-9]\d|20[0-3]\d|\d{2}))?$/.test(tok)) continue;
    // Skip Amazon ASINs
    if (isAmazonAsin(tok)) continue;
    // Skip common measurement/spec tokens like 330mm, 1000W, 12V, 8-Core, 16-Thread
    if (
      /^\d+(\.\d+)?(mm|cm|in|ft|kg|lb|lbs|oz|gb|tb|mb|mhz|ghz|khz|w|kw|v|kv|mah|ah|pc|pcs|pk|core|cores|thread|threads|pin|pins|bit|pack|set|way|ch)$/i.test(
        tok
      )
    ) {
      continue;
    }
    if (
      /^(ddr\d|gddr\d\w*|pcie\d\w*|gen\d|usb\d\w*|wifi\d\w*|am[45]|lga\d+|atx|matx|itx|sff|oem|awd|fwd|rwd|4wd)$/i.test(
        tok
      )
    ) {
      continue;
    }

    const digitCount = (tok.match(/\d/g) || []).length;
    const hasLetter = /[A-Za-z]/.test(tok);
    if (!hasLetter && digitCount < 5) continue;
    if (hasLetter && digitCount < 2) continue;

    let score = digitCount * 2 + (hasLetter ? 4 : 0);
    if (tok.length >= 6 && tok.length <= 16 && digitCount >= 4) {
      score += 10;
    }
    if (tok.includes('-') && hasLetter && digitCount >= 3) {
      score += 5;
    }
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = tok;
    }
  }

  return bestCandidate;
}

export function sanitizeIncomingBookmarkletPayload(incoming: BookmarkletPayload): BookmarkletPayload {
  const next = { ...incoming };
  next.partName = next.partName
    .replace(/\s*[|\-–—]\s*(eBay|Amazon\.com|Mouser|DigiKey|McMaster-Carr|Grainger|FCP Euro|Newegg|B&H Photo|Micro Center).*$/i, '')
    .trim();

  const isEbay =
    next.vendorHost.toLowerCase().includes('ebay.') ||
    next.url.toLowerCase().includes('ebay.');
  const isAmazon =
    next.vendorHost.toLowerCase().includes('amazon.') ||
    next.url.toLowerCase().includes('amazon.');

  if (isEbay && !next.vendorSku) {
    const ebayMatch = next.url.match(/\/itm\/(?:[^/?#]+\/)?(\d{10,14})/);
    if (ebayMatch) {
      next.vendorSku = ebayMatch[1];
    }
  }

  if (isAmazon && !next.vendorSku) {
    const amMatch = next.url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
    if (amMatch) {
      next.vendorSku = amMatch[1].toUpperCase();
    }
  }

  // If Amazon bookmarklet fell back to setting partNumber = ASIN (vendorSku), clear it so we extract the real MPN/model
  if (isAmazon && next.vendorSku && next.partNumber.toUpperCase() === next.vendorSku.toUpperCase()) {
    next.partNumber = '';
  }

  if (isInvalidOrModelPartNumber(next.partNumber)) {
    const fromTitle = extractPartNumberFromTitle(next.partName) || extractPartNumberFromTitle(next.url);
    next.partNumber = fromTitle || '';
  }

  return next;
}

export function scoreBomMatch(incoming: BookmarkletPayload, bomItem: Part): number {
  const inPn = normalizePartNumber(incoming.partNumber);
  const inSku = normalizePartNumber(incoming.vendorSku);
  const bomPn = normalizePartNumber(bomItem.part_number);

  // Exact normalized MPN/SKU match
  if (bomPn && bomPn.length >= 3 && (inPn === bomPn || inSku === bomPn)) {
    return 1.0;
  }
  // Substring MPN containment (e.g. "BOSCH4417" contains "4417")
  if (
    bomPn &&
    bomPn.length >= 4 &&
    ((inPn && (inPn.includes(bomPn) || bomPn.includes(inPn))) ||
      (inSku && (inSku.includes(bomPn) || bomPn.includes(inSku))))
  ) {
    return 0.85;
  }

  // Token overlap on partName
  const tokenize = (s: string) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2);

  const inTokens = new Set(tokenize(incoming.partName));
  const bomTokens = tokenize(bomItem.name);
  if (bomTokens.length === 0 || inTokens.size === 0) return 0;

  let hits = 0;
  for (const t of bomTokens) {
    if (inTokens.has(t)) hits++;
  }
  return (hits / bomTokens.length) * 0.7;
}

export function evaluateImportConfidence(
  incoming: BookmarkletPayload,
  existingBomParts: Part[] = [],
  pinnedBomPartId?: string | null,
  sessionAutoAdd = false,
  isTrustedKey = true,
  isGuestFull = false
): {
  decision: 'AUTO_ADD_TO_EXISTING' | 'AUTO_ADD_AS_NEW' | 'NEEDS_CONFIRMATION';
  targetBomPart: Part | null;
  matchScore: number;
  reasonsToConfirm: string[];
} {
  const reasonsToConfirm: string[] = [];
  const validPrice = typeof incoming.price === 'number' && incoming.price > 0;

  if (!isTrustedKey) {
    reasonsToConfirm.push('Installation key verification failed or opened via external link.');
  }
  if (!validPrice) {
    reasonsToConfirm.push('Price could not be verified automatically on the page.');
  }
  if (incoming.isLikelyBundleOrPack) {
    const detail = incoming.bundleKeywordsFound.join(', ') || `Yield: ${incoming.packageYield}`;
    reasonsToConfirm.push(
      `Detected bundle/pack keywords (${detail}) — verify Package Yield or multi-part mapping.`
    );
  }
  if (isGuestFull) {
    reasonsToConfirm.push('Guest Mode is limited to 10 parts. Please attach to an existing part or sign in.');
  }

  const pinnedPart = pinnedBomPartId
    ? existingBomParts.find((p) => String(p.id) === String(pinnedBomPartId)) || null
    : null;

  let bestMatch: Part | null = null;
  let bestScore = 0;
  for (const bomItem of existingBomParts) {
    const score = scoreBomMatch(incoming, bomItem);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = bomItem;
    }
  }

  // Auto-add condition: trusted key, valid price, no bundle ambiguity, not guest full
  const canAutoAdd = isTrustedKey && validPrice && !incoming.isLikelyBundleOrPack;

  if (canAutoAdd && pinnedPart) {
    return {
      decision: 'AUTO_ADD_TO_EXISTING',
      targetBomPart: pinnedPart,
      matchScore: 1.0,
      reasonsToConfirm: [],
    };
  }

  if (canAutoAdd && bestMatch && bestScore === 1.0) {
    return {
      decision: 'AUTO_ADD_TO_EXISTING',
      targetBomPart: bestMatch,
      matchScore: bestScore,
      reasonsToConfirm: [],
    };
  }

  if (canAutoAdd && sessionAutoAdd && !isGuestFull && bestScore < 0.5) {
    return {
      decision: 'AUTO_ADD_AS_NEW',
      targetBomPart: null,
      matchScore: 0,
      reasonsToConfirm: [],
    };
  }

  if (bestScore >= 0.45 && bestScore < 1.0 && bestMatch) {
    reasonsToConfirm.push(
      `Possible match to existing BOM item "${bestMatch.name}" — confirm whether to attach or create a new BOM part.`
    );
  } else if (existingBomParts.length > 0 && bestScore < 0.45) {
    reasonsToConfirm.push(
      'Part number did not match an existing BOM row — confirm whether this is a new BOM part or an alternate vendor for an existing part.'
    );
  }

  return {
    decision: 'NEEDS_CONFIRMATION',
    targetBomPart: pinnedPart || (bestScore >= 0.45 ? bestMatch : null),
    matchScore: bestScore,
    reasonsToConfirm,
  };
}

export function applyBookmarkletImportToProject(
  prev: ProjectPayload,
  commit: VerifiedBookmarkletCommit
): ProjectPayload {
  const now = Date.now();
  const next = { ...prev };
  const parts = [...prev.parts];
  const offerings = [...prev.offerings];
  const bundleMappings = [...prev.bundle_mappings];
  const vendorProfiles = [...(prev.vendor_profiles || [])];

  let targetPartId = commit.targetBomPartId;

  if (commit.bomAction === 'CREATE_NEW' || !targetPartId) {
    targetPartId = `part_${now}_${Math.random().toString(36).slice(2, 7)}`;
    const newPart: Part = {
      id: targetPartId,
      name: (commit.partName || 'New Part').slice(0, 200).trim(),
      part_number: (commit.partNumber || '').slice(0, 100).trim(),
      category_tag: 'General',
      required_qty: 1,
      sort_order: parts.length,
    };
    parts.push(newPart);
  } else if (commit.partNumber && !isInvalidOrModelPartNumber(commit.partNumber)) {
    const idx = parts.findIndex((p) => p.id === targetPartId);
    if (idx >= 0 && (!parts[idx].part_number || isInvalidOrModelPartNumber(parts[idx].part_number))) {
      parts[idx] = {
        ...parts[idx],
        part_number: commit.partNumber.slice(0, 100).trim(),
      };
    }
  }

  // Create offering in integer cents
  const offeringId = `off_${now}_${Math.random().toString(36).slice(2, 7)}`;
  const priceCents = Math.max(0, Math.round((commit.price || 0) * 100));
  const shippingCents = Math.max(0, Math.round((commit.shippingCost || 0) * 100));

  const newOffering: Offering = {
    id: offeringId,
    vendor_name: (commit.vendorName || 'Unknown Vendor').slice(0, 120).trim(),
    title: (commit.partName || 'Vendor Listing').slice(0, 300).trim(),
    part_number: (commit.partNumber || commit.vendorSku || '').slice(0, 100).trim(),
    reference_url: (commit.referenceUrl || '').slice(0, 2048).trim(),
    price_cents: priceCents,
    shipping_cents: shippingCents,
    discount_cents: 0,
    max_purchasable_qty: null,
    in_stock: commit.inStock !== false,
    notes: (commit.shippingRuleNote || '').slice(0, 500).trim(),
    updated_at: now,
  };
  offerings.push(newOffering);

  // Create BundleMapping connecting offering to target part with yield_qty
  const newMapping: BundleMapping = {
    offering_id: offeringId,
    part_id: targetPartId,
    yield_qty: Math.max(1, commit.packageYield || 1),
  };
  bundleMappings.push(newMapping);

  // Upsert VendorProfile if missing
  const vKey = commit.vendorName.trim().toLowerCase();
  const existingVp = vendorProfiles.find((vp) => vp.vendor_name.trim().toLowerCase() === vKey);
  if (!existingVp) {
    const presetKey = Object.keys(VENDOR_SHIPPING_PRESETS).find((k) =>
      commit.vendorName.toLowerCase().includes(k)
    );
    const preset = presetKey ? VENDOR_SHIPPING_PRESETS[presetKey] : null;

    vendorProfiles.push({
      id: `vp_${now}_${Math.random().toString(36).slice(2, 6)}`,
      vendor_name: commit.vendorName.trim(),
      flat_shipping_cents: preset ? Math.round(preset.defaultShipping * 100) : 0,
      free_shipping_threshold_cents:
        preset && preset.freeShippingThreshold !== null
          ? Math.round(preset.freeShippingThreshold * 100)
          : null,
      tax_rate_bps: prev.default_tax_bps || 0,
    });
  }

  return {
    ...next,
    parts,
    offerings,
    bundle_mappings: bundleMappings,
    vendor_profiles: vendorProfiles,
    version: prev.version || 1,
  };
}

export function buildBookmarkletHref(installKey: string): string {
  const code = `(function(){
  var ORIGIN='https://priceit.rbnd.cc';
  var clean=function(s){return (s||'').replace(/\\s+/g,' ').trim();};
  var parseMoney=function(v){
    if(typeof v==='number') return isFinite(v)?v:null;
    if(!v) return null;
    var m=String(v).replace(/,/g,'').match(/([0-9]+(?:\\.[0-9]{1,4})?)/);
    return m?parseFloat(m[1]):null;
  };
  var query=function(sels,root){
    root=root||document;
    for(var i=0;i<sels.length;i++){
      try{
        var el=root.querySelector(sels[i]);
        if(el){
          var t=clean(el.getAttribute('content')||el.innerText||el.textContent);
          if(t) return t;
        }
      }catch(_){}
    }
    return '';
  };
  var canonEl=document.querySelector('link[rel="canonical"]');
  var canonUrl=canonEl&&canonEl.href?canonEl.href:window.location.href.split('#')[0];
  var host=window.location.hostname.replace(/^www\\./i,'').toLowerCase();

  var res={
    url:window.location.href,
    canonicalUrl:canonUrl,
    vendorHost:host,
    partName:'',
    partNumber:'',
    vendorSku:'',
    brand:'',
    price:null,
    currency:'USD',
    packageYield:1,
    bundleKeywordsFound:[],
    isLikelyBundleOrPack:false,
    shippingCost:null,
    freeShippingDetected:false,
    shippingNote:'',
    inStock:true,
    extractionSource:[],
    capturedAt:Date.now(),
    installKey:'${installKey}'
  };

  /* 1. JSON-LD */
  try{
    var scripts=document.querySelectorAll('script[type="application/ld+json"]');
    var findProds=function(n,acc){
      if(!n||typeof n!=='object') return acc;
      if(Array.isArray(n)){n.forEach(function(i){findProds(i,acc);});return acc;}
      var t=n['@type'];
      if(t==='Product'||t==='IndividualProduct'||(Array.isArray(t)&&t.indexOf('Product')>=0)) acc.push(n);
      if(n['@graph']) findProds(n['@graph'],acc);
      if(n.mainEntity) findProds(n.mainEntity,acc);
      return acc;
    };
    for(var si=0;si<scripts.length;si++){
      try{
        var raw=JSON.parse(scripts[si].textContent);
        var prods=findProds(raw,[]);
        for(var pi=0;pi<prods.length;pi++){
          var p=prods[pi];
          if(!res.partName&&p.name) res.partName=clean(p.name);
          if(!res.partNumber&&p.mpn&&!/^(does not apply|n\\\/a|none|not applicable)$/i.test(clean(p.mpn))) res.partNumber=clean(p.mpn);
          if(!res.partNumber&&p.model&&host.indexOf('ebay.')<0&&/[0-9]/.test(p.model)) res.partNumber=clean(p.model);
          if(!res.vendorSku&&p.sku) res.vendorSku=clean(p.sku);
          if(!res.brand&&p.brand) res.brand=clean(typeof p.brand==='string'?p.brand:p.brand.name);
          var offers=Array.isArray(p.offers)?p.offers:(p.offers&&p.offers.offers?p.offers.offers:(p.offers?[p.offers]:[]));
          for(var oi=0;oi<offers.length;oi++){
            var o=offers[oi];
            if(!o) continue;
            var pr=parseMoney(o.price)||parseMoney(o.lowPrice);
            if(pr!==null&&(res.price===null||pr<res.price)) res.price=pr;
            if(!res.vendorSku&&o.sku) res.vendorSku=clean(o.sku);
            if(!res.partNumber&&o.mpn&&!/^(does not apply|n\\\/a|none|not applicable)$/i.test(clean(o.mpn))) res.partNumber=clean(o.mpn);
            if(o.availability&&/OutOfStock|Discontinued/i.test(o.availability)) res.inStock=false;
          }
          res.extractionSource.push('json-ld');
        }
      }catch(_){}
    }
  }catch(_){}

  /* 2. Domain Adapters */
  try{
    if(host.indexOf('amazon.')>=0){
      res.partName=res.partName||query(['#productTitle','#title']);
      var am=window.location.pathname.match(/\\/(?:dp|gp\\/product)\\/([A-Z0-9]{10})/i);
      if(am) res.vendorSku=am[1].toUpperCase();
      var amRows=document.querySelectorAll('#productDetails_techSpec_section_1 tr,#productDetails_detailBullets_sections1 tr,#techSpecSoftlines_section_1 tr,table.prodDetTable tr,table.a-keyvalue tr,#poExpander tr');
      var amPn='';
      var amMod='';
      for(var ari=0;ari<amRows.length;ari++){
        var thEl=amRows[ari].querySelector('th,td:first-child');
        var tdEl=amRows[ari].querySelector('td:last-child');
        var th=clean(thEl?thEl.textContent:'').replace(/:$/,'');
        var td=clean(tdEl?tdEl.textContent:'').replace(/[\\u200E\\u200F]/g,'').trim();
        if(!td||/^B0[A-Z0-9]{8}$/i.test(td)) continue;
        if(/^(Part Number|Mfr Part Number|Manufacturer Part Number|OEM Part Number)$/i.test(th)&&!amPn) amPn=td;
        else if(/^(Item model number|Model Number)$/i.test(th)&&/[0-9]/.test(td)&&!amMod) amMod=td;
      }
      if(!amPn){
        var amBuls=document.querySelectorAll('#detailBullets_feature_div li');
        for(var abi=0;abi<amBuls.length;abi++){
          var bt=clean(amBuls[abi].textContent).replace(/[\\u200E\\u200F]/g,'');
          var bm=bt.match(/^(?:Part Number|Mfr Part Number|Manufacturer Part Number|Item model number)\\s*:\\s*(.+)$/i);
          if(bm&&bm[1]&&!/^B0[A-Z0-9]{8}$/i.test(bm[1].trim())){amPn=bm[1].trim();break;}
        }
      }
      if(amPn||amMod) res.partNumber=amPn||amMod;
      var prStr=query(['#corePriceDisplay_desktop_feature_div .a-price .a-offscreen','#corePrice_feature_div .a-price .a-offscreen','#price_inside_buybox','.a-price .a-offscreen']);
      if(parseMoney(prStr)!==null) res.price=parseMoney(prStr);
      var deliv=query(['#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE','#deliveryBlockMessage']);
      if(deliv){
        res.shippingNote=deliv.slice(0,180);
        if(/FREE delivery/i.test(deliv)){res.shippingCost=0;res.freeShippingDetected=true;}
        else{var sm=deliv.match(/\\$([0-9]+(?:\\.[0-9]{2})?)\\s+delivery/i);if(sm)res.shippingCost=parseFloat(sm[1]);}
      }
      res.extractionSource.push('adapter:amazon');
    } else if(host.indexOf('mcmaster.com')>=0){
      var pn=window.location.pathname.split('/').filter(Boolean).pop();
      res.partNumber=query(['.PartNbr','[class*="PartNumber"]'])||pn;
      res.vendorSku=res.partNumber;
      res.partName=clean([query(['.header-primary--pd','h1']),query(['.header-secondary--pd','h3'])].filter(Boolean).join(' - '))||document.title;
      var mcPr=query(['.PrceTxt','[class*="Price"]']);
      if(parseMoney(mcPr)!==null) res.price=parseMoney(mcPr);
      var pkMatch=(mcPr+' '+document.title).match(/Pack\\s+of\\s+([0-9,]+)/i);
      if(pkMatch) res.packageYield=parseInt(pkMatch[1].replace(/,/g,''),10)||1;
      res.extractionSource.push('adapter:mcmaster');
    } else if(host.indexOf('digikey.')>=0){
      res.partNumber=res.partNumber||query(['[data-testid="mfr-part-number"]','div[itemprop="mpn"]']);
      res.vendorSku=res.vendorSku||query(['[data-testid="digikey-part-number"]']);
      var dkP=query(['[data-testid="pricing-table"] tbody tr:first-child td:nth-child(2)','[data-testid="unit-price"]']);
      if(res.price===null&&parseMoney(dkP)!==null) res.price=parseMoney(dkP);
      res.extractionSource.push('adapter:digikey');
    } else if(host.indexOf('rockauto.com')>=0){
      var sel=window.getSelection();
      var node=sel&&sel.anchorNode?sel.anchorNode.parentElement:null;
      var row=(node&&node.closest('tbody[id^="listingcontainer"]'))||document.querySelector('tbody[id^="listingcontainer"]');
      if(row){
        var mfr=query(['.listing-final-manufacturer'],row);
        var rpn=query(['.listing-final-partnumber'],row);
        var rpr=query(['span[id^="dprice"]'],row);
        res.brand=mfr||res.brand;
        res.partNumber=rpn||res.partNumber;
        res.partName=clean([mfr,rpn].filter(Boolean).join(' '))||document.title;
        if(parseMoney(rpr)!==null) res.price=parseMoney(rpr);
      }
      res.extractionSource.push('adapter:rockauto');
    } else if(host.indexOf('ebay.')>=0){
      var ebm=window.location.pathname.match(/\\\/itm\\\/(?:[^\\\/]+\\\/)?([0-9]{10,14})/);
      if(ebm) res.vendorSku=ebm[1];
      var dls=document.querySelectorAll('dl.ux-labels-values,.ux-labels-values,[data-testid="ux-labels-values"]');
      var ebPn='';
      var ebAltPn='';
      for(var di=0;di<dls.length;di++){
        var lblEl=dls[di].querySelector('.ux-labels-values__labels,dt');
        var valEl=dls[di].querySelector('.ux-labels-values__values,dd');
        var lbl=clean(lblEl?lblEl.textContent:'').replace(/:$/,'');
        var val=clean(valEl?valEl.textContent:'');
        if(!val||/^(does not apply|n\\\/a|none|not applicable|see description)$/i.test(val)) continue;
        if(/^(Manufacturer Part Number|OE\\\/OEM Part Number|MPN|Part Number)$/i.test(lbl)&&!ebPn) ebPn=val;
        else if(/^(Interchange Part Number|Superseded Part Number)$/i.test(lbl)&&!ebAltPn) ebAltPn=val;
        else if(/^Brand$/i.test(lbl)&&!res.brand) res.brand=val;
      }
      if(ebPn||ebAltPn) res.partNumber=ebPn||ebAltPn;
      var ebPr=query(['.x-price-primary span','.x-bin-price__content span']);
      if(res.price===null&&parseMoney(ebPr)!==null) res.price=parseMoney(ebPr);
      var ebSh=query(['.ux-labels-values--shipping .ux-labels-values__values']);
      if(ebSh){
        res.shippingNote=ebSh.slice(0,180);
        if(/free\\s+(shipping|delivery)/i.test(ebSh)){res.shippingCost=0;res.freeShippingDetected=true;}
        else{var esm=ebSh.match(/\\$([0-9]+(?:\\.[0-9]{2})?)/);if(esm&&res.shippingCost===null)res.shippingCost=parseFloat(esm[1]);}
      }
      res.extractionSource.push('adapter:ebay');
    }
  }catch(_){}

  /* 3. Meta Fallbacks */
  if(!res.partName) res.partName=query(['meta[property="og:title"]','meta[name="twitter:title"]','h1[itemprop="name"]','h1'])||clean(document.title);
  if(res.price===null){
    var mp=query(['meta[property="product:price:amount"]','meta[property="og:price:amount"]','[itemprop="price"]']);
    if(parseMoney(mp)!==null) res.price=parseMoney(mp);
  }
  if(!res.partNumber) res.partNumber=query(['[itemprop="mpn"]','[itemprop="sku"]']);

  /* 4. Bundle/Pack Heuristics */
  res.partName=res.partName.slice(0,250).replace(/\\s*[|\\-–—]\\s*(eBay|Amazon\\.com|Mouser|DigiKey|McMaster-Carr|Grainger|FCP Euro|Newegg|B&H Photo|Micro Center).*$/i,'').trim();
  if(!res.partNumber||!/[0-9]/.test(res.partNumber)){
    var tToks=res.partName.split(/\\s+/);
    for(var ti=0;ti<tToks.length;ti++){
      var tk=tToks[ti].replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g,'');
      if(tk.length>=5&&tk.length<=20&&/^[A-Za-z0-9-]+$/.test(tk)&&!/^(19[5-9][0-9]|20[0-3][0-9])/.test(tk)){
        var dc=(tk.match(/[0-9]/g)||[]).length;
        if(dc>=4){res.partNumber=tk;break;}
      }
    }
  }
  var pMatches=[/\\b(?:pack|set|box|lot)\\s+of\\s+([0-9]{1,4})\\b/i,/\\b([0-9]{1,3})\\s*-\\s*(?:pack|pk|pc|set)\\b/i,/\\(([0-9]{1,3})\\s*(?:pack|pk)\\)/i];
  for(var ki=0;ki<pMatches.length;ki++){
    var pm=res.partName.match(pMatches[ki]);
    if(pm&&res.packageYield===1){
      var q=parseInt(pm[1],10);
      if(q>1&&q<=5000){res.packageYield=q;res.bundleKeywordsFound.push(pm[0]);}
    }
  }
  if(/\\b(bundle|combo|kit|overhaul|package)\\b/i.test(res.partName)) res.bundleKeywordsFound.push('Bundle/Kit');
  if(res.bundleKeywordsFound.length>0||res.packageYield>1) res.isLikelyBundleOrPack=true;

  /* 5. Safe Bounds */
  res.partName=res.partName.slice(0,200);
  var fallbackSku=(res.vendorSku&&!/^B0[A-Z0-9]{8}$/i.test(res.vendorSku)&&host.indexOf('ebay.')<0)?res.vendorSku:'';
  res.partNumber=(res.partNumber||fallbackSku||'').slice(0,100);

  var payload=encodeURIComponent(JSON.stringify(res));
  window.open(ORIGIN+'/#import_part='+payload,'priceit_capture_window');
})();`;

  return `javascript:${code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\n\s*/g, '')}`;
}
