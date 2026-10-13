/** 德州 HUD：从手牌行动序列计算 VPIP / PFR / C-bet 等 */

function rate(num, den) {
  if (!den) return null;
  return Math.round((num / den) * 1000) / 1000;
}

function pctLabel(r) {
  if (r == null) return '—';
  return `${Math.round(r * 100)}%`;
}

function isRaiseLike(a) {
  if (!a) return false;
  if (a.action === 'raise' || a.action === 'bet') return true;
  if (a.action === 'allin') return (a.raiseBy || 0) > 0;
  return false;
}

function isVoluntaryPreflop(a) {
  if (!a || a.street !== 'preflop') return false;
  if (a.action === 'sb' || a.action === 'bb' || a.action === 'fold' || a.action === 'check') return false;
  return a.action === 'call' || a.action === 'raise' || a.action === 'bet' || a.action === 'allin';
}

function flopWasDealt(hand) {
  const community = hand.communityCards || [];
  if (community.length >= 3) return true;
  return (hand.actions || []).some(a => a.street === 'flop');
}

/**
 * @param {Array} hands
 */
function computeHudFromHands(hands) {
  let dealt = 0;
  let vpip = 0;
  let pfr = 0;
  let threeBetOpp = 0;
  let threeBet = 0;
  let cbetOpp = 0;
  let cbet = 0;
  let foldToCbetOpp = 0;
  let foldToCbet = 0;
  let sawFlop = 0;
  let wtsd = 0;
  let wsd = 0;
  let aggBets = 0;
  let aggCalls = 0;
  let wonHands = 0;
  let profitSum = 0;

  for (const hand of hands || []) {
    const uid = hand.userId;
    if (!uid) continue;
    const actions = hand.actions || [];
    if (!actions.length) continue;

    const mine = actions.filter(a => a.userId === uid);
    dealt += 1;
    profitSum += hand.profit || 0;
    if (hand.won) wonHands += 1;

    const preflop = actions.filter(a => a.street === 'preflop');
    const myPre = mine.filter(a => a.street === 'preflop');
    const foldedPre = myPre.some(a => a.action === 'fold');

    if (myPre.some(isVoluntaryPreflop)) vpip += 1;
    if (myPre.some(isRaiseLike)) pfr += 1;

    // 3-bet：面对开池加注后再加注
    let openRaiser = null;
    let raises = 0;
    let did3bet = false;
    for (const a of preflop) {
      if (!isRaiseLike(a)) continue;
      raises += 1;
      if (raises === 1) openRaiser = a.userId;
      else if (a.userId === uid && openRaiser && openRaiser !== uid) did3bet = true;
    }
    if (openRaiser && openRaiser !== uid) {
      threeBetOpp += 1;
      if (did3bet) threeBet += 1;
    }

    let lastPfrUser = null;
    for (const a of preflop) {
      if (isRaiseLike(a)) lastPfrUser = a.userId;
    }

    const flopDealt = flopWasDealt(hand);
    const postflopMine = mine.filter(a => a.street === 'flop' || a.street === 'turn' || a.street === 'river');

    if (flopDealt && !foldedPre) {
      sawFlop += 1;
      if (!hand.folded) {
        wtsd += 1;
        if (hand.won || (hand.profit || 0) > 0) wsd += 1;
      }
    }

    // C-bet：翻前最后加注者在翻牌圈率先下注
    if (lastPfrUser === uid && flopDealt && !foldedPre) {
      cbetOpp += 1;
      const flopActs = actions.filter(a => a.street === 'flop');
      const firstAgg = flopActs.find(isRaiseLike);
      if (firstAgg && firstAgg.userId === uid) cbet += 1;
    }

    // Fold to C-bet
    if (lastPfrUser && lastPfrUser !== uid && flopDealt && !foldedPre) {
      const flopActs = actions.filter(a => a.street === 'flop');
      const cbetIdx = flopActs.findIndex(a => a.userId === lastPfrUser && isRaiseLike(a));
      if (cbetIdx >= 0) {
        const after = flopActs.slice(cbetIdx + 1).filter(a => a.userId === uid);
        if (after.length) {
          foldToCbetOpp += 1;
          if (after.some(a => a.action === 'fold')) foldToCbet += 1;
        }
      }
    }

    for (const a of postflopMine) {
      if (a.action === 'bet' || a.action === 'raise') aggBets += 1;
      else if (a.action === 'allin' && (a.raiseBy || 0) > 0) aggBets += 1;
      else if (a.action === 'call') aggCalls += 1;
    }
  }

  const af = aggCalls > 0
    ? Math.round((aggBets / aggCalls) * 100) / 100
    : (aggBets > 0 ? aggBets : null);

  const vpipR = rate(vpip, dealt);
  const pfrR = rate(pfr, dealt);
  const threeR = rate(threeBet, threeBetOpp);
  const cbetR = rate(cbet, cbetOpp);
  const f2cR = rate(foldToCbet, foldToCbetOpp);
  const wtsdR = rate(wtsd, sawFlop);
  const wsdR = rate(wsd, wtsd);

  return {
    hands: dealt,
    vpip: vpipR,
    pfr: pfrR,
    threeBet: threeR,
    threeBetOpp,
    cbet: cbetR,
    cbetOpp,
    foldToCbet: f2cR,
    foldToCbetOpp,
    wtsd: wtsdR,
    wsd: wsdR,
    sawFlop,
    af,
    aggBets,
    aggCalls,
    wonHands,
    profit: profitSum,
    labels: {
      vpip: pctLabel(vpipR),
      pfr: pctLabel(pfrR),
      threeBet: pctLabel(threeR),
      cbet: pctLabel(cbetR),
      foldToCbet: pctLabel(f2cR),
      wtsd: pctLabel(wtsdR),
      wsd: pctLabel(wsdR),
      af: af == null ? '—' : String(af)
    }
  };
}

module.exports = {
  computeHudFromHands,
  pctLabel,
  isVoluntaryPreflop,
  isRaiseLike
};
