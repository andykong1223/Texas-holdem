/**
 * 回归：首手开局不得被「中途重开」守卫误拦
 * node scripts/start-hand-guard-selftest.js
 */

function wouldBlockStartHand({ status, bettingRound, handSettled, dealt }) {
  return status === 'playing'
    && ['preflop', 'flop', 'turn', 'river'].includes(bettingRound)
    && !handSettled
    && dealt;
}

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failed++;
  } else {
    console.log('OK:', msg);
  }
}

// 新房间：startGame 曾把 status 先设为 playing，bettingRound 默认仍是 preflop，且尚未发牌
assert(
  !wouldBlockStartHand({ status: 'playing', bettingRound: 'preflop', handSettled: false, dealt: false }),
  '首手（未发牌）不得拦截'
);

assert(
  wouldBlockStartHand({ status: 'playing', bettingRound: 'preflop', handSettled: false, dealt: true }),
  '已发牌的翻前不得重开'
);

assert(
  !wouldBlockStartHand({ status: 'waiting', bettingRound: 'preflop', handSettled: false, dealt: false }),
  'waiting 状态可开局'
);

assert(
  !wouldBlockStartHand({ status: 'playing', bettingRound: 'showdown', handSettled: true, dealt: true }),
  '摊牌后可开下一手'
);

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nStart-hand guard selftests passed');
