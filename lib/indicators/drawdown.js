const RESET_THRESHOLD_PCT = 2;

function windowExtreme(navs, days, type) {
  const n = Math.min(days, navs.length);
  const slice = navs.slice(-n);
  let best = slice[0];
  for (const p of slice) {
    if (type === 'high' ? p.value > best.value : p.value < best.value) best = p;
  }
  return best;
}

function pickTier(pct, tiers) {
  let picked = 0;
  for (const t of tiers) if (pct >= t) picked = t;
  return picked;
}

function computeDrawdowns(navs, windows) {
  if (navs.length === 0) return [];
  const today = navs[navs.length - 1];
  const out = [];
  for (const w of windows) {
    if (navs.length < 2) continue;
    const high = windowExtreme(navs, w.days, 'high');
    const dd = ((high.value - today.value) / high.value) * 100;
    out.push({ label: w.label, days: w.days, dd, high });
  }
  return out;
}

function computeRebound(navs, days) {
  if (navs.length < 2) return null;
  const today = navs[navs.length - 1];
  const low = windowExtreme(navs, days, 'low');
  const rb = ((today.value - low.value) / low.value) * 100;
  return { rb, low };
}

function detectDrawdownAlert(currentTier, currentDdPct, lastTier) {
  if (currentDdPct < RESET_THRESHOLD_PCT) {
    return { fire: false, newTier: 0, reset: true };
  }
  if (currentTier > lastTier) {
    return { fire: true, newTier: currentTier, reset: false };
  }
  return { fire: false, newTier: lastTier, reset: false };
}

function detectReboundAlert(currentPct, threshold, lastTier) {
  if (currentPct < RESET_THRESHOLD_PCT) {
    return { fire: false, newTier: 0, reset: true };
  }
  if (currentPct >= threshold && lastTier === 0) {
    return { fire: true, newTier: threshold, reset: false };
  }
  return { fire: false, newTier: lastTier, reset: false };
}

// Period return: today's NAV vs the NAV `days` trading bars ago. Returns
// positive % if price rose over the window, negative if fell. When a window
// is longer than available data, compares to the first available bar.
function computePeriodReturns(navs, windows) {
  if (navs.length < 2) return [];
  const today = navs[navs.length - 1];
  return windows.map((w) => {
    const offset = Math.min(w.days, navs.length - 1);
    const from = navs[navs.length - 1 - offset];
    const ret = ((today.value - from.value) / from.value) * 100;
    return { label: w.label, days: w.days, bars: offset, ret, from };
  });
}

module.exports = {
  windowExtreme,
  pickTier,
  computeDrawdowns,
  computeRebound,
  computePeriodReturns,
  detectDrawdownAlert,
  detectReboundAlert,
  RESET_THRESHOLD_PCT,
};
