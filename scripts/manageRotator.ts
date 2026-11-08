const safeArgs = (typeof args === 'object' && args !== null) ? args : {};
const action = safeArgs.action || 'getState';

const ownerWallet = (ctx.ownerAddress || (ctx.author && ctx.author.walletAddress) || '0x2416d6c32c75e58d436e598be3773a4c722053bc').toLowerCase();
const ctxCaller = (ctx.caller && ctx.caller.walletAddress) ? ctx.caller.walletAddress.toLowerCase() : '';
const ctxAuthor = (ctx.author && ctx.author.walletAddress) ? ctx.author.walletAddress.toLowerCase() : '';
const userParam = String(safeArgs.user || safeArgs.callerWallet || safeArgs.bidder || safeArgs.buyer || safeArgs.advertiser || '').trim().toLowerCase();
const isWalletAddr = (w) => typeof w === 'string' && /^0x[0-9a-f]{40}$/.test(w);
// SECURITY: a wallet passed in args is only a claim; ctx.caller is the signed-in session.
// When the session is a real non-owner viewer, it wins over any claim, so nobody can act as
// another wallet. When ctx.caller is the owner (or missing), the claimed wallet is still used
// for normal actions (the frontend always sends the visitor's own wallet), but it can never
// grant admin (see isAdmin below).
const callerIsViewer = Boolean(ctxCaller && ctxCaller !== ownerWallet && ctxCaller !== ctxAuthor);
const callerWallet = callerIsViewer
  ? ctxCaller
  : (isWalletAddr(userParam) ? userParam : (ctxCaller || ''));
const isAppOwner = Boolean(
  (ctx.caller && ctx.author && ctx.caller.walletId && ctx.caller.walletId === ctx.author.walletId) ||
  (ctxCaller && (ctxCaller === ownerWallet || (ctxAuthor && ctxCaller === ctxAuthor)))
);
// SECURITY: admin comes from the session only, never from a wallet typed into args (the owner
// wallet is public, it's in every ?ref link). A visitor claiming someone else's wallet is never
// admin. Optional extra lock (ADMIN_KEY secret + config.adminKeyRequired) is applied once the
// state is loaded, below.
let isAdmin = Boolean(isAppOwner && (!isWalletAddr(userParam) || userParam === ownerWallet));
const JOE_CONTRACT = '0x3e6a89e0bb914e7a731fcf75ff74ad1ab3851b59';

function calculateDynamicAuctionMetrics({ config, bidsCount, totalClicks, conversionsCount, isMaster, tokenPriceUsd, baseMinBidUsd }) {
  const cfg = config || {};
  const targetSpotValueUsd = Number(cfg.targetSpotValueUsd) || 50;
  const clicksPerSpot = Math.max(10, Number(cfg.clicksPerSpotTarget) || 50);
  const manualOverride = Number(cfg.manualSpotOverride) || 0;

  if (isMaster) {
    const adminCap = Math.max(1, Number(cfg.masterSpotLimit !== undefined ? cfg.masterSpotLimit : cfg.maxSpots) || 10);
    const masterSpotsLimit = adminCap;
    const isPromoActive = cfg.betaTesterEnabled !== false;
    const promoPriceUsd = cfg.betaTesterPriceUsd !== undefined ? Math.max(0, Number(cfg.betaTesterPriceUsd)) : 1;

    let dynamicSpots;
    if (manualOverride > 0) {
      dynamicSpots = Math.min(masterSpotsLimit, manualOverride);
    } else if (isPromoActive) {
      const floorSpots = Math.max(1, Math.min(masterSpotsLimit, Number(cfg.minSpots) || 3));
      dynamicSpots = Math.min(masterSpotsLimit, Math.max(floorSpots, bidsCount));
    } else {
      dynamicSpots = masterSpotsLimit;
    }

    const baseUsd = isPromoActive ? promoPriceUsd : Math.max(30, baseMinBidUsd || 35);
    const demandMultiplier = 1 + Math.min(2.0, (bidsCount / masterSpotsLimit) * 0.5);
    const convMultiplier = conversionsCount > 0 ? Math.min(2.0, 1 + (conversionsCount * 0.15)) : 1.0;
    const dynamicReserveUsd = isPromoActive
      ? Math.max(promoPriceUsd, Math.round(promoPriceUsd * (bidsCount > 0 ? demandMultiplier : 1.0)))
      : Math.round(Math.min(150, Math.max(baseUsd, targetSpotValueUsd * (demandMultiplier * 0.6 + convMultiplier * 0.4))));

    const tokenPrice = Number(tokenPriceUsd) > 0 ? Number(tokenPriceUsd) : 1.0;
    const dynamicReserveToken = Math.round(dynamicReserveUsd / tokenPrice);

    return {
      dynamicSpots,
      minSpots: 1,
      maxSpots: masterSpotsLimit,
      demand: bidsCount,
      trafficSupply: dynamicSpots,
      clicksPerSpot,
      dynamicReserveUsd,
      dynamicReserveToken,
      targetSpotValueUsd: isPromoActive ? promoPriceUsd : targetSpotValueUsd,
      isMaster: true,
      isPromoActive,
      promoPriceUsd,
      adminCap: masterSpotsLimit
    };
  }

  const minSpots = Math.max(1, Number(cfg.minSpots) || 2);
  const maxSpots = Math.max(minSpots, Number(cfg.maxSpots) || 20);
  const baseTraffic = Number(cfg.baseDailyTrafficSupply) || 150;
  const effectiveTraffic = Math.max(Number(totalClicks) || 0, baseTraffic);
  const trafficSupply = Math.max(minSpots, Math.floor(effectiveTraffic / clicksPerSpot));
  const demand = Math.max(0, bidsCount);

  let spots;
  if (manualOverride > 0) {
    spots = Math.min(maxSpots, Math.max(minSpots, manualOverride));
  } else if (cfg.dynamicMode === 'fixed') {
    spots = minSpots;
  } else if (cfg.dynamicMode === 'demand_only') {
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

  const baseReserveUsd = Math.max(10, baseMinBidUsd || 15);
  const signupPressure = conversionsCount > 0 ? Math.min(3.5, 1 + (conversionsCount * 0.25)) : 1.0;
  const clickPressure = (effectiveTraffic > 50) ? Math.min(2.0, 1 + ((effectiveTraffic - 50) / 100)) : 1.0;
  const dynamicReserveUsd = Math.round(Math.min(targetSpotValueUsd * 1.5, Math.max(baseReserveUsd, baseReserveUsd * signupPressure * clickPressure)));

  const tokenPrice = Number(tokenPriceUsd) > 0 ? Number(tokenPriceUsd) : 1.0;
  const dynamicReserveToken = Math.round(dynamicReserveUsd / tokenPrice);

  return {
    dynamicSpots: Math.min(maxSpots, Math.max(minSpots, spots)),
    minSpots,
    maxSpots,
    demand,
    trafficSupply,
    clicksPerSpot,
    dynamicReserveUsd,
    dynamicReserveToken,
    targetSpotValueUsd,
    isMaster: false
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

let state = await appKV.get('rotator_state');
if (!state) {
  state = {
    config: {
      minSpots: 3,
      maxSpots: 30,
      masterSpotLimit: 10,
      masterTrafficPercent: 70,
      rotationMode: 'fair_round_robin',
      rotationIntervalSec: 10,
      lockHourEt: 11,
      lockMinuteEt: 50,
      introOfferDurationHours: 24,
      defaultReferralSharePercent: 25,
      first24hFreeEnabled: true,
      betaTesterPriceUsd: 1.0,
      betaTesterEnabled: true,
      betaTesterDurationHours: 24
    },
    offers: [],
    queue: [],
    bids: [],
    auctionHistory: [],
    clickLogs: [],
    freeTrialWallets: {},
    claimedIntroWallets: {},
    savedLinks: {},
    savedOfferLinks: {},
    walletToSlug: {},
    slugToWallet: {},
    customerReferrers: {},
    commissions: [],
    stats: {
      totalClicks: 0,
      validClicks: 0,
      unattributedClicks: 0,
      attributedClicks: 0
    },
    lastSettledCycle: null
  };
  await appKV.set('rotator_state', state);
}

state.offers = state.offers || [];
// Do not auto-reinsert deleted offers or force Bankr Meme Engine as an offer
if (state.offers.length === 0) {
  state.offers = [
    { id: 'offer_jobless_joe', title: 'Jobless Joe — AI Meme Income Agent', category: 'AI Social Marketing', description: 'Autonomous reply guy & meme studio. Turn viral traffic into daily revenue on Base.', commissionTerms: '20% lifetime referral fee on packages and spot bids in $JOE', tokenSymbol: 'JOE', destinationUrl: 'https://bankr.bot/u/0x2416d6c32c75e58d436e598be3773a4c722053bc/apps/jobless-joe?ref=0x2416d6c32c75e58d436e598be3773a4c722053bc', minBidToken: 35000000, status: 'active' },
    { id: 'offer_bankr', title: 'Bankr', category: 'AI Crypto Infra', description: 'Blockchain-first terminal, autonomous wallet intelligence, trading, and app engine on Base.', commissionTerms: 'Bankr Club referral revenue share where applicable.', tokenSymbol: 'BNKR', destinationUrl: 'https://bankr.bot', minBidToken: 50, status: 'active' },
    { id: 'offer_dh_media', title: 'DH.media', category: 'Web2 Software', description: 'Autonomous agency software & marketing infrastructure platform.', commissionTerms: 'Up to 25% recurring affiliate revenue', tokenSymbol: 'USDC', destinationUrl: 'https://dh.media/?affid=Vesselprotocol', minBidToken: 15, status: 'active' },
    { id: 'offer_fish_audio', title: 'Fish Audio', category: 'Web2 / AI Audio', description: 'High-fidelity AI voice cloning, multi-lingual dubbing & speech synthesis.', commissionTerms: '20% lifetime referral share', tokenSymbol: 'USDC', destinationUrl: 'https://fish.audio/?fpr=oneminute', minBidToken: 15, status: 'active' },
    { id: 'offer_upload_post', title: 'Upload-Post', category: 'Web2 / Social Automation', description: 'Automated video & content distribution pipeline across TikTok, YouTube, Instagram & X.', commissionTerms: '25% monthly recurring commission', tokenSymbol: 'USDC', destinationUrl: 'https://upload-post.com/?ref=VESSEL', minBidToken: 15, status: 'active' },
    { id: 'offer_railway', title: 'Railway', category: 'Web2 Cloud / Dev', description: 'Deploy web applications, AI agents, bots, and databases instantly from GitHub.', commissionTerms: 'Referral credit program subject to Railway platform terms.', tokenSymbol: 'USDC', destinationUrl: 'https://railway.com?referralCode=XO8ClD', minBidToken: 15, status: 'active' }
  ];
}
state.config = state.config || {};
if (state.config.betaTesterPriceUsd === undefined) state.config.betaTesterPriceUsd = 1.0;
if (state.config.betaTesterEnabled === undefined) state.config.betaTesterEnabled = true;
if (state.config.betaTesterDurationHours === undefined) state.config.betaTesterDurationHours = 24;

// SECURITY (optional lock): once enabled, admin also needs the ADMIN_KEY passphrase. The secret
// is only read when a key is actually sent, so visitors' 30-second polling never spends reads.
async function adminKeyMatches(sent) {
  if (!sent) return false;
  try {
    const k = await secrets.get('ADMIN_KEY');
    return Boolean(k) && String(sent) === String(k);
  } catch (e) {
    return false;
  }
}
if (isAdmin && state.config.adminKeyRequired) {
  isAdmin = await adminKeyMatches(safeArgs.adminKey);
}
if (action === 'enableAdminKey') {
  if (!isAppOwner) return { ok: false, error: 'Unauthorized' };
  if (!(await adminKeyMatches(safeArgs.adminKey))) return { ok: false, error: 'That does not match the ADMIN_KEY secret (set it in the app secrets first).' };
  state.config.adminKeyRequired = true;
  await appKV.set('rotator_state', state);
  return { ok: true, message: 'Admin key lock is on. Admin actions now need the key.' };
}
if (action === 'disableAdminKey') {
  if (!isAdmin) return { ok: false, error: 'Unauthorized' };
  state.config.adminKeyRequired = false;
  await appKV.set('rotator_state', state);
  return { ok: true, message: 'Admin key lock is off.' };
}

state.claimedIntroWallets = state.claimedIntroWallets || {};
state.betaTesterWallets = state.betaTesterWallets || {};
state.savedLinks = state.savedLinks || {};
state.savedOfferLinks = state.savedOfferLinks || {};
for (const [w, ol] of Object.entries(state.savedOfferLinks)) {
  const wSlug = (state.walletToSlug && state.walletToSlug[w]) || (w.startsWith('0x') ? w.slice(2, 10).toLowerCase() : w);
  if (ol && ol['offer_the_bankr_meme_engin_mvi5fxbq'] && ol['offer_the_bankr_meme_engin_mvi5fxbq'].includes('https://bankr.bot/apps/bankr-meme-engine')) {
    ol['offer_the_bankr_meme_engin_mvi5fxbq'] = `https://bankr.bot/u/0x2416d6c32c75e58d436e598be3773a4c722053bc/apps/bankr-meme-engine?ref=${wSlug}`;
  }
}
state.walletToSlug = state.walletToSlug || {};
state.slugToWallet = state.slugToWallet || {};
state.customerReferrers = state.customerReferrers || {};
state.commissions = state.commissions || [];
state.payments = state.payments || [];
state.stats = state.stats || {};
if (state.stats.totalUsdcCollected === undefined) state.stats.totalUsdcCollected = 0;

let adminPhoneMedia = (await appKV.get('admin_phone_media')) || state.adminPhoneMedia || {
  url: 'https://bot.plunderandriffle.com/m/7o22J2dwPc18/',
  title: 'Welcome to The Bankr Meme Engine',
  caption: 'Traffic Rotator & Affiliate Auction • Token-Settled on Base',
  ctaUrl: 'https://bankr.bot',
  ctaText: 'Launch ↗',
  enabled: true,
  mediaType: 'embed',
  updatedAt: Date.now()
};

let joePriceUsd = 0.00000028585;
let joeTokensFor10Usd = 34982883;

try {
  const dexs = await http.fetch(`https://api.dexscreener.com/latest/dex/tokens/${JOE_CONTRACT}`);
  if (dexs && dexs.pairs && dexs.pairs.length > 0) {
    const p = parseFloat(dexs.pairs[0].priceUsd);
    if (p > 0) {
      joePriceUsd = p;
      joeTokensFor10Usd = Math.round(10 / p);
    }
  }
} catch (e) {}

const cycle = getEasternTimeInfo();

async function syncPromoterSnapshot(userWallet) {
  if (!userWallet) return;
  const slug = state.walletToSlug[userWallet] || userWallet.slice(2, 10).toLowerCase();
  state.walletToSlug[userWallet] = slug;
  state.slugToWallet[slug] = userWallet;

  let snapshot = await appKV.get('daily_offers');
  if (snapshot) {
    snapshot.promoterMap = snapshot.promoterMap || {};
    const links = state.savedOfferLinks[userWallet] || {};
    if (slug) {
      if (!links['offer_the_bankr_meme_engin_mvi5fxbq'] || links['offer_the_bankr_meme_engin_mvi5fxbq'].includes('https://bankr.bot/apps/bankr-meme-engine')) {
        links['offer_the_bankr_meme_engin_mvi5fxbq'] = `https://bankr.bot/u/0x2416d6c32c75e58d436e598be3773a4c722053bc/apps/bankr-meme-engine?ref=${slug}`;
      }
    }
    if (state.savedLinks[userWallet] && !links['offer_jobless_joe']) {
      links['offer_jobless_joe'] = state.savedLinks[userWallet];
    }
    const entry = { wallet: userWallet, slug, links };
    snapshot.promoterMap[slug] = entry;
    snapshot.promoterMap[userWallet.toLowerCase()] = entry;
    snapshot.masterTrafficPercent = state.config.masterTrafficPercent !== undefined ? state.config.masterTrafficPercent : 70;
    await appKV.set('daily_offers', snapshot);
  }
}

if (action === 'purgeMockPromoter') {
  if (state.slugToWallet && state.slugToWallet['11111111']) delete state.slugToWallet['11111111'];
  if (state.walletToSlug && state.walletToSlug['0x1111111111111111111111111111111111111111']) delete state.walletToSlug['0x1111111111111111111111111111111111111111'];
  if (state.savedOfferLinks && state.savedOfferLinks['0x1111111111111111111111111111111111111111']) delete state.savedOfferLinks['0x1111111111111111111111111111111111111111'];
  await appKV.set('rotator_state', state);
  return { ok: true, purged: true };
}

// Diagnostic: who does Bankr say is calling? Run it signed in as a NON-owner wallet. If
// sessionCaller is that wallet, the session is trusted and nobody can act as another wallet.
// If sessionCaller is the owner for everyone, set the ADMIN_KEY secret (see UPLOAD-NOTES.md).
if (action === 'whoami') {
  return { ok: true, sessionCaller: ctxCaller || null, author: ctxAuthor || null, ownerWallet, callerIsViewer, resolvedWallet: callerWallet || null, isAdmin };
}

if (action === 'getState') {
  if (state.slugToWallet && state.slugToWallet['11111111']) delete state.slugToWallet['11111111'];
  if (state.walletToSlug && state.walletToSlug['0x1111111111111111111111111111111111111111']) delete state.walletToSlug['0x1111111111111111111111111111111111111111'];
  if (state.savedOfferLinks && state.savedOfferLinks['0x1111111111111111111111111111111111111111']) delete state.savedOfferLinks['0x1111111111111111111111111111111111111111'];
  const user = callerWallet || (safeArgs.user || '').toLowerCase();
  let userSlug = '';
  if (user && user.startsWith('0x') && user.length === 42) {
    userSlug = state.walletToSlug[user] || user.slice(2, 10).toLowerCase();
    state.walletToSlug[user] = userSlug;
    state.slugToWallet[userSlug] = user;
  }

  // Record customer referral attribution if customer arrives via ref link for lifetime persistence
  const incomingRef = (safeArgs.ref || '').trim();
  const incomingAgentId = (safeArgs.agentId || safeArgs.agent_id || safeArgs.agent || '').trim();
  let referrerPromoter = null;
  let targetWallet = null;
  let targetSlug = '';

  if (incomingAgentId && user) {
    state.customerAgentReferrers = state.customerAgentReferrers || {};
    state.customerAgentReferrers[user] = incomingAgentId;
  }

  if (incomingRef) {
    const s = incomingRef.toLowerCase();
    targetWallet = state.slugToWallet[s] || (s.startsWith('0x') && s.length === 42 ? s : null) || (Object.keys(state.walletToSlug).find(wal => (state.walletToSlug[wal] || '').toLowerCase() === s));
    if (targetWallet) {
      targetSlug = state.walletToSlug[targetWallet] || s;
    }
  }

  // Fallback to bound customer referral if no ref param provided in URL
  if (!targetWallet && user && state.customerReferrers && state.customerReferrers[user]) {
    targetWallet = state.customerReferrers[user];
    targetSlug = (state.walletToSlug && state.walletToSlug[targetWallet]) || targetWallet.slice(2, 10).toLowerCase();
  }

  if (targetWallet) {
    if (user && user !== targetWallet && !state.customerReferrers[user]) {
      state.customerReferrers[user] = targetWallet;
      state.customerReferralLogs = state.customerReferralLogs || [];
      state.customerReferralLogs.push({ referee: user, referrer: targetWallet, slug: targetSlug, createdAt: Date.now() });
      await appKV.set('rotator_state', state);
    }
    const pLinks = Object.assign({}, (state.savedOfferLinks && state.savedOfferLinks[targetWallet]) || {});
    if (targetSlug) {
      if (!pLinks['offer_the_bankr_meme_engin_mvi5fxbq'] || pLinks['offer_the_bankr_meme_engin_mvi5fxbq'].includes('https://bankr.bot/apps/bankr-meme-engine')) {
        pLinks['offer_the_bankr_meme_engin_mvi5fxbq'] = `https://bankr.bot/u/0x2416d6c32c75e58d436e598be3773a4c722053bc/apps/bankr-meme-engine?ref=${targetSlug}`;
      }
    }
    if (state.savedLinks && state.savedLinks[targetWallet] && !pLinks['offer_jobless_joe']) {
      pLinks['offer_jobless_joe'] = state.savedLinks[targetWallet];
    }
    referrerPromoter = {
      wallet: targetWallet,
      slug: targetSlug,
      links: pLinks
    };
  }
  const hasClaimed = user ? Boolean(state.claimedIntroWallets[user]) : false;
  const freeTrial = user ? (state.freeTrialWallets[user] || null) : null;
  const savedLink = user ? (state.savedLinks[user] || '') : '';
  const userActiveBid = user ? ((state.bids || []).find(b => b.bidder === user && b.status === 'active') || null) : null;
  const userCommissions = user ? (state.commissions || []).filter(c => c.humanRef === user || c.agentId === user || c.wallet === user || c.referrerWallet === user) : [];

  const userRefStats = (user && (await appKV.get(`user_ref_stats_${user}`))) || {
    clicks: 0,
    referralsCount: 0,
    commissionsEarnedUsd: 0,
    commissionsJoe: 0,
    referrals: []
  };

  const userSavedOfferLinks = (state.savedOfferLinks && state.savedOfferLinks[user]) || {};
  if (userSlug) {
    if (!userSavedOfferLinks['offer_the_bankr_meme_engin_mvi5fxbq'] || userSavedOfferLinks['offer_the_bankr_meme_engin_mvi5fxbq'].includes('https://bankr.bot/apps/bankr-meme-engine')) {
      userSavedOfferLinks['offer_the_bankr_meme_engin_mvi5fxbq'] = `https://bankr.bot/u/0x2416d6c32c75e58d436e598be3773a4c722053bc/apps/bankr-meme-engine?ref=${userSlug}`;
    }
  }
  if (savedLink && !userSavedOfferLinks['offer_jobless_joe']) {
    userSavedOfferLinks['offer_jobless_joe'] = savedLink;
  }
  let totalUserClicks = 0;
  const userQueueItems = (state.queue || []).filter(q => q.advertiser === user);
  for (const q of userQueueItems) {
    totalUserClicks += (q.clicksDelivered || 0);
  }
  let lifetimeEarnedUsd = Number(userRefStats.commissionsEarnedUsd || 0);
  let pendingCommissionsUsd = 0;

  let totalSignups = 0;
  for (const c of userCommissions) {
    if (c.status === 'paid' || c.status === 'approved' || c.status === 'credited') {
      lifetimeEarnedUsd += Number(c.eligibleAmountUsd || 0);
      totalSignups += 1;
    } else if (c.status === 'pending' || c.status === 'verified') {
      pendingCommissionsUsd += Number(c.eligibleAmountUsd || 0);
    }
  }

  // Include all permanently bound customer referrals in promoter's history and totals
  const boundReferrals = [];
  if (user) {
    state.customerReferralLogs = state.customerReferralLogs || [];
    for (const [referee, refWallet] of Object.entries(state.customerReferrers || {})) {
      const isDirect = (refWallet === user);
      if (isDirect || isAdmin) {
        const log = state.customerReferralLogs.find(l => l.referee === referee);
        const refSlug = (state.walletToSlug && state.walletToSlug[refWallet]) || refWallet.slice(2, 10).toLowerCase();
        boundReferrals.push({
          referee: referee.slice(0, 6) + '...' + referee.slice(-4),
          referrer: refWallet.slice(0, 6) + '...' + refWallet.slice(-4),
          referrerSlug: refSlug,
          type: isDirect ? 'Universal Referral' : `Network Ref (${refSlug})`,
          commission: '25% Lifetime Share',
          status: 'Active (Lifetime)',
          createdAt: log ? log.createdAt : Date.now()
        });
      }
    }
  }
  totalSignups += boundReferrals.length;

  const perOfferAnalytics = {};
  for (const off of (state.offers || [])) {
    let clicks = 0;
    for (const q of userQueueItems) {
      if (q.offerId === off.id || q.title === off.title) {
        clicks += (q.clicksDelivered || 0);
      }
    }
    let signups = 0;
    let earnedUsd = 0;
    if (off.id === 'offer_jobless_joe') {
      signups = userRefStats.referralsCount || 0;
      earnedUsd = Number(userRefStats.commissionsEarnedUsd || 0);
    }
    const offComms = userCommissions.filter(c => c.offerId === off.id);
    for (const oc of offComms) {
      if (oc.status === 'paid' || oc.status === 'approved' || oc.status === 'credited') {
        earnedUsd += Number(oc.eligibleAmountUsd || 0);
        signups += 1;
      }
    }
    perOfferAnalytics[off.id] = {
      clicksDelivered: clicks,
      signups,
      earnedUsd: Number(earnedUsd.toFixed(2)),
      savedLink: userSavedOfferLinks[off.id] || ''
    };
  }

  // Beta Activity Points calculation for retroactive token allocation
  state.launchAlertSubscribers = state.launchAlertSubscribers || {};
  const isLaunchSubscribed = user ? Boolean(state.launchAlertSubscribers[user]) : false;
  const subscriberEntry = user ? (state.launchAlertSubscribers[user] || null) : null;

  const savedLinksCount = Object.keys(userSavedOfferLinks).filter(k => userSavedOfferLinks[k] && userSavedOfferLinks[k].startsWith('http')).length;
  const savedLinksPts = savedLinksCount * 50;
  const clicksPts = totalUserClicks * 10;
  const userPlacementsCount = userQueueItems.length + (state.betaTesterWallets && state.betaTesterWallets[user] ? 1 : 0);
  const placementsPts = userPlacementsCount * 200;
  const userBidsCount = (state.bids || []).filter(b => b.bidder === user).length;
  const bidsPts = userBidsCount * 75;
  const referralsPts = totalSignups * 250;
  const alertBonusPts = isLaunchSubscribed ? 100 : 0;
  const baseParticipationPts = (user && user.startsWith('0x')) ? 50 : 0;

  const totalBetaPoints = savedLinksPts + clicksPts + placementsPts + bidsPts + referralsPts + alertBonusPts + baseParticipationPts;

  let rankTier = 'Beta Explorer';
  if (totalBetaPoints >= 1500) rankTier = 'Apex Traffic Titan';
  else if (totalBetaPoints >= 800) rankTier = 'Master Promoter';
  else if (totalBetaPoints >= 350) rankTier = 'Active Pioneer';
  else if (totalBetaPoints >= 100) rankTier = 'Alpha Tester';

  const userBetaPoints = {
    totalPoints: totalBetaPoints,
    rankTier,
    isLaunchSubscribed,
    subscriberEntry,
    breakdown: {
      savedLinksPts,
      savedLinksCount,
      clicksPts,
      clicksCount: totalUserClicks,
      placementsPts,
      placementsCount: userPlacementsCount,
      bidsPts,
      bidsCount: userBidsCount,
      referralsPts,
      referralsCount: totalSignups,
      alertBonusPts,
      baseParticipationPts
    }
  };

  const userSummary = {
    totalClicks: totalUserClicks,
    totalSignups,
    lifetimeEarnedUsd: Number(lifetimeEarnedUsd.toFixed(2)),
    pendingCommissionsUsd: Number(pendingCommissionsUsd.toFixed(2)),
    joeCommissions: userRefStats.commissionsJoe || 0,
    referrals: [...boundReferrals, ...(userRefStats.referrals || [])],
    perOfferAnalytics,
    betaPoints: userBetaPoints
  };

  const totalClicks = (state.stats && state.stats.validClicks) || 0;
  const allActiveBids = (state.bids || []).filter(b => b.status === 'active');
  const masterBids = allActiveBids.filter(b => b.placementType === 'master');
  const indivBids = allActiveBids.filter(b => b.placementType !== 'master');
  const conversionsCount = (state.commissions || []).length;

  const masterSpotCalc = calculateDynamicAuctionMetrics({
    config: state.config || {},
    bidsCount: masterBids.length,
    totalClicks,
    conversionsCount,
    isMaster: true,
    tokenPriceUsd: 1.0,
    baseMinBidUsd: 35
  });

  const indivSpotCalc = calculateDynamicAuctionMetrics({
    config: state.config || {},
    bidsCount: indivBids.length,
    totalClicks,
    conversionsCount,
    isMaster: false,
    tokenPriceUsd: joePriceUsd,
    baseMinBidUsd: 15
  });

  // SECURITY: getState used to hand every visitor the WHOLE rotator state: every wallet's saved
  // affiliate links, who referred whom, every payment, every launch-alert Telegram handle.
  // Non-admins now get the shared catalog plus only their own slice (and their referrer's
  // public links, which the page needs to rewrite offer buttons).
  const pick = (obj, keys) => {
    const out = {};
    for (const k of keys) if (k && obj && obj[k] !== undefined) out[k] = obj[k];
    return out;
  };
  const visibleWallets = [user, targetWallet].filter(Boolean);
  const visibleState = isAdmin ? state : Object.assign({}, state, {
    savedOfferLinks: pick(state.savedOfferLinks, visibleWallets),
    savedLinks: pick(state.savedLinks, visibleWallets),
    walletToSlug: pick(state.walletToSlug, visibleWallets),
    slugToWallet: pick(state.slugToWallet, visibleWallets.map(w => state.walletToSlug[w])),
    customerReferrers: Object.fromEntries(Object.entries(state.customerReferrers || {}).filter(([referee, ref]) => referee === user || ref === user)),
    customerAgentReferrers: pick(state.customerAgentReferrers, [user]),
    customerReferralLogs: (state.customerReferralLogs || []).filter(l => l.referrer === user || l.referee === user),
    claimedIntroWallets: pick(state.claimedIntroWallets, [user]),
    freeTrialWallets: pick(state.freeTrialWallets, [user]),
    betaTesterWallets: pick(state.betaTesterWallets, [user]),
    launchAlertSubscribers: pick(state.launchAlertSubscribers, [user]),
    commissions: userCommissions,
    payments: (state.payments || []).filter(p => p.payer === user),
    usedTxHashes: undefined
  });

  return {
    ok: true,
    state: visibleState,
    cycle,
    isAdmin,
    ownerWallet,
    callerWallet,
    userSlug,
    referrerPromoter,
    joeContract: JOE_CONTRACT,
    joePriceUsd,
    joeTokensFor10Usd,
    hasClaimedIntro: hasClaimed,
    freeTrial,
    savedLink,
    userActiveBid,
    userCommissions,
    userSummary,
    userSavedOfferLinks,
    adminPhoneMedia,
    betaTesterConfig: {
      priceUsd: state.config.betaTesterPriceUsd !== undefined ? state.config.betaTesterPriceUsd : 1.0,
      enabled: state.config.betaTesterEnabled !== false,
      durationHours: state.config.betaTesterDurationHours || 24
    },
    userBetaTester: user ? (state.betaTesterWallets && state.betaTesterWallets[user]) : null,
    spotCalc: indivSpotCalc,
    masterSpotCalc,
    indivSpotCalc,
    payments: visibleState.payments || [],
    totalUsdcCollected: Number(state.stats.totalUsdcCollected || 0),
    usdcRecipient: ownerWallet,
    usdcContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    userBetaPoints,
    isLaunchSubscribed
  };
}

if (action === 'subscribeLaunchAlert') {
  const user = (callerWallet || '').toLowerCase();
  const telegramHandle = (safeArgs.telegramHandle || safeArgs.handle || '').trim();
  if (!user || !user.startsWith('0x')) return { ok: false, error: 'Sign in with your wallet to register for token launch alerts' };

  state.launchAlertSubscribers = state.launchAlertSubscribers || {};
  state.launchAlertSubscribers[user] = {
    wallet: user,
    telegramHandle: telegramHandle || 'connected_wallet',
    subscribedAt: Date.now()
  };

  await appKV.set('rotator_state', state);

  return {
    ok: true,
    message: 'Registered for Token Launch alerts! +100 Beta Points awarded.',
    subscriber: state.launchAlertSubscribers[user]
  };
}

if (action === 'setAdminPhoneMedia') {
  if (!isAdmin) return { ok: false, error: 'Unauthorized: Only admin can configure welcome phone media' };
  const { url, title, caption, ctaUrl, ctaText, enabled, mediaType } = safeArgs;
  adminPhoneMedia = {
    url: url || '',
    title: title || 'Welcome to The Bankr Meme Engine',
    caption: caption || 'Traffic Rotator & Affiliate Auction • Token-Settled on Base',
    ctaUrl: ctaUrl || url || '',
    ctaText: ctaText || 'View Page ↗',
    enabled: enabled !== false,
    mediaType: mediaType || (url && url.match(/\.(mp4|webm|mov)(\?|$)/i) ? 'video' : (url && (url.includes('youtube.com') || url.includes('youtu.be')) ? 'youtube' : 'embed')),
    updatedAt: Date.now(),
    updatedBy: callerWallet || ownerWallet
  };
  state.adminPhoneMedia = adminPhoneMedia;
  await appKV.set('admin_phone_media', adminPhoneMedia);
  await appKV.set('rotator_state', state);
  let snap = await appKV.get('daily_offers');
  if (snap) {
    snap.adminPhoneMedia = adminPhoneMedia;
    await appKV.set('daily_offers', snap);
  }
  return { ok: true, adminPhoneMedia, message: 'Welcome phone media updated successfully!' };
}

if (action === 'updateBetaTesterConfig') {
  if (!isAdmin) return { ok: false, error: 'Unauthorized: Only admin can update beta tester configuration' };
  state.config = state.config || {};
  if (safeArgs.priceUsd !== undefined) state.config.betaTesterPriceUsd = Math.max(0, Number(safeArgs.priceUsd));
  if (safeArgs.enabled !== undefined) state.config.betaTesterEnabled = safeArgs.enabled !== false;
  if (safeArgs.durationHours !== undefined) state.config.betaTesterDurationHours = Math.max(1, Number(safeArgs.durationHours) || 24);
  await appKV.set('rotator_state', state);
  return { 
    ok: true, 
    betaTesterConfig: { 
      priceUsd: state.config.betaTesterPriceUsd, 
      enabled: state.config.betaTesterEnabled, 
      durationHours: state.config.betaTesterDurationHours 
    }, 
    message: 'Beta tester configuration saved!' 
  };
}

if (action === 'preparePayment') {
  const user = (callerWallet || '').toLowerCase();
  let destinationUrl = (safeArgs.destinationUrl || '').trim();
  if (!user) return { ok: false, error: 'Wallet address required' };

  const checkTime = Date.now();
  const existingActiveSpot = (state.queue || []).find(q => q.advertiser && q.advertiser.toLowerCase() === user && q.status === 'active' && (!q.expiresAt || q.expiresAt > checkTime));
  if (existingActiveSpot) {
    return {
      ok: false,
      error: 'You already have an active spot in the rotator queue (' + (existingActiveSpot.title || 'Active') + '). Additional activations are blocked while your spot is active.'
    };
  }

  let userSlug = state.walletToSlug[user] || user.slice(2, 10).toLowerCase();
  state.walletToSlug[user] = userSlug;
  state.slugToWallet[userSlug] = user;

  if (!destinationUrl || !destinationUrl.startsWith('http')) {
    destinationUrl = `https://bankr.bot/u/0x2416d6c32c75e58d436e598be3773a4c722053bc/apps/bankr-meme-engine?ref=${userSlug}`;
  }

  state.config = state.config || {};
  const requestedPrice = safeArgs.amountUsd !== undefined
    ? Number(safeArgs.amountUsd)
    : (safeArgs.tier === 'agent' ? 10.0 : (state.config.betaTesterPriceUsd !== undefined ? Number(state.config.betaTesterPriceUsd) : 1.0));
  const priceUsd = Math.max(1.0, requestedPrice);
  const isAgentUpgrade = priceUsd >= 10;
  const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

  const amountAtomic = Math.round(priceUsd * 1000000).toString();
  const cleanRecipient = ownerWallet.replace('0x', '').toLowerCase().padStart(64, '0');
  const cleanAmount = BigInt(amountAtomic).toString(16).padStart(64, '0');
  const txData = '0xa9059cbb' + cleanRecipient + cleanAmount;

  const planLabel = isAgentUpgrade
    ? `Pay $${priceUsd} USDC for 24-Hour Jobless Joe Agent Upgrade`
    : `Pay $${priceUsd} USDC for 24-Hour Master Rotator Spot`;

  let txBlob = null;
  try {
    txBlob = await bankr.tx.prepare({
      chain: 'base',
      to: USDC_BASE,
      data: txData,
      value: '0',
      label: planLabel
    });
  } catch (err) {
    log('bankr.tx.prepare notice:', err.message);
  }

  const orderId = 'ord_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
  return {
    ok: true,
    orderId,
    priceUsd,
    amountAtomic,
    recipient: ownerWallet,
    usdcContract: USDC_BASE,
    destinationUrl,
    planLabel,
    isAgentUpgrade,
    txData,
    txBlob,
    message: `Payment order prepared for $${priceUsd} USDC`
  };
}

if (action === 'confirmPaymentAndActivate') {
  const user = (callerWallet || '').toLowerCase();
  let destinationUrl = (safeArgs.destinationUrl || '').trim();
  const orderId = safeArgs.orderId || ('pay_' + Date.now());
  const txHash = (safeArgs.txHash || '').trim();
  if (!user) return { ok: false, error: 'Wallet address required' };

  if (!isAdmin && !txHash) {
    return {
      ok: false,
      error: 'On-chain transaction hash required to verify payment. If you sent the USDC via Bankr chat or terminal, enter the tx hash or ask in chat to confirm.'
    };
  }
  // SECURITY: a tx hash must look like one and can only ever activate one spot. (It is still
  // not checked on-chain; see UPLOAD-NOTES.md. Until it is, admins should spot-check the
  // payments table against Basescan.)
  if (txHash) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return { ok: false, error: 'That does not look like a Base transaction hash (0x + 64 hex characters).' };
    }
    state.usedTxHashes = state.usedTxHashes || {};
    const txKey = txHash.toLowerCase();
    if (state.usedTxHashes[txKey]) {
      return { ok: false, error: 'This transaction hash was already used to activate a spot.' };
    }
    state.usedTxHashes[txKey] = { user, at: Date.now() };
  }

  const checkTime = Date.now();
  const existingActiveSpot = (state.queue || []).find(q => q.advertiser && q.advertiser.toLowerCase() === user && q.status === 'active' && (!q.expiresAt || q.expiresAt > checkTime));
  if (existingActiveSpot) {
    return {
      ok: false,
      error: 'You already have an active spot in the rotator queue. Only 1 active spot is permitted per wallet.'
    };
  }

  let userSlug = state.walletToSlug[user] || user.slice(2, 10).toLowerCase();
  state.walletToSlug[user] = userSlug;
  state.slugToWallet[userSlug] = user;

  if (!destinationUrl || !destinationUrl.startsWith('http')) {
    destinationUrl = `https://bankr.bot/u/0x2416d6c32c75e58d436e598be3773a4c722053bc/apps/bankr-meme-engine?ref=${userSlug}`;
  }

  state.config = state.config || {};
  // SECURITY: the price comes from config, not from the caller. The caller only picks the tier
  // (any requested amount >= 10, or tier 'agent', means the $10 agent upgrade). Admins may still
  // record a custom amount for manual activations.
  const starterPriceUsd = state.config.betaTesterPriceUsd !== undefined ? Number(state.config.betaTesterPriceUsd) : 1.0;
  const agentPriceUsd = state.config.agentUpgradePriceUsd !== undefined ? Number(state.config.agentUpgradePriceUsd) : 10.0;
  const wantsAgentTier = safeArgs.tier === 'agent' || Number(safeArgs.amountUsd) >= 10;
  const priceUsd = (isAdmin && safeArgs.amountUsd !== undefined)
    ? Number(safeArgs.amountUsd)
    : (wantsAgentTier ? agentPriceUsd : starterPriceUsd);
  const durationHours = Number(state.config.betaTesterDurationHours) || 24;
  const now = Date.now();
  const expiresAt = now + (durationHours * 3600000);
  const isAgentUpgrade = priceUsd >= 10;

  const placementTitle = isAgentUpgrade
    ? 'Jobless Joe Agent Upgrade (24h Promotion Package)'
    : 'Master Rotator Placement (All Offers)';

  const placement = {
    id: 'beta_master_' + now + '_' + Math.floor(Math.random() * 1000),
    placementType: 'master',
    offerId: isAgentUpgrade ? 'agent_promotion_package' : 'master_all_offers',
    title: placementTitle,
    description: isAgentUpgrade
      ? `24-Hour Jobless Joe Agent Upgrade ($${priceUsd} USDC Paid)`
      : `24-Hour Master Rotator Spot ($${priceUsd} USDC Paid)`,
    destinationUrl,
    advertiser: user,
    advertiserSlug: userSlug,
    tokenSymbol: 'USDC',
    tokenAmount: priceUsd,
    type: isAgentUpgrade ? 'agent_upgrade' : 'beta_tester',
    status: 'active',
    activatedAt: now,
    expiresAt,
    orderId,
    txHash: txHash || undefined,
    clicksDelivered: 0
  };

  state.queue = state.queue || [];
  const existingQueueIdx = state.queue.findIndex(q => q.advertiser && q.advertiser.toLowerCase() === user && q.status === 'active' && (!q.expiresAt || q.expiresAt > now));
  if (existingQueueIdx !== -1) {
    state.queue[existingQueueIdx].expiresAt = expiresAt;
    state.queue[existingQueueIdx].destinationUrl = destinationUrl;
    state.queue[existingQueueIdx].tokenAmount = priceUsd;
    state.queue[existingQueueIdx].orderId = orderId;
    state.queue[existingQueueIdx].title = placement.title;
    state.queue[existingQueueIdx].type = placement.type;
  } else {
    state.queue.unshift(placement);
  }
  state.betaTesterWallets = state.betaTesterWallets || {};
  state.betaTesterWallets[user] = {
    claimedAt: now,
    expiresAt,
    destinationUrl,
    offerId: 'master_all_offers',
    title: placement.title,
    priceUsd,
    status: 'active',
    orderId,
    txHash: txHash || undefined
  };

  state.savedLinks = state.savedLinks || {};
  state.savedOfferLinks = state.savedOfferLinks || {};
  state.savedOfferLinks[user] = state.savedOfferLinks[user] || {};
  state.savedOfferLinks[user]['offer_the_bankr_meme_engin_mvi5fxbq'] = destinationUrl;

  // Instant 25% referral commission distribution if payer was referred by agent or human
  const refWallet = state.customerReferrers[user];
  const refAgent = (state.customerAgentReferrers && state.customerAgentReferrers[user]) || (safeArgs.agentId || safeArgs.agent_id || safeArgs.agent || '').trim();
  let referralCommissionUsd = 0;
  if (refAgent) {
    referralCommissionUsd = Number((priceUsd * 0.25).toFixed(2));
    state.commissions = state.commissions || [];
    state.commissions.unshift({
      id: 'comm_agent_' + now + '_' + Math.floor(Math.random() * 1000),
      type: 'beta_tester_agent_payment',
      offerId: 'master_all_offers',
      customer: user,
      agentId: refAgent,
      wallet: refWallet || refAgent,
      referrerWallet: refWallet || null,
      grossAmountUsd: priceUsd,
      sharePercent: 25,
      eligibleAmountUsd: referralCommissionUsd,
      status: 'approved',
      createdAt: now
    });
  } else if (refWallet && refWallet !== user) {
    referralCommissionUsd = Number((priceUsd * 0.25).toFixed(2));
    state.commissions = state.commissions || [];
    state.commissions.unshift({
      id: 'comm_' + now + '_' + Math.floor(Math.random() * 1000),
      type: 'beta_tester_payment',
      offerId: 'master_all_offers',
      customer: user,
      wallet: refWallet,
      referrerWallet: refWallet,
      grossAmountUsd: priceUsd,
      sharePercent: 25,
      eligibleAmountUsd: referralCommissionUsd,
      status: 'approved',
      createdAt: now
    });
  }

  state.payments = state.payments || [];
  const paymentRecord = {
    id: orderId,
    payer: user,
    recipient: ownerWallet,
    amountUsd: priceUsd,
    tokenSymbol: 'USDC',
    chain: 'base',
    destinationUrl,
    status: 'confirmed',
    txHash: txHash || null,
    timestamp: now
  };
  state.payments.unshift(paymentRecord);
  state.stats = state.stats || {};
  state.stats.totalUsdcCollected = (Number(state.stats.totalUsdcCollected) || 0) + priceUsd;

  await syncPromoterSnapshot(user);
  await appKV.set('rotator_state', state);

  let snapshot = await appKV.get('daily_offers');
  if (snapshot) {
    snapshot.masterOffers = snapshot.masterOffers || [];
    snapshot.masterOffers.unshift({
      id: placement.id,
      offerId: 'master_all_offers',
      placementType: 'master',
      title: placement.title,
      category: 'Master Network Sponsor',
      description: placement.description,
      destinationUrl: placement.destinationUrl,
      advertiser: user,
      advertiserSlug: userSlug,
      tokenSymbol: 'USDC',
      status: 'active',
      expiresAt: placement.expiresAt
    });
    snapshot.activeCount = (snapshot.masterOffers || []).length + (snapshot.offers || []).length;
    await appKV.set('daily_offers', snapshot);
  }

  return {
    ok: true,
    payment: paymentRecord,
    placement,
    priceUsd,
    message: `Payment of $${priceUsd} USDC confirmed! Master Rotator spot is now LIVE for 24 hours.`
  };
}

if (action === 'activateBetaTester') {
  // SECURITY: this activates a spot without any payment, and the page never calls it. Admin-only.
  if (!isAdmin) return { ok: false, error: 'Unauthorized: use the $1 USDC checkout to activate a spot' };
  const user = (callerWallet || '').toLowerCase();
  let destinationUrl = (safeArgs.destinationUrl || '').trim();
  const offerId = 'master_all_offers';
  if (!user) return { ok: false, error: 'Wallet address required' };

  if (state.betaTesterWallets && state.betaTesterWallets[user]) {
    return {
      ok: false,
      error: 'The $1 starter spot is 1-time only for 24 hours. Next step: graduate to your own personal bot!'
    };
  }

  let userSlug = state.walletToSlug[user] || user.slice(2, 10).toLowerCase();
  state.walletToSlug[user] = userSlug;
  state.slugToWallet[userSlug] = user;

  if (!destinationUrl || !destinationUrl.startsWith('http')) {
    destinationUrl = `https://bankr.bot/u/0x2416d6c32c75e58d436e598be3773a4c722053bc/apps/bankr-meme-engine?ref=${userSlug}`;
  }

  state.config = state.config || {};
  const priceUsd = state.config.betaTesterPriceUsd !== undefined ? Number(state.config.betaTesterPriceUsd) : 1.0;
  const durationHours = Number(state.config.betaTesterDurationHours) || 24;
  const now = Date.now();
  const expiresAt = now + (durationHours * 3600000);

  const title = safeArgs.title || 'Master Rotator Placement (All Offers)';

  const placement = {
    id: 'beta_master_' + now + '_' + Math.floor(Math.random() * 1000),
    placementType: 'master',
    offerId: 'master_all_offers',
    title,
    description: '24-Hour Master Rotator Spot ($1 Beta Tester)',
    destinationUrl,
    advertiser: user,
    advertiserSlug: userSlug,
    tokenSymbol: 'USDC',
    tokenAmount: priceUsd,
    type: 'beta_tester',
    status: 'active',
    activatedAt: now,
    expiresAt,
    clicksDelivered: 0
  };

  state.queue = state.queue || [];
  state.queue.unshift(placement);
  state.betaTesterWallets = state.betaTesterWallets || {};
  state.betaTesterWallets[user] = {
    claimedAt: now,
    expiresAt,
    destinationUrl,
    offerId: 'master_all_offers',
    title,
    priceUsd,
    status: 'active'
  };

  state.savedLinks = state.savedLinks || {};
  state.savedOfferLinks = state.savedOfferLinks || {};
  state.savedOfferLinks[user] = state.savedOfferLinks[user] || {};
  state.savedOfferLinks[user]['offer_the_bankr_meme_engin_mvi5fxbq'] = destinationUrl;

  await syncPromoterSnapshot(user);
  await appKV.set('rotator_state', state);

  let snapshot = await appKV.get('daily_offers');
  if (snapshot) {
    snapshot.masterOffers = snapshot.masterOffers || [];
    snapshot.masterOffers.unshift({
      id: placement.id,
      offerId: 'master_all_offers',
      placementType: 'master',
      title: placement.title,
      category: 'Master Network Sponsor',
      description: placement.description,
      destinationUrl: placement.destinationUrl,
      advertiser: user,
      advertiserSlug: userSlug,
      tokenSymbol: 'USDC',
      status: 'active',
      expiresAt: placement.expiresAt
    });
    snapshot.activeCount = (snapshot.masterOffers || []).length + (snapshot.offers || []).length;
    await appKV.set('daily_offers', snapshot);
  }

  return {
    ok: true,
    placement,
    priceUsd,
    userBetaTester: state.betaTesterWallets[user],
    message: `Master Rotator spot activated for 24 hours ($${priceUsd} in USDC)!`
  };
}

if (action === 'claimFree24hTrial') {
  // SECURITY: this activates a spot without any payment, and the page never calls it. Admin-only.
  if (!isAdmin) return { ok: false, error: 'Unauthorized: use the $1 USDC checkout to activate a spot' };
  const user = (callerWallet || '').toLowerCase();
  const destinationUrl = (safeArgs.destinationUrl || '').trim();
  const offerId = safeArgs.offerId || 'custom_free_trial';

  if (!user) return { ok: false, error: 'Wallet address needed for 24h free trial' };
  if (!destinationUrl || !destinationUrl.startsWith('http')) {
    return { ok: false, error: 'Valid HTTP/HTTPS destination URL needed' };
  }

  if (state.freeTrialWallets[user]) {
    return {
      ok: false,
      error: '24-hour free trial has already been claimed for this wallet. Subsequent placements must use auction bids.',
      trial: state.freeTrialWallets[user]
    };
  }

  const matchedOffer = (state.offers || []).find(o => o.id === offerId);
  const offerTitle = safeArgs.title || (matchedOffer ? matchedOffer.title : 'Free 24h Promoter Placement');

  const now = Date.now();
  const expiresAt = now + (24 * 3600000);

  const placement = {
    id: 'free_' + now + '_' + Math.floor(Math.random() * 1000),
    offerId,
    title: offerTitle,
    description: '24-Hour Free Trial Placement',
    destinationUrl,
    advertiser: user,
    tokenSymbol: 'FREE',
    tokenAmount: 0,
    type: 'free_trial',
    status: 'active',
    activatedAt: now,
    expiresAt,
    clicksDelivered: 0
  };

  state.queue = state.queue || [];
  state.queue.unshift(placement);

  state.freeTrialWallets[user] = {
    claimedAt: now,
    expiresAt,
    destinationUrl,
    offerId,
    title: offerTitle,
    status: 'active'
  };

  state.savedLinks[user] = destinationUrl;
  state.savedOfferLinks[user] = state.savedOfferLinks[user] || {};
  state.savedOfferLinks[user][offerId] = destinationUrl;

  await syncPromoterSnapshot(user);
  await appKV.set('rotator_state', state);

  return {
    ok: true,
    trial: state.freeTrialWallets[user],
    placement,
    message: '24-hour free trial activated! Placed in round-robin queue.'
  };
}

if (action === 'saveAffiliateLink') {
  const user = (callerWallet || '').toLowerCase();
  const link = (safeArgs.link || '').trim();
  const offerId = safeArgs.offerId || 'offer_jobless_joe';
  if (!user) return { ok: false, error: 'User wallet address needed' };
  if (!link || !link.startsWith('http')) return { ok: false, error: 'Valid HTTP/HTTPS affiliate link needed' };

  state.savedLinks[user] = link;
  state.savedOfferLinks[user] = state.savedOfferLinks[user] || {};
  state.savedOfferLinks[user][offerId] = link;

  await syncPromoterSnapshot(user);
  await appKV.set('rotator_state', state);
  return { ok: true, savedLink: link, savedOfferLinks: state.savedOfferLinks[user], message: 'Affiliate link saved successfully!' };
}

if (action === 'saveOfferLinks') {
  const user = (callerWallet || '').toLowerCase();
  if (!user) return { ok: false, error: 'User wallet address needed' };
  state.savedOfferLinks[user] = state.savedOfferLinks[user] || {};
  
  if (safeArgs.offerId && safeArgs.link !== undefined) {
    const lk = String(safeArgs.link).trim();
    state.savedOfferLinks[user][safeArgs.offerId] = lk;
    if (safeArgs.offerId === 'offer_jobless_joe') {
      state.savedLinks[user] = lk;
    }
  }
  if (safeArgs.offerLinks && typeof safeArgs.offerLinks === 'object') {
    for (const [oid, lk] of Object.entries(safeArgs.offerLinks)) {
      if (typeof lk === 'string') {
        state.savedOfferLinks[user][oid] = lk.trim();
        if (oid === 'offer_jobless_joe') {
          state.savedLinks[user] = lk.trim();
        }
      }
    }
  }

  await syncPromoterSnapshot(user);
  await appKV.set('rotator_state', state);
  return { ok: true, savedOfferLinks: state.savedOfferLinks[user], message: 'All offer affiliate links saved successfully!' };
}

if (action === 'placeBid') {
  const bidder = (callerWallet || '').toLowerCase();
  const placementType = 'master';
  const offerId = 'master_all_offers';
  let destinationUrl = (safeArgs.destinationUrl || '').trim();
  const bidderSlug = state.walletToSlug[bidder] || (bidder ? bidder.slice(2, 10).toLowerCase() : '2416d6c3');
  if (!destinationUrl || destinationUrl.includes('https://bankr.bot/apps/bankr-meme-engine') || destinationUrl.includes('jobless-joe')) {
    destinationUrl = `https://bankr.bot/u/0x2416d6c32c75e58d436e598be3773a4c722053bc/apps/bankr-meme-engine?ref=${bidderSlug}`;
  }
  const bidAmountToken = Number(safeArgs.bidAmountToken) || 0;
  const incomingRef = (safeArgs.ref || safeArgs.referrer || '').trim();
  const incomingAgentId = (safeArgs.agentId || safeArgs.agent_id || safeArgs.agent || '').trim();

  if (!bidder) return { ok: false, error: 'Sign in or specify bidder address' };
  if (!destinationUrl || !destinationUrl.startsWith('http')) return { ok: false, error: 'Valid HTTP/HTTPS affiliate link needed' };

  if (bidder && incomingAgentId) {
    state.customerAgentReferrers = state.customerAgentReferrers || {};
    state.customerAgentReferrers[bidder] = incomingAgentId;
  }

  if (incomingRef) {
    const s = incomingRef.toLowerCase();
    const refWallet = state.slugToWallet[s] || (s.startsWith('0x') && s.length === 42 ? s : null) || (Object.keys(state.walletToSlug).find(wal => (state.walletToSlug[wal] || '').toLowerCase() === s));
    if (refWallet && refWallet !== bidder && !state.customerReferrers[bidder]) {
      state.customerReferrers[bidder] = refWallet;
    }
  }

  const now = Date.now();
  const existingActiveSpot = (state.queue || []).find(q => q.advertiser && q.advertiser.toLowerCase() === bidder && q.status === 'active' && (!q.expiresAt || q.expiresAt > now));
  if (existingActiveSpot) {
    return {
      ok: false,
      error: 'You already have an active spot in the rotator queue. Only 1 active spot or bid is permitted per wallet.'
    };
  }

  const existingBid = (state.bids || []).find(b => b.bidder && b.bidder.toLowerCase() === bidder && b.status === 'active');
  if (existingBid) {
    return {
      ok: false,
      error: 'You already have an active bid in the Master Network auction. Please cancel your current bid first if you wish to adjust your bid amount.'
    };
  }
  const title = safeArgs.title || 'Master Network Placement (All Offers)';
  const tokenSymbol = 'USDC';
  const isPromoActive = state.config && state.config.betaTesterEnabled !== false;
  const promoPrice = (state.config && state.config.betaTesterPriceUsd !== undefined) ? Number(state.config.betaTesterPriceUsd) : 1;
  const minBid = isPromoActive ? promoPrice : 35;

  if (bidAmountToken < minBid) {
    return { ok: false, error: `Minimum bid for Master Network auction is ${minBid} ${tokenSymbol}${isPromoActive ? ' ($1 Promotion Active)' : ''}` };
  }

  const targetCycleId = cycle.isCutoffPassed ? (new Date(Date.now() + 86400000)).toISOString().split('T')[0] : cycle.cycleId;

  const newBid = {
    id: 'bid_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
    cycleId: targetCycleId,
    bidder,
    agentId: incomingAgentId || (state.customerAgentReferrers && state.customerAgentReferrers[bidder]) || null,
    placementType,
    offerId,
    title,
    destinationUrl,
    tokenSymbol,
    bidAmountToken,
    status: 'active',
    placedAt: Date.now()
  };

  state.bids = state.bids || [];
  state.bids.unshift(newBid);

  if (bidder) {
    state.savedLinks[bidder] = destinationUrl;
    state.savedOfferLinks[bidder] = state.savedOfferLinks[bidder] || {};
    state.savedOfferLinks[bidder][offerId] = destinationUrl;
    await syncPromoterSnapshot(bidder);
  }
  await appKV.set('rotator_state', state);

  return { ok: true, bid: newBid, cycle, message: `Bid of ${bidAmountToken} ${tokenSymbol} placed in Master Network auction for cycle ${targetCycleId}` };
}

if (action === 'cancelBid') {
  const bidder = (callerWallet || '').toLowerCase();
  const bidId = safeArgs.bidId;

  if (!bidder) return { ok: false, error: 'Sign in or specify bidder address' };

  state.bids = state.bids || [];
  let targetBid = null;
  if (bidId) {
    targetBid = state.bids.find(b => b.id === bidId && (b.bidder === bidder || isAdmin) && b.status === 'active');
  } else {
    targetBid = state.bids.find(b => b.bidder === bidder && b.status === 'active');
  }

  if (!targetBid) {
    return { ok: false, error: 'No active bid found to cancel' };
  }

  targetBid.status = 'cancelled';
  targetBid.cancelledAt = Date.now();
  await appKV.set('rotator_state', state);

  return {
    ok: true,
    cancelledBidId: targetBid.id,
    message: 'Bid successfully cancelled. Your spot in the auction has been released.'
  };
}

if (action === 'updateSpotConfig') {
  if (!isAdmin) return { ok: false, error: 'Unauthorized: Only admin can update spot config' };
  const incoming = safeArgs.config || {};
  state.config = state.config || {};
  if (incoming.masterTrafficPercent !== undefined) state.config.masterTrafficPercent = Number(incoming.masterTrafficPercent);
  if (incoming.masterSpotLimit !== undefined) state.config.masterSpotLimit = Number(incoming.masterSpotLimit);
  if (incoming.minSpots !== undefined) state.config.minSpots = Number(incoming.minSpots);
  if (incoming.maxSpots !== undefined) state.config.maxSpots = Number(incoming.maxSpots);
  if (incoming.clicksPerSpotTarget !== undefined) state.config.clicksPerSpotTarget = Number(incoming.clicksPerSpotTarget);
  if (incoming.baseDailyTrafficSupply !== undefined) state.config.baseDailyTrafficSupply = Number(incoming.baseDailyTrafficSupply);
  if (incoming.dynamicMode !== undefined) state.config.dynamicMode = incoming.dynamicMode;
  if (incoming.manualSpotOverride !== undefined) state.config.manualSpotOverride = Number(incoming.manualSpotOverride);

  await appKV.set('rotator_state', state);

  let snapshot = await appKV.get('daily_offers');
  if (snapshot) {
    snapshot.masterTrafficPercent = state.config.masterTrafficPercent !== undefined ? state.config.masterTrafficPercent : 70;
    await appKV.set('daily_offers', snapshot);
  }

  return { ok: true, config: state.config, message: 'Spot & capacity configuration saved successfully' };
}

if (action === 'updateTelegramConfig') {
  if (!isAdmin) return { ok: false, error: 'Unauthorized: Only admin can update Telegram settings' };
  state.config = state.config || {};
  if (safeArgs.telegramChannelUrl !== undefined) {
    state.config.telegramChannelUrl = String(safeArgs.telegramChannelUrl).trim();
  }
  if (safeArgs.telegramBotHandle !== undefined) {
    state.config.telegramBotHandle = String(safeArgs.telegramBotHandle).trim();
  }
  await appKV.set('rotator_state', state);

  let snapshot = await appKV.get('daily_offers');
  if (snapshot) {
    snapshot.telegramChannelUrl = state.config.telegramChannelUrl;
    snapshot.telegramBotHandle = state.config.telegramBotHandle;
    await appKV.set('daily_offers', snapshot);
  }

  return { 
    ok: true, 
    message: 'Telegram Group/Channel and Bot settings saved successfully!', 
    config: state.config 
  };
}

if (action === 'generateFreshMeme') {
  if (!isAdmin) return { ok: false, error: 'Unauthorized: Only admin can generate fresh memes' };
  let apiKey;
  try {
    apiKey = await secrets.get('PLUNDER_AND_RIFFLE_API_KEY');
  } catch (secErr) {
    log('secrets.get failed in generateFreshMeme:', secErr.message);
  }
  if (!apiKey) return { ok: false, error: 'Plunder & Riffle API key secret not configured on app' };

  const brief = (safeArgs.brief || 'The Bankr Meme Engine 24h free promotional traffic on Base').trim();
  const requestedFormat = (safeArgs.format || 'meme').toLowerCase();

  // Map requested format to Plunder & Riffle API endpoint and format
  let pAndRFormat = 'image';
  if (requestedFormat === 'carousel' || requestedFormat === 'slideshow') pAndRFormat = 'carousel';
  else if (requestedFormat === 'hottake' || requestedFormat === 'hot-take') pAndRFormat = 'hottake';
  else if (requestedFormat === 'imessage' || requestedFormat === 'hybrid') pAndRFormat = 'hybrid';

  let res;
  try {
    if (pAndRFormat === 'image') {
      res = await http.fetch('https://bot.plunderandriffle.com/api/agent/xaiver/memes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': String(apiKey).trim()
        },
        body: JSON.stringify({
          brief: brief,
          kind: 'image',
          brand: 'bankrmemebot'
        })
      });
    } else {
      res = await http.fetch('https://bot.plunderandriffle.com/api/agent/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': String(apiKey).trim()
        },
        body: JSON.stringify({
          topic: brief,
          format: pAndRFormat === 'hybrid' ? 'imessage-ad' : (pAndRFormat === 'carousel' ? 'slideshow' : 'hot-take'),
          brand: 'bankrmemebot'
        })
      });
      if (res && (res.pageUrl || res.url)) {
        const pUrl = res.pageUrl || res.url;
        const cleanUrl = pUrl.split('?')[0].replace(/\/+$/, '') + '/';
        res = {
          success: true,
          meme: {
            url: pUrl,
            imageUrl: cleanUrl + 'meme.png',
            title: res.title || brief.slice(0, 40)
          },
          creditsRemaining: res.creditsRemaining
        };
      }
    }
  } catch (fetchErr) {
    log('http.fetch to P&R failed:', fetchErr.message, fetchErr.stack);
    return { ok: false, error: 'P&R API fetch error: ' + fetchErr.message };
  }
  if (res && res.success && res.meme) {
    return {
      ok: true,
      meme: res.meme,
      creditsRemaining: res.creditsRemaining,
      message: 'Fresh custom meme generated via Plunder & Riffle!'
    };
  } else {
    return { ok: false, error: (res && res.error) || 'Failed to generate meme via Plunder & Riffle API' };
  }
}

if (action === 'broadcastTelegramDrop') {
  if (!isAdmin) return { ok: false, error: 'Unauthorized: Only admin can broadcast Telegram drops' };
  // SECURITY: the bot token used to be hard-coded here (and could be overridden from args).
  // It now comes only from the TELEGRAM_BOT_TOKEN secret. Rotate the old token in @BotFather.
  let botToken = '';
  try { botToken = String((await secrets.get('TELEGRAM_BOT_TOKEN')) || '').trim(); } catch (e) {}
  if (!botToken) return { ok: false, error: 'TELEGRAM_BOT_TOKEN secret not configured on app' };
  const chatId = safeArgs.chatId || '-1004337306631';
  const text = safeArgs.text || safeArgs.dropText;
  let photoUrl = safeArgs.photoUrl;
  let pageUrl = safeArgs.pageUrl;

  if (!text) return { ok: false, error: 'Drop message text is required' };

  let chosenItem = null;
  const formatKey = (safeArgs.format || 'meme').toLowerCase();

  const autoGenerate = safeArgs.autoGenerate !== false && (!photoUrl || !pageUrl || safeArgs.forceFresh);
  if (autoGenerate) {
    let apiKey = null;
    try {
      apiKey = await secrets.get('PLUNDER_AND_RIFFLE_API_KEY');
    } catch (e) {
      log('secrets.get failed:', e.message);
    }

    const brief = (safeArgs.brief || safeArgs.title || text.slice(0, 150)).trim();
    let pAndRFormat = 'image';
    if (formatKey === 'carousel' || formatKey === 'slideshow') pAndRFormat = 'carousel';
    else if (formatKey === 'hottake' || formatKey === 'hot-take') pAndRFormat = 'hottake';
    else if (formatKey === 'imessage' || formatKey === 'hybrid') pAndRFormat = 'hybrid';

    if (apiKey) {
      try {
        let genRes;
        if (pAndRFormat === 'image') {
          genRes = await http.fetch('https://bot.plunderandriffle.com/api/agent/xaiver/memes', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': String(apiKey).trim()
            },
            body: JSON.stringify({
              brief: brief,
              kind: 'image',
              brand: 'bankrmemebot'
            })
          });
        } else {
          genRes = await http.fetch('https://bot.plunderandriffle.com/api/agent/generate', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': String(apiKey).trim()
            },
            body: JSON.stringify({
              topic: brief,
              format: pAndRFormat === 'hybrid' ? 'imessage-ad' : (pAndRFormat === 'carousel' ? 'slideshow' : 'hot-take'),
              brand: 'bankrmemebot'
            })
          });
          if (genRes && (genRes.pageUrl || genRes.url)) {
            const pUrl = genRes.pageUrl || genRes.url;
            const cleanUrl = pUrl.split('?')[0].replace(/\/+$/, '') + '/';
            genRes = {
              success: true,
              meme: {
                url: pUrl,
                imageUrl: cleanUrl + 'meme.png',
                title: genRes.title || brief.slice(0, 40)
              }
            };
          }
        }

        if (genRes && genRes.success && genRes.meme) {
          photoUrl = genRes.meme.imageUrl || genRes.meme.url;
          pageUrl = genRes.meme.url || genRes.meme.imageUrl;
          chosenItem = { title: genRes.meme.title, format: pAndRFormat, fresh: true };
        } else {
          log('P&R API returned unsuccessful:', JSON.stringify(genRes));
        }
      } catch (genErr) {
        log('Auto-generation http.fetch error:', genErr.message);
      }
    } else {
      log('No API key available for auto-generation');
    }
  }

  if (!photoUrl || !photoUrl.startsWith('http')) {
    log('Photo URL missing or invalid, falling back to text broadcast:', photoUrl);
  }
  if (!pageUrl || !pageUrl.startsWith('http')) {
    pageUrl = photoUrl;
  }

  try {
    const replyMarkup = (pageUrl && String(pageUrl).startsWith('http')) ? {
      inline_keyboard: [
        [
          { text: "🎬 Open Interactive Page to Screen Record", url: pageUrl }
        ]
      ]
    } : undefined;

    let tgRes;
    const isImageFile = photoUrl && (photoUrl.endsWith('.png') || photoUrl.endsWith('.jpg') || photoUrl.endsWith('.jpeg') || photoUrl.endsWith('.webp'));
    const hasPhoto = Boolean(isImageFile && !photoUrl.includes('placeholder'));

    if (hasPhoto) {
      try {
        tgRes = await http.fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            photo: photoUrl,
            caption: text,
            reply_markup: replyMarkup
          })
        });
      } catch (photoErr) {
        log('Telegram sendPhoto error, will fallback to sendMessage:', photoErr.message);
      }
    }

    // Fallback to sendMessage if photo was not available, or if sendPhoto failed
    if (!tgRes || !tgRes.ok) {
      const fallbackText = pageUrl && !text.includes(pageUrl) ? `${text}\n\n🎬 ${pageUrl}` : text;
      tgRes = await http.fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: fallbackText,
          disable_web_page_preview: false,
          reply_markup: replyMarkup
        })
      });
    }

    if (tgRes && tgRes.ok) {
      return { 
        ok: true, 
        message: 'Drop broadcasted successfully to Telegram!', 
        result: tgRes.result,
        dynamicCreative: chosenItem ? { id: chosenItem.id, title: chosenItem.title, photoUrl, pageUrl } : null
      };
    } else {
      return { ok: false, error: (tgRes && tgRes.description) || 'Failed to send to Telegram' };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

if (action === 'addOffer') {
  if (!isAdmin) return { ok: false, error: 'Unauthorized: Only admin can add offers' };
  const incoming = safeArgs.offer || {};
  const title = (incoming.title || '').trim();
  if (!title) return { ok: false, error: 'Offer title is required' };

  const id = 'offer_' + (title.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 20)) + '_' + Date.now().toString(36);
  const defaultUrl = (incoming.defaultUrl || incoming.destinationUrl || 'https://bankr.bot').trim();
  const newOffer = {
    id,
    title,
    category: incoming.category || 'General',
    description: incoming.description || '',
    destinationUrl: defaultUrl,
    defaultUrl: defaultUrl,
    affiliateUrl: incoming.affiliateUrl || '',
    commissionTerms: incoming.commissionTerms || 'Commission terms available upon registration',
    tokenSymbol: (incoming.tokenSymbol || 'USDC').toUpperCase().trim(),
    tokenAmount: Number(incoming.tokenAmount) || 10,
    minBidToken: Number(incoming.minBidToken) || 10,
    tokenAddress: incoming.tokenAddress || '',
    status: 'active',
    createdAt: Date.now()
  };

  state.offers = state.offers || [];
  state.offers.push(newOffer);
  await appKV.set('rotator_state', state);

  let snapshot = await appKV.get('daily_offers');
  if (snapshot) {
    snapshot.offers = snapshot.offers || [];
    snapshot.offers.push({
      id: newOffer.id,
      offerId: newOffer.id,
      placementType: 'individual',
      title: newOffer.title,
      category: newOffer.category,
      description: newOffer.description,
      destinationUrl: newOffer.destinationUrl,
      tokenSymbol: newOffer.tokenSymbol,
      status: 'active',
      expiresAt: Date.now() + 86400000
    });
    await appKV.set('daily_offers', snapshot);
  }

  return { ok: true, offer: newOffer, message: `Offer "${title}" added to catalog successfully!` };
}

if (action === 'updateOffer') {
  if (!isAdmin) return { ok: false, error: 'Unauthorized: Only admin can update offers' };
  const offerId = safeArgs.offerId;
  const existing = (state.offers || []).find(o => o.id === offerId);
  if (!existing) return { ok: false, error: 'Offer not found' };

  const incoming = safeArgs.offer || {};
  if (incoming.title !== undefined) existing.title = String(incoming.title).trim();
  if (incoming.category !== undefined) existing.category = String(incoming.category).trim();
  if (incoming.description !== undefined) existing.description = String(incoming.description).trim();
  if (incoming.destinationUrl !== undefined) existing.destinationUrl = String(incoming.destinationUrl).trim();
  if (incoming.affiliateUrl !== undefined) existing.affiliateUrl = String(incoming.affiliateUrl).trim();
  if (incoming.commissionTerms !== undefined) existing.commissionTerms = String(incoming.commissionTerms).trim();
  if (incoming.status !== undefined) existing.status = incoming.status;
  if (incoming.tokenSymbol !== undefined) existing.tokenSymbol = String(incoming.tokenSymbol).toUpperCase().trim();

  await appKV.set('rotator_state', state);

  let snapshot = await appKV.get('daily_offers');
  if (snapshot && snapshot.offers) {
    const snapOff = snapshot.offers.find(o => o.id === offerId || o.offerId === offerId);
    if (snapOff) {
      if (incoming.title !== undefined) snapOff.title = existing.title;
      if (incoming.category !== undefined) snapOff.category = existing.category;
      if (incoming.description !== undefined) snapOff.description = existing.description;
      if (incoming.destinationUrl !== undefined) snapOff.destinationUrl = existing.destinationUrl;
      if (incoming.status !== undefined) snapOff.status = existing.status;
      if (incoming.tokenSymbol !== undefined) snapOff.tokenSymbol = existing.tokenSymbol;
    }
    await appKV.set('daily_offers', snapshot);
  }

  return { ok: true, offer: existing, message: `Offer "${existing.title}" updated successfully` };
}

if (action === 'manualActivatePlacement') {
  if (!isAdmin) return { ok: false, error: 'Unauthorized: Only admin can manually activate placements' };

  const offerId = safeArgs.offerId || 'custom';
  const title = (safeArgs.title || 'Featured Network Placement').trim();
  const destinationUrl = (safeArgs.destinationUrl || '').trim();
  const durationHours = Number(safeArgs.durationHours) || 24;
  const advertiser = (safeArgs.advertiser || callerWallet || ownerWallet).toLowerCase();
  const tokenSymbol = (safeArgs.tokenSymbol || 'ADMIN').toUpperCase();
  const tokenAmount = Number(safeArgs.tokenAmount) || 0;

  if (!destinationUrl || !destinationUrl.startsWith('http')) {
    return { ok: false, error: 'Valid HTTP/HTTPS destination URL needed' };
  }

  const now = Date.now();
  const placement = {
    id: 'man_' + Date.now(),
    offerId,
    title,
    description: safeArgs.description || 'Admin Manual Placement',
    destinationUrl,
    advertiser,
    tokenSymbol,
    tokenAmount,
    type: 'admin_manual',
    status: 'active',
    activatedAt: now,
    expiresAt: now + (durationHours * 3600000),
    clicksDelivered: 0
  };

  state.queue = state.queue || [];
  state.queue.unshift(placement);
  await appKV.set('rotator_state', state);

  return { ok: true, placement, message: `Admin manual placement activated for ${durationHours}h` };
}

if (action === 'removeOffer') {
  if (!isAdmin) return { ok: false, error: 'Unauthorized: Only admin can remove offers' };
  const offerId = safeArgs.offerId;
  state.offers = (state.offers || []).filter(o => o.id !== offerId);
  state.queue = (state.queue || []).filter(q => q.offerId !== offerId);
  await appKV.set('rotator_state', state);

  let snapshot = await appKV.get('daily_offers');
  if (snapshot) {
    if (snapshot.offers) {
      snapshot.offers = snapshot.offers.filter(o => (o.id !== offerId && o.offerId !== offerId));
    }
    if (snapshot.masterOffers) {
      snapshot.masterOffers = snapshot.masterOffers.filter(o => (o.id !== offerId && o.offerId !== offerId));
    }
    snapshot.activeCount = (snapshot.masterOffers || []).length + (snapshot.offers || []).length;
    await appKV.set('daily_offers', snapshot);
  }
  return { ok: true, message: 'Offer removed successfully' };
}

if (action === 'removeQueueItem') {
  if (!isAdmin) return { ok: false, error: 'Unauthorized: Only admin can manage queue spots' };
  const itemId = safeArgs.itemId;
  if (!itemId) return { ok: false, error: 'Item ID needed' };

  state.queue = (state.queue || []).filter(q => q.id !== itemId);
  await appKV.set('rotator_state', state);

  let snapshot = await appKV.get('daily_offers');
  if (snapshot) {
    if (snapshot.offers) {
      snapshot.offers = snapshot.offers.filter(o => o.id !== itemId);
    }
    if (snapshot.masterOffers) {
      snapshot.masterOffers = snapshot.masterOffers.filter(o => o.id !== itemId);
    }
    snapshot.activeCount = (snapshot.masterOffers || []).length + (snapshot.offers || []).length;
    await appKV.set('daily_offers', snapshot);
  }
  return { ok: true, message: 'Spot removed from active queue' };
}

if (action === 'extendQueueItem') {
  if (!isAdmin) return { ok: false, error: 'Unauthorized: Only admin can extend spots' };
  const itemId = safeArgs.itemId;
  const hours = Number(safeArgs.hours) || 24;
  const item = (state.queue || []).find(q => q.id === itemId);
  if (!item) return { ok: false, error: 'Spot not found in queue' };

  const currentExp = item.expiresAt && item.expiresAt > Date.now() ? item.expiresAt : Date.now();
  item.expiresAt = currentExp + (hours * 3600000);
  await appKV.set('rotator_state', state);

  return { ok: true, message: `Spot extended by ${hours} hours` };
}

return { ok: false, error: 'Unknown action' };