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
    version: (prev.version || 1) + 1,
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

  // 1. JSON-LD
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
          if(!res.partNumber&&p.mpn) res.partNumber=clean(p.mpn);
          if(!res.partNumber&&p.model) res.partNumber=clean(p.model);
          if(!res.vendorSku&&p.sku) res.vendorSku=clean(p.sku);
          if(!res.brand&&p.brand) res.brand=clean(typeof p.brand==='string'?p.brand:p.brand.name);
          var offers=Array.isArray(p.offers)?p.offers:(p.offers&&p.offers.offers?p.offers.offers:(p.offers?[p.offers]:[]));
          for(var oi=0;oi<offers.length;oi++){
            var o=offers[oi];
            if(!o) continue;
            var pr=parseMoney(o.price)||parseMoney(o.lowPrice);
            if(pr!==null&&(res.price===null||pr<res.price)) res.price=pr;
            if(!res.vendorSku&&o.sku) res.vendorSku=clean(o.sku);
            if(!res.partNumber&&o.mpn) res.partNumber=clean(o.mpn);
            if(o.availability&&/OutOfStock|Discontinued/i.test(o.availability)) res.inStock=false;
          }
          res.extractionSource.push('json-ld');
        }
      }catch(_){}
    }
  }catch(_){}

  // 2. Domain Adapters
  try{
    if(host.indexOf('amazon.')>=0){
      res.partName=res.partName||query(['#productTitle','#title']);
      var am=window.location.pathname.match(/\\/(?:dp|gp\\/product)\\/([A-Z0-9]{10})/i);
      if(am) res.vendorSku=am[1].toUpperCase();
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
    }
  }catch(_){}

  // 3. Meta Fallbacks
  if(!res.partName) res.partName=query(['meta[property="og:title"]','meta[name="twitter:title"]','h1[itemprop="name"]','h1'])||clean(document.title);
  if(res.price===null){
    var mp=query(['meta[property="product:price:amount"]','meta[property="og:price:amount"]','[itemprop="price"]']);
    if(parseMoney(mp)!==null) res.price=parseMoney(mp);
  }
  if(!res.partNumber) res.partNumber=query(['[itemprop="mpn"]','[itemprop="sku"]']);

  // 4. Bundle/Pack Heuristics
  res.partName=res.partName.slice(0,250).replace(/\\s*[|\\-–—]\\s*(Amazon\\.com|Mouser|DigiKey|McMaster-Carr|Grainger|FCP Euro|Newegg|B&H Photo|Micro Center).*$/i,'').trim();
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

  // Truncate fields to safe bounds
  res.partName=res.partName.slice(0,200);
  res.partNumber=(res.partNumber||res.vendorSku||'').slice(0,100);

  var payload=encodeURIComponent(JSON.stringify(res));
  window.open(ORIGIN+'/#import_part='+payload,'priceit_capture_window','width=560,height=720');
})();`;

  return `javascript:${code.replace(/\n\s*/g, '')}`;
}
