const {
  windowExtreme,
  pickTier,
  computeDrawdowns,
  computeRebound,
  detectDrawdownAlert,
  detectReboundAlert,
  RESET_THRESHOLD_PCT,
} = require('./indicators/drawdown');
const { computeTd9 } = require('./indicators/td9');

const WINDOWS = [
  { label: '20D', days: 20 },
  { label: '60D', days: 60 },
  { label: '252D', days: 252 },
];

function evaluateFund(cfg, navs, state) {
  if (!navs || navs.length < 2) {
    return { entry: null, nextState: state };
  }

  const today = navs[navs.length - 1];
  const yesterday = navs[navs.length - 2];
  const dailyPct = ((today.value - yesterday.value) / yesterday.value) * 100;

  const drawdowns = computeDrawdowns(navs, WINDOWS);
  const nextState = JSON.parse(JSON.stringify(state));
  nextState.lastCheckedDate = today.date;

  const ddTriggered = [];
  const ddUntriggered = [];
  for (const d of drawdowns) {
    const currentTier = d.dd > 0 ? pickTier(d.dd, cfg.drawdownTiers) : 0;
    const ws = nextState.drawdown[d.label] || (nextState.drawdown[d.label] = { lastTier: 0, lastAlertDate: null });
    const alert = detectDrawdownAlert(currentTier, d.dd, ws.lastTier);
    if (alert.reset) ws.lastTier = 0;
    if (alert.fire) {
      ws.lastTier = alert.newTier;
      ws.lastAlertDate = today.date;
      ddTriggered.push({ label: d.label, dd: d.dd, tier: alert.newTier, high: d.high, isNew: true });
    } else if (currentTier > 0) {
      ddUntriggered.push({ label: d.label, dd: d.dd, high: d.high });
    }
  }

  let reboundEntry = null;
  const rb = computeRebound(navs, 20);
  if (rb) {
    const rs = nextState.rebound['20D'] || (nextState.rebound['20D'] = { lastTier: 0, lastAlertDate: null });
    const alert = detectReboundAlert(rb.rb, cfg.reboundThreshold, rs.lastTier);
    if (alert.reset) rs.lastTier = 0;
    if (alert.fire) {
      rs.lastTier = alert.newTier;
      rs.lastAlertDate = today.date;
      reboundEntry = {
        rb: rb.rb,
        low: rb.low,
        threshold: cfg.reboundThreshold,
        isNew: true,
      };
    }
  }

  const td9 = computeTd9(navs);
  nextState.td9.buyCompleteDate = td9.buyCompleteDate;
  nextState.td9.sellCompleteDate = td9.sellCompleteDate;

  const td9Entry = {
    completeSide: null,
    completeDate: null,
    isNewComplete: false,
    progressSide: null,
    progressCount: null,
    resetEvent: null,
  };

  const todaysEvents = td9.events.filter((e) => e.date === today.date);
  const todayReset = todaysEvents.find((e) => e.type === 'buy_reset' || e.type === 'sell_reset');
  if (todayReset) {
    td9Entry.resetEvent = {
      side: todayReset.type === 'buy_reset' ? 'buy' : 'sell',
      prev: todayReset.prev,
    };
    nextState.td9.lastNotifiedEventDate = today.date;
  }

  if (td9.buy === 9 && td9.buyCompleteDate) {
    td9Entry.completeSide = 'buy';
    td9Entry.completeDate = td9.buyCompleteDate;
    const alreadyNotified = state.td9.lastNotifiedEventDate === td9.buyCompleteDate;
    td9Entry.isNewComplete = !alreadyNotified;
    if (!alreadyNotified) {
      nextState.td9.lastNotifiedEventDate = td9.buyCompleteDate;
    }
  } else if (td9.sell === 9 && td9.sellCompleteDate) {
    td9Entry.completeSide = 'sell';
    td9Entry.completeDate = td9.sellCompleteDate;
    const alreadyNotified = state.td9.lastNotifiedEventDate === td9.sellCompleteDate;
    td9Entry.isNewComplete = !alreadyNotified;
    if (!alreadyNotified) {
      nextState.td9.lastNotifiedEventDate = td9.sellCompleteDate;
    }
  } else if (td9.buy >= 6) {
    td9Entry.progressSide = 'buy';
    td9Entry.progressCount = td9.buy;
  } else if (td9.sell >= 6) {
    td9Entry.progressSide = 'sell';
    td9Entry.progressCount = td9.sell;
  }

  const daily =
    Math.abs(dailyPct) >= cfg.dailyThreshold
      ? { pct: dailyPct, threshold: cfg.dailyThreshold }
      : null;

  const hasAny =
    ddTriggered.length > 0 ||
    reboundEntry !== null ||
    td9Entry.resetEvent !== null ||
    td9Entry.isNewComplete ||
    td9Entry.progressSide !== null ||
    daily !== null;

  if (!hasAny) {
    return { entry: null, nextState };
  }

  const entry = {
    fundId: cfg.fundId,
    displayName: cfg.displayName,
    today,
    drawdowns: ddTriggered,
    drawdownsUntriggered: ddTriggered.length > 0 ? ddUntriggered : [],
    rebound: reboundEntry,
    td9: td9Entry,
    daily,
  };

  return { entry, nextState };
}

module.exports = { evaluateFund, WINDOWS };
