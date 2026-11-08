const safeArgs = (typeof args === 'object' && args !== null) ? args : {};
const incomingRef = (safeArgs.ref || safeArgs.referrer || safeArgs.r || '').trim();
const incomingAgentId = (safeArgs.agentId || safeArgs.agent_id || safeArgs.agent || '').trim();

let snapshot = await appKV.get('daily_offers');
if (!snapshot || !snapshot.offers || !Array.isArray(snapshot.offers) || snapshot.offers.length === 0) {
  return {
    ok: true,
    destinationUrl: 'https://bankr.bot/apps/jobless-joe',
    selectedOffer: {
      id: 'offer_jobless_joe',
      title: 'Jobless Joe — AI Meme Income Agent',
      destinationUrl: 'https://bankr.bot/apps/jobless-joe'
    },
    attribution: {
      isAttributed: !!(incomingRef || incomingAgentId),
      humanRef: incomingRef || null,
      agentId: incomingAgentId || null
    }
  };
}

// 1. Resolve promoter if incomingRef is provided
let promoterInfo = null;
let promoterWallet = null;
if (incomingRef && snapshot.promoterMap) {
  const s = incomingRef.toLowerCase();
  if (snapshot.promoterMap[s]) {
    promoterInfo = snapshot.promoterMap[s];
    promoterWallet = promoterInfo.wallet || s;
  } else {
    for (const [k, v] of Object.entries(snapshot.promoterMap)) {
      if (k.toLowerCase() === s || (v.wallet && v.wallet.toLowerCase() === s)) {
        promoterInfo = v;
        promoterWallet = v.wallet || k;
        break;
      }
    }
  }
}

// Distinction:
// - User refers user (human ref without agent id): show referrer's links dynamically for offers
// - Agent referrals (has agentId): agent referrals go to rotator round-robin style
// - Users without a referral link (no ref, no agent): distributed between master rotator and individual offer rotators
const isAgentReferral = !!incomingAgentId;
const isHumanReferral = !!incomingRef && !isAgentReferral;

let destUrl = '';
let selected = null;
let routedPool = 'rotator';

if (isHumanReferral) {
  const allOffers = (snapshot.offers && snapshot.offers.length > 0) ? snapshot.offers : [
    { id: 'offer_jobless_joe', title: 'Jobless Joe — AI Meme Income Agent', destinationUrl: 'https://bankr.bot/apps/jobless-joe' }
  ];

  const requestedOfferId = safeArgs.offerId;
  if (requestedOfferId) {
    selected = allOffers.find(o => o.offerId === requestedOfferId || o.id === requestedOfferId) || allOffers[0];
  } else {
    let pointer = Number(snapshot.pointer) || 0;
    if (pointer >= allOffers.length || pointer < 0) pointer = 0;
    selected = allOffers[pointer] || allOffers[0];
    snapshot.pointer = (pointer + 1) % allOffers.length;
  }

  const selectedId = selected.offerId || selected.id;
  if (promoterInfo && promoterInfo.links && promoterInfo.links[selectedId]) {
    destUrl = promoterInfo.links[selectedId];
  } else {
    destUrl = selected.destinationUrl || selected.affiliateUrl || selected.defaultUrl || 'https://bankr.bot/apps/jobless-joe';
  }

  routedPool = 'human_referral_direct';
  snapshot.attributedClicks = (Number(snapshot.attributedClicks) || 0) + 1;
} else {
  // Rotator distribution: Configurable 70% master rotator / 30% individual offer rotators allocation
  const masterPlacements = (snapshot.masterOffers || []).filter(o => o.status !== 'paused');
  let indivPlacements = (snapshot.offers || []).filter(o => o.status !== 'paused');

  if (safeArgs.offerId) {
    const matched = indivPlacements.filter(o => o.offerId === safeArgs.offerId || o.id === safeArgs.offerId);
    if (matched.length > 0) indivPlacements = matched;
  }

  const clickCount = (Number(snapshot.totalRotatedClicks) || 0) + 1;
  const masterTrafficPercent = Math.min(100, Math.max(0, Number(snapshot.masterTrafficPercent !== undefined ? snapshot.masterTrafficPercent : 70)));
  const masterThreshold = Math.round(masterTrafficPercent / 10);
  const isMasterTurn = ((clickCount % 10) < masterThreshold);

  if (isMasterTurn && masterPlacements.length > 0) {
    let mPointer = Number(snapshot.masterPointer) || 0;
    if (mPointer >= masterPlacements.length || mPointer < 0) mPointer = 0;
    selected = masterPlacements[mPointer] || masterPlacements[0];
    snapshot.masterPointer = (mPointer + 1) % masterPlacements.length;
    routedPool = 'master_rotator';
  } else if (indivPlacements.length > 0) {
    let iPointer = Number(snapshot.pointer) || 0;
    if (iPointer >= indivPlacements.length || iPointer < 0) iPointer = 0;
    selected = indivPlacements[iPointer] || indivPlacements[0];
    snapshot.pointer = (iPointer + 1) % indivPlacements.length;
    routedPool = 'individual_rotator';
  } else if (masterPlacements.length > 0) {
    let mPointer = Number(snapshot.masterPointer) || 0;
    if (mPointer >= masterPlacements.length || mPointer < 0) mPointer = 0;
    selected = masterPlacements[mPointer] || masterPlacements[0];
    snapshot.masterPointer = (mPointer + 1) % masterPlacements.length;
    routedPool = 'master_rotator';
  } else {
    selected = {
      id: 'fallback_joe',
      title: 'Jobless Joe — AI Meme Income Agent',
      destinationUrl: 'https://bankr.bot/apps/jobless-joe'
    };
    routedPool = 'fallback_rotator';
  }

  // Master rotator winners receive exposure across all six offers, with their personal referral links displayed dynamically
  if (routedPool === 'master_rotator' && selected) {
    const masterAdvertiser = (selected.advertiser || '').toLowerCase();
    const reqOfferId = safeArgs.offerId;
    let customLink = '';
    if (masterAdvertiser && snapshot.promoterMap) {
      const pEntry = snapshot.promoterMap[masterAdvertiser] || snapshot.promoterMap[(selected.advertiserSlug || '').toLowerCase()];
      if (pEntry && pEntry.links) {
        if (reqOfferId && pEntry.links[reqOfferId]) {
          customLink = pEntry.links[reqOfferId];
        } else if (!reqOfferId && pEntry.links['offer_the_bankr_meme_engin_mvi5fxbq']) {
          customLink = pEntry.links['offer_the_bankr_meme_engin_mvi5fxbq'];
        }
      }
    }
    destUrl = customLink || selected.destinationUrl || selected.affiliateUrl || selected.defaultUrl || 'https://bankr.bot/u/0x2416d6c32c75e58d436e598be3773a4c722053bc/apps/bankr-meme-engine';
  }

  if (isAgentReferral) {
    snapshot.attributedClicks = (Number(snapshot.attributedClicks) || 0) + 1;
  } else {
    snapshot.unattributedClicks = (Number(snapshot.unattributedClicks) || 0) + 1;
  }
}

// Track page views, outbound clicks, and rotators separately
snapshot.totalRotatedClicks = (Number(snapshot.totalRotatedClicks) || 0) + 1;
snapshot.outboundClicks = (Number(snapshot.outboundClicks) || 0) + 1;
if (routedPool === 'master_rotator') {
  snapshot.masterClicks = (Number(snapshot.masterClicks) || 0) + 1;
} else if (routedPool === 'individual_rotator') {
  snapshot.individualClicks = (Number(snapshot.individualClicks) || 0) + 1;
}

await appKV.set('daily_offers', snapshot);

if (incomingRef || incomingAgentId) {
  try {
    const parsed = new URL(destUrl);
    if (incomingRef && !parsed.searchParams.has('ref')) {
      parsed.searchParams.set('ref', incomingRef);
    }
    if (incomingAgentId && !parsed.searchParams.has('agent_id')) {
      parsed.searchParams.set('agent_id', incomingAgentId);
    }
    destUrl = parsed.toString();
  } catch (_) {}
}

return {
  ok: true,
  destinationUrl: destUrl,
  selectedOffer: selected,
  routedPool,
  attribution: {
    isAttributed: !!(incomingRef || incomingAgentId),
    humanRef: incomingRef || null,
    agentId: incomingAgentId || null,
    promoterWallet: promoterWallet || null,
    isCustomOfferLinkUsed: isHumanReferral && !!(promoterInfo && promoterInfo.links && promoterInfo.links[selected.offerId || selected.id])
  }
};