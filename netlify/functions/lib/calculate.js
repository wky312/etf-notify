/**
 * Calculate subscription/redemption amounts and format a message.
 * @param {Object} trades - e.g. { '00991A': -28, '00986D': -17 }
 * @param {Object} navData - from fetchAllNavMultipliers()
 * @returns {string} formatted message
 */
function formatMessage(trades, navData) {
  const today = new Date().toLocaleDateString('zh-TW', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    timeZone: 'Asia/Taipei',
  });

  const lines = [today];

  for (const [code, c] of Object.entries(trades)) {
    const nav = navData[code];
    if (!nav) {
      lines.push(`${code}: 無資料`);
      continue;
    }
    const amount = c * nav.navMultiplier;
    const action = c > 0 ? '申購' : '贖回';
    const absC = Math.abs(c);
    const absAmount = Math.abs(amount);
    const formatted = formatAmount(absAmount);
    lines.push(`${code} ${action} ${absC}基數 ≈ ${formatted}`);
  }

  return lines.join('\n');
}

function formatAmount(amount) {
  if (amount >= 1e8) {
    return (amount / 1e8).toFixed(2) + '億';
  } else if (amount >= 1e4) {
    return (amount / 1e4).toFixed(0) + '萬';
  }
  return amount.toLocaleString() + '元';
}

module.exports = { formatMessage };
