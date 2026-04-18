function computeTd9(navs) {
  let buy = 0;
  let sell = 0;
  let buyCompleteDate = null;
  let sellCompleteDate = null;
  const events = [];
  for (let i = 4; i < navs.length; i++) {
    const today = navs[i].value;
    const prev = navs[i - 4].value;
    if (today < prev) {
      if (sell >= 6) events.push({ date: navs[i].date, type: 'sell_reset', prev: sell });
      sell = 0;
      sellCompleteDate = null;
      if (buy < 9) {
        buy += 1;
        if (buy === 9) {
          buyCompleteDate = navs[i].date;
          events.push({ date: navs[i].date, type: 'buy_complete' });
        }
      }
    } else if (today > prev) {
      if (buy >= 6) events.push({ date: navs[i].date, type: 'buy_reset', prev: buy });
      buy = 0;
      buyCompleteDate = null;
      if (sell < 9) {
        sell += 1;
        if (sell === 9) {
          sellCompleteDate = navs[i].date;
          events.push({ date: navs[i].date, type: 'sell_complete' });
        }
      }
    }
    // equal → no change
  }
  return { buy, sell, buyCompleteDate, sellCompleteDate, events };
}

module.exports = { computeTd9 };
