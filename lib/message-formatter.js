function fmtDisplayDate(iso) {
  if (!iso) return '';
  return iso.replace(/-/g, '/');
}

function formatSign(n) {
  return n >= 0 ? `+${n.toFixed(1)}%` : `${n.toFixed(1)}%`;
}

function formatEntry(f) {
  const lines = ['━━━━━━━━━━', `${f.displayName}（${f.fundId}）`];
  lines.push(`NAV: ${f.today.value} (${fmtDisplayDate(f.today.date)})`);

  if (f.drawdowns.length > 0) {
    lines.push('⚠️ 跌幅');
    for (const d of f.drawdowns) {
      const tag = d.isNew ? '← NEW' : '';
      lines.push(
        (`• ${d.label}: -${d.dd.toFixed(1)}% [觸發 ${d.tier}%]（高點 ${fmtDisplayDate(d.high.date)}）` + tag).trimEnd()
      );
    }
    for (const d of f.drawdownsUntriggered) {
      lines.push(
        `• ${d.label}: -${d.dd.toFixed(1)}%（高點 ${fmtDisplayDate(d.high.date)}，未觸發）`
      );
    }
  }

  if (f.rebound) {
    const tag = f.rebound.isNew ? '← NEW' : '';
    lines.push('📈 反彈');
    lines.push(
      (`• 20D: +${f.rebound.rb.toFixed(1)}% [觸發 ${f.rebound.threshold}%]（低點 ${fmtDisplayDate(
        f.rebound.low.date
      )}）` + tag).trimEnd()
    );
  }

  const t = f.td9;
  if (t.resetEvent) {
    const label = t.resetEvent.side === 'buy' ? 'Buy' : 'Sell';
    const emoji = t.resetEvent.side === 'buy' ? '📉' : '📈';
    lines.push(`${emoji} TD9: ${label} Setup 在第 ${t.resetEvent.prev} 天被反轉重置`);
  }
  if (t.completeSide) {
    const label = t.completeSide === 'buy' ? 'Buy' : 'Sell';
    const emoji = t.completeSide === 'buy' ? '📈' : '📉';
    const suffix = t.isNewComplete ? ' ← NEW' : '（延續中）';
    lines.push(`${emoji} TD9: ${label} Setup 9 完成於 ${fmtDisplayDate(t.completeDate)}${suffix}`);
  } else if (t.progressSide) {
    const label = t.progressSide === 'buy' ? 'Buy' : 'Sell';
    const emoji = t.progressSide === 'buy' ? '📈' : '📉';
    lines.push(`${emoji} TD9: ${label} Setup ${t.progressCount}/9 進行中`);
  }

  if (f.daily) {
    lines.push(`💬 單日: ${formatSign(f.daily.pct)}`);
  }

  return lines.join('\n');
}

function formatMessage(entries, meta) {
  const header = `📊 ${fmtDisplayDate(meta.latestDate)} 警訊摘要（${meta.monitoredCount} 檔監控中，${entries.length} 檔觸發）`;
  if (entries.length === 0) {
    return header;
  }
  return [header, '', ...entries.map(formatEntry)].join('\n\n');
}

function formatStatus(summaries, meta) {
  const header = `📊 ${fmtDisplayDate(meta.latestDate)} 狀態`;
  const blocks = summaries.map((s) => {
    const ddLine = s.drawdowns
      .map((d) => {
        // d.dd is drawdown (positive when below high). Flip sign so the
        // displayed number shows actual price movement direction:
        //   below high → negative (e.g. "-7.2%")
        //   above high → positive (e.g. "+3.0%")
        const move = -d.dd;
        return `${d.label}: ${move >= 0 ? '+' : ''}${move.toFixed(1)}%`;
      })
      .join(' | ');
    const td9Line =
      s.td9.buy >= 6
        ? `TD9: Buy Setup ${s.td9.buy}/9`
        : s.td9.sell >= 6
        ? `TD9: Sell Setup ${s.td9.sell}/9`
        : 'TD9: 無';
    return [`${s.displayName}（${s.fundId}）`, `  ${ddLine}`, `  ${td9Line}`].join('\n');
  });
  return [header, '', ...blocks].join('\n\n');
}

module.exports = { formatMessage, formatStatus, formatEntry, fmtDisplayDate };
