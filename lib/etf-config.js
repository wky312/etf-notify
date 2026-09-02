// ETF code → fhtrust page ID mapping
const ETF_MAP = {
  '00991A': { id: 'ETF23', name: '主動復華未來50' },
  '00986D': { id: 'ETF25', name: '主動復華金融債息' },
  '00998A': { id: 'ETF24', name: '主動復華全球金融股息' },
  '00409A': { id: 'ETF26', name: '主動復華全球未來50' },
};

const BASE_UNITS = 500000; // 每基數 = 50萬受益權單位

module.exports = { ETF_MAP, BASE_UNITS };
