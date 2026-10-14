/**
 * 牌局核心纯函数自检（不启服务）
 * node scripts/poker-core-selftest.js
 */
function rankValue(r) {
  return { '2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9, 'T':10, 'J':11, 'Q':12, 'K':13, 'A':14 }[r];
}

function evaluate5(cards) {
  const ranks = cards.map(c => rankValue(c.r)).sort((a,b) => b-a);
  const suits = cards.map(c => c.s);
  const isFlush = suits.every(s => s === suits[0]);
  let isStraight = true;
  for (let i=0; i<4; i++) {
    if (ranks[i] - 1 !== ranks[i+1]) { isStraight = false; break; }
  }
  let straightValues = ranks;
  if (ranks[0] === 14 && ranks[1] === 5 && ranks[2] === 4 && ranks[3] === 3 && ranks[4] === 2) {
    isStraight = true;
    straightValues = [5, 4, 3, 2, 1];
  }
  const counts = {};
  ranks.forEach(r => counts[r] = (counts[r] || 0) + 1);
  const groups = Object.entries(counts).map(([r,c]) => [parseInt(r), c]).sort((a,b) => b[1] - a[1] || b[0] - a[0]);
  if (isFlush && isStraight) {
    return { rank: 8, values: straightValues, name: straightValues[0] === 14 ? 'Royal Flush' : 'Straight Flush' };
  }
  if (groups[0][1] === 4) return { rank: 7, values: [groups[0][0], groups[1][0]], name: 'Four of a Kind' };
  if (groups[0][1] === 3 && groups[1][1] === 2) return { rank: 6, values: [groups[0][0], groups[1][0]], name: 'Full House' };
  if (isFlush) return { rank: 5, values: ranks, name: 'Flush' };
  if (isStraight) return { rank: 4, values: straightValues, name: 'Straight' };
  if (groups[0][1] === 3) return { rank: 3, values: [groups[0][0], groups[1][0], groups[2][0]], name: 'Three of a Kind' };
  if (groups[0][1] === 2 && groups[1][1] === 2) return { rank: 2, values: [groups[0][0], groups[1][0], groups[2][0]], name: 'Two Pair' };
  if (groups[0][1] === 2) return { rank: 1, values: [groups[0][0], groups[1][0], groups[2][0], groups[3][0]], name: 'One Pair' };
  return { rank: 0, values: ranks, name: 'High Card' };
}

function compareHands(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  for (let i=0; i<a.values.length; i++) {
    if (a.values[i] !== b.values[i]) return a.values[i] - b.values[i];
  }
  return 0;
}

function calculatePots(players) {
  let pots = [];
  let active = players.filter(p => !p.folded && p.totalBet > 0);
  let allContributors = players.filter(p => p.totalBet > 0);
  if (allContributors.length === 0) return [];
  if (active.length === 0) {
    return [{
      amount: allContributors.reduce((s, p) => s + p.totalBet, 0),
      eligible: [],
      refundIds: allContributors.map(p => p.id)
    }];
  }
  let levels = [...new Set(allContributors.map(p => p.totalBet))].sort((a,b) => a-b);
  let prevLevel = 0;
  for (let level of levels) {
    let diff = level - prevLevel;
    let contributors = allContributors.filter(p => p.totalBet >= level);
    let potAmount = diff * contributors.length;
    let eligible = active.filter(p => p.totalBet >= level).map(p => p.id);
    pots.push({ amount: potAmount, eligible });
    prevLevel = level;
  }
  return pots;
}

function c(r, s) { return { r, s }; }
let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failed++;
  } else {
    console.log('OK:', msg);
  }
}

const wheel = evaluate5([c('A','h'), c('2','d'), c('3','c'), c('4','s'), c('5','h')]);
const sixHigh = evaluate5([c('2','h'), c('3','d'), c('4','c'), c('5','s'), c('6','h')]);
assert(wheel.rank === 4 && wheel.values[0] === 5, 'A-5 是 5-high 顺子');
assert(compareHands(sixHigh, wheel) > 0, '6-high 顺子大于轮子顺');

const royal = evaluate5([c('T','h'), c('J','h'), c('Q','h'), c('K','h'), c('A','h')]);
assert(royal.name === 'Royal Flush', '皇家同花顺');

const pots = calculatePots([
  { id: 'a', folded: false, totalBet: 50 },
  { id: 'b', folded: false, totalBet: 100 },
  { id: 'c', folded: true, totalBet: 100 }
]);
assert(pots.length === 2, '边池分层为 2');
assert(pots[0].amount === 150 && pots[0].eligible.includes('a') && pots[0].eligible.includes('b'), '主池 150，A/B 可分');
assert(pots[1].amount === 100 && pots[1].eligible.includes('b') && !pots[1].eligible.includes('a'), '边池 100，仅 B');

const refund = calculatePots([
  { id: 'a', folded: true, totalBet: 100 },
  { id: 'b', folded: true, totalBet: 50 }
]);
assert(refund[0].eligible.length === 0 && refund[0].refundIds.length === 2, '全弃牌退回贡献者');
assert(refund[0].amount === 150, '退回池总额正确');

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll poker core selftests passed');
