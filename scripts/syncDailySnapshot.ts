function calculateDynamicSpots(config, bidsCount, totalClicks) {
  const cfg = config || {};
  const minSpots = Math.max(1, Number(cfg.minSpots) || 3);
  const maxSpots = Math.max(minSpots, Number(cfg.maxSpots) || 30);
  const clicksPerSpot = Math.max(10, Number(cfg.clicksPerSpotTarget) || 50);
  const baseTraffic = Number(cfg.baseDailyTrafficSupply) || 200;
  const dynamicMode = cfg.dynamicMode || 'supply_and_demand';
  const manualOverride = Number(cfg.manualSpotOverride) || 0;

  if (manualOverride > 0) {
    return {
      dynamicSpots: Math.min(maxSpots, Math.max(minSpots, manualOverride)),
      minSpots,
      maxSpots,
      demand: bidsCount,
      trafficSupply: Math.floor(baseTraffic / clicksPerSpot),
      clicksPerSpot,
      dynamicMode: 'manual_override',
      isOverridden: true
    };
  }

  const effectiveTraffic = Math.max(Number(totalClicks) || 0, baseTraffic);
  const trafficSupply = Math.max(minSpots, Math.floor(effectiveTraffic / clicksPerSpot));
  const demand = Math.max(0, bidsCount);

  let spots;
  if (dynamicMode === 'fixed') {
    spots = minSpots;
  } else if (dynamicMode === 'demand_only') {
    spots = Math.min(maxSpots, Math.max(minSpots, demand));
  } else {
    const capacityLimit = Math.min(maxSpots, trafficSupply);
    if (demand <= minSpots) {
      spots = minSpots;
    } else if (demand <= capacityLimit) {
      spots = demand;
    } else {
      const elastic = Math.min(maxSpots, Math.round(capacityLimit * 1.2));
      spots = Math.max(minSpots, Math.min(elastic, demand));
    }
  }

  return {
    dynamicSpots: Math.min(maxSpots, Math.max(minSpots, spots)),
    minSpots,
    maxSpots,
    demand,
    trafficSupply,
    clicksPerSpot,
    dynamicMode,
    isOverridden: false
  };
}

function getEasternTimeInfo() {
  const now = new Date();
  const etStr = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const etDate = new Date(etStr);
  const etYear = etDate.getFullYear();
  const etMonth = etDate.getMonth();
  const etDay = etDate.getDate();

  const lockTargetEt = new Date(etYear, etMonth, etDay, 11, 50, 0, 0);
  let nextLockEt = lockTargetEt;
  if (etDate.getTime() >= lockTargetEt.getTime()) {
    nextLockEt = new Date(etYear, etMonth, etDay + 1, 11, 50, 0, 0);
  }

  const msRemaining = Math.max(0, nextLockEt.getTime() - etDate.getTime());
  const hours = Math.floor(msRemaining / (1000 * 60 * 60));
  const mins = Math.floor((msRemaining % (1000 * 60 * 60)) / (1000 * 60));
  const secs = Math.floor((msRemaining % (1000 * 60)) / 1000);

  const cycleId = `${etYear}-${String(etMonth + 1).padStart(2, '0')}-${String(etDay).padStart(2, '0')}`;
  return {
    nowEt: etStr,
    msRemaining,
    countdownText: `${hours}h ${mins}m ${secs}s`,
    isCutoffPassed: etDate.getTime() >= lockTargetEt.getTime(),
    cycleId,
    targetLockIso: nextLockEt.toISOString()
  };
}

let state = await appKV.get('rotator_state') || {
  config: { minSpots: 3, maxSpots: 30, masterSpotLimit: 10 },
  offers: [],
  queue: [],
  bids: [],
  auctionHistory: [],
  customerReferrers: {},
  commissions: [],
  lastSettledCycle: null
};

state.customerReferrers = state.customerReferrers || {};
state.commissions = state.commissions || [];

const cycle = getEasternTimeInfo();
let settledNow = false;

// 11:50 AM ET Auction Cutoff Settlement (Master Network & Individual Offer Auctions)
if (cycle.isCutoffPassed && state.lastSettledCycle !== cycle.cycleId) {
  const cycleBids = (state.bids || []).filter(b => b.cycleId === cycle.cycleId && b.status === 'active');
  const now = Date.now();
  const cfg = state.config || {};
  const totalClicks = (state.stats && state.stats.validClicks) || 0;

  // 1. Master Network Auction Settlement
  const masterBids = cycleBids.filter(b => b.placementType === 'master');
  masterBids.sort((a, b) => (b.bidAmountToken || 0) - (a.bidAmountToken || 0));
  const adminCap = Math.max(1, Number(cfg.masterSpotLimit !== undefined ? cfg.masterSpotLimit : cfg.maxSpots) || 10);
  const isPromo = cfg.betaTesterEnabled !== false;
  const masterCapacity = (isPromo && (Number(cfg.manualSpotOverride) || 0) <= 0)
    ? Math.min(adminCap, Math.max(Number(cfg.minSpots) || 1, masterBids.length))
    : adminCap;
  const masterWinners = masterBids.slice(0, masterCapacity);
  const masterLosers = masterBids.slice(masterCapacity);

  for (const win of masterWinners) {
    win.status = 'won';
    win.settledAt = now;
    state.queue.push({
      id: 'pl_m_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
      placementType: 'master',
      offerId: 'master_all_offers',
      title: win.title || 'Master Network Sponsor',
      description: win.description || 'Interleaved across all individual offer feeds',
      destinationUrl: win.destinationUrl,
      advertiser: win.bidder,
      tokenSymbol: win.tokenSymbol || 'USDC',
      tokenAmount: win.bidAmountToken,
      type: 'auction_winner',
      status: 'active',
      activatedAt: now,
      expiresAt: now + 86400000,
      clicksDelivered: 0
    });

    // 25% referral commission to referring agent or promoter, 50% treasury, 25% staking
    const grossUsd = Number(win.bidAmountToken) || 50;
    const refPromoter = state.customerReferrers[win.bidder];
    const refAgent = (state.customerAgentReferrers && state.customerAgentReferrers[win.bidder]) || win.agentId || null;
    let refCommissionUsd = 0;
    let treasuryUsd = grossUsd * 0.50;
    const stakingUsd = grossUsd * 0.25;

    if (refAgent) {
      refCommissionUsd = grossUsd * 0.25;
      state.commissions.push({
        id: 'comm_auc_agent_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
        type: 'auction_agent_referral',
        offerId: 'master_all_offers',
        customer: win.bidder,
        agentId: refAgent,
        wallet: refPromoter || refAgent,
        referrerWallet: refPromoter || null,
        grossAmountUsd: grossUsd,
        sharePercent: 25,
        eligibleAmountUsd: refCommissionUsd,
        treasuryAmountUsd: treasuryUsd,
        stakingAmountUsd: stakingUsd,
        status: 'approved',
        createdAt: now
      });
    } else if (refPromoter && refPromoter !== win.bidder) {
      refCommissionUsd = grossUsd * 0.25;
      state.commissions.push({
        id: 'comm_auc_m_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
        type: 'auction_referral',
        offerId: 'master_all_offers',
        customer: win.bidder,
        wallet: refPromoter,
        referrerWallet: refPromoter,
        grossAmountUsd: grossUsd,
        sharePercent: 25,
        eligibleAmountUsd: refCommissionUsd,
        treasuryAmountUsd: treasuryUsd,
        stakingAmountUsd: stakingUsd,
        status: 'approved',
        createdAt: now
      });
    } else {
      treasuryUsd += grossUsd * 0.25;
    }
  }

  for (const lose of masterLosers) {
    lose.status = 'outbid_released';
    lose.settledAt = now;
  }

  // Cancel any lingering individual bids
  const indivBids = cycleBids.filter(b => b.placementType !== 'master');
  for (const b of indivBids) {
    b.status = 'cancelled';
    b.settledAt = now;
  }

  state.auctionHistory = state.auctionHistory || [];
  state.auctionHistory.unshift({
    cycleId: cycle.cycleId,
    cutoffTimestamp: now,
    masterSpots: masterWinners.length,
    indivSpots: 0,
    totalBids: cycleBids.length
  });

  state.lastSettledCycle = cycle.cycleId;
  settledNow = true;
}

const now = Date.now();
state.queue = (state.queue || []).filter(q => !q.expiresAt || q.expiresAt > now);

const activePlacements = (state.queue || []).filter(q => q.status === 'active');
const activeOffers = (state.offers || []).filter(o => o.status === 'active');

const masterPlacements = activePlacements.filter(p => p.placementType === 'master').map(p => ({
  id: p.id,
  offerId: p.offerId,
  placementType: 'master',
  title: p.title,
  category: 'Master Network Sponsor',
  description: p.description || '',
  destinationUrl: p.destinationUrl,
  advertiser: p.advertiser,
  tokenSymbol: p.tokenSymbol || 'USDC',
  status: 'active',
  expiresAt: p.expiresAt || (now + 86400000)
}));

let individualPlacements = activePlacements.filter(p => p.placementType !== 'master').map(p => ({
  id: p.id,
  offerId: p.offerId,
  placementType: 'individual',
  title: p.title,
  category: p.category || 'Web2 / Web3',
  description: p.description || '',
  destinationUrl: p.destinationUrl,
  advertiser: p.advertiser,
  tokenSymbol: p.tokenSymbol || 'TOKEN',
  status: 'active',
  expiresAt: p.expiresAt || (now + 86400000)
}));

if (individualPlacements.length === 0 && activeOffers.length > 0) {
  const ADMIN_OFFER_LINKS = {
    'offer_the_bankr_meme_engin_mvi5fxbq': 'https://bankr.bot/u/0x2416d6c32c75e58d436e598be3773a4c722053bc/apps/bankr-meme-engine?ref=2416d6c3',
    'offer_jobless_joe': 'https://bankr.bot/u/0x2416d6c32c75e58d436e598be3773a4c722053bc/apps/jobless-joe?ref=0x2416d6c32c75e58d436e598be3773a4c722053bc',
    'offer_dh_media': 'https://dh.media/?affid=Vesselprotocol',
    'offer_fish_audio': 'https://fish.audio/?fpr=oneminute',
    'offer_upload_post': 'https://upload-post.com/?ref=VESSEL',
    'offer_railway': 'https://railway.com?referralCode=XO8ClD',
    'offer_freebuff': 'https://freebuff.com/?ref=ref-fb33bc2a-9604-43b4-a995-fd690a7b5393',
    'offer_bankr': 'https://bankr.bot'
  };

  individualPlacements = activeOffers.map(o => ({
    id: o.id,
    offerId: o.id,
    placementType: 'individual',
    title: o.title,
    category: o.category || 'Tools',
    description: o.description || '',
    destinationUrl: (ADMIN_OFFER_LINKS[o.id] || o.affiliateUrl || o.defaultUrl || o.destinationUrl),
    advertiser: 'catalog',
    tokenSymbol: o.tokenSymbol || 'USDC',
    status: 'active',
    expiresAt: now + 86400000
  }));
}

const featured = individualPlacements[0] || (masterPlacements.length ? masterPlacements[0] : null);

// Build sanitized promoter mapping for public syndication
const promoterMap = {};
for (const [wallet, links] of Object.entries(state.savedOfferLinks || {})) {
  const slug = (state.walletToSlug && state.walletToSlug[wallet]) || wallet.slice(2, 10).toLowerCase();
  const cleanLinks = {};
  if (typeof links === 'object' && links !== null) {
    for (const [oid, lk] of Object.entries(links)) {
      if (typeof lk === 'string' && lk.startsWith('http')) {
        cleanLinks[oid] = lk;
      }
    }
  }
  if (!cleanLinks['offer_the_bankr_meme_engin_mvi5fxbq']) {
    cleanLinks['offer_the_bankr_meme_engin_mvi5fxbq'] = `https://bankr.bot/u/0x2416d6c32c75e58d436e598be3773a4c722053bc/apps/bankr-meme-engine?ref=${slug}`;
  }
  if (state.savedLinks && state.savedLinks[wallet] && !cleanLinks['offer_jobless_joe']) {
    cleanLinks['offer_jobless_joe'] = state.savedLinks[wallet];
  }
  const entry = { wallet, slug, links: cleanLinks };
  promoterMap[slug] = entry;
  promoterMap[wallet.toLowerCase()] = entry;
}

// Build active round-robin promoter pool: Master auction winners first, then network promoters
const roundRobinPromoters = [];
const seenRrWallets = new Set();

for (const p of masterPlacements) {
  const w = (p.advertiser || '').toLowerCase();
  if (w && !seenRrWallets.has(w)) {
    seenRrWallets.add(w);
    const pInfo = promoterMap[w] || promoterMap[(state.walletToSlug && state.walletToSlug[w]) || ''];
    if (pInfo) {
      roundRobinPromoters.push({
        wallet: w,
        slug: pInfo.slug || w.slice(2, 10).toLowerCase(),
        links: pInfo.links || {},
        source: 'auction_winner'
      });
    }
  }
}

for (const [key, pInfo] of Object.entries(promoterMap)) {
  const w = (pInfo.wallet || key).toLowerCase();
  if (w && !seenRrWallets.has(w)) {
    seenRrWallets.add(w);
    roundRobinPromoters.push({
      wallet: w,
      slug: pInfo.slug || w.slice(2, 10).toLowerCase(),
      links: pInfo.links || {},
      source: 'promoter'
    });
  }
}

const phoneMedia = state.adminPhoneMedia || (await appKV.get('admin_phone_media')) || null;

const dailySnapshot = {
  version: 5,
  updatedAt: now,
  cycleId: cycle.cycleId,
  countdownText: cycle.countdownText,
  pointer: 0,
  masterPointer: 0,
  roundRobinPointer: (Number(state.roundRobinPointer) || 0),
  totalRotatedClicks: 0,
  masterTrafficPercent: state.config.masterTrafficPercent !== undefined ? state.config.masterTrafficPercent : 70,
  featuredOffer: featured,
  activeCount: masterPlacements.length + individualPlacements.length,
  masterOffers: masterPlacements,
  offers: individualPlacements,
  promoterMap,
  roundRobinPromoters,
  adminPhoneMedia: phoneMedia
};

await appKV.set('rotator_state', state);
await appKV.set('daily_offers', dailySnapshot);

return { ok: true, settledNow, activeCount: dailySnapshot.activeCount };