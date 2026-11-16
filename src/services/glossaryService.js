/**
 * glossaryService.js: the beginner explainers shown in Guided mode.
 *
 * Every metric id used by the engines has an entry with four parts:
 *   what    what the number measures, in one or two plain sentences
 *   why     why an investor should care
 *   healthy what a reassuring reading looks like
 *   risky   what a worrying reading looks like
 * plus optional `profileNotes` that replace or extend the text for a scoring
 * profile (for example, why Debt/Equity is ignored for banks).
 *
 * Thresholds quoted here mirror the scoring anchors in the engines. They are
 * rules of thumb for learning, not guarantees.
 */

const ENTRIES = {
  /* ---------------- Price and trend ---------------- */
  price: {
    term: 'Last price',
    what: 'The most recent price. For crypto it updates live from Binance; for stocks it is the last completed daily close.',
    why: 'Every valuation ratio and position size starts from the price you would actually pay.',
    healthy: 'A price above its long-term average (SMA 200) means the market has been rewarding holders.',
    risky: 'A price far below its averages means sellers are in control, even if the company looks cheap.',
  },
  sma50: {
    term: 'SMA (50)',
    what: 'Simple Moving Average: the plain average of the last 50 daily closing prices.',
    why: 'It smooths out daily noise so you can see the medium-term direction.',
    healthy: 'Price above the SMA 50 and the SMA 50 rising.',
    risky: 'Price below a falling SMA 50.',
  },
  sma200: {
    term: 'SMA (200)',
    what: 'The average of the last 200 daily closes, roughly ten months of trading.',
    why: 'It is the most widely watched line between a long-term uptrend and a downtrend.',
    healthy: 'Price above the SMA 200: the long-term trend is up.',
    risky: 'Price below the SMA 200: the long-term trend is down, and rallies often fail.',
  },
  ema12: {
    term: 'EMA (12)',
    what: 'Exponential Moving Average over 12 days. Unlike a simple average it gives recent prices more weight, so it reacts faster.',
    why: 'It is the fast line inside the MACD indicator.',
    healthy: 'Above the EMA 26: short-term momentum is stronger than medium-term.',
    risky: 'Below the EMA 26: momentum is fading.',
  },
  ema20: {
    term: 'EMA (20)',
    what: 'Exponential Moving Average over about one month of trading days.',
    why: 'It tracks the short-term trend and is compared with the EMA 50 to spot trend changes.',
    healthy: 'EMA 20 above EMA 50: the short-term trend is leading the medium-term trend upward.',
    risky: 'EMA 20 below EMA 50: the short-term trend has rolled over.',
  },
  ema26: {
    term: 'EMA (26)',
    what: 'Exponential Moving Average over 26 days.',
    why: 'It is the slow line inside the MACD indicator.',
    healthy: 'Below the EMA 12 (fast line on top).',
    risky: 'Above the EMA 12 (fast line underneath).',
  },
  ema50: {
    term: 'EMA (50)',
    what: 'Exponential Moving Average over about ten weeks of trading days.',
    why: 'It marks the medium-term trend. Many traders treat it as a line that pullbacks should hold.',
    healthy: 'Price above the EMA 50.',
    risky: 'Price below the EMA 50.',
  },
  macd: {
    term: 'MACD',
    what: 'Moving Average Convergence Divergence. The MACD line is EMA 12 minus EMA 26; the signal line is a 9-day EMA of that; the histogram is the gap between them.',
    why: 'It shows whether momentum is building or fading before that is obvious on the price chart.',
    healthy: 'MACD line above the signal line and above zero, with the histogram growing.',
    risky: 'MACD line below the signal line and below zero, with the histogram shrinking.',
  },
  rsi14: {
    term: 'RSI (14)',
    what: 'Relative Strength Index: compares the size of recent up-days with recent down-days on a 0 to 100 scale.',
    why: 'It tells you whether a move is healthy or stretched. Buying when it is already extreme means paying up after the crowd.',
    healthy: '50 to 65: steady upward momentum without being overheated.',
    risky: 'Above 70 is overbought (a pullback is more likely). Below 30 is oversold (momentum is weak, though a bounce can follow).',
  },
  atr14: {
    term: 'ATR (14)',
    what: 'Average True Range: how far the price typically travels in one day, in currency terms, averaged over 14 days.',
    why: 'It is the yardstick for stop-losses. A stop tighter than normal daily movement gets hit by noise.',
    healthy: 'There is no good or bad level. A lower ATR simply allows a larger position for the same risk.',
    risky: 'A sharply rising ATR means the asset has become more violent; position sizes should shrink.',
  },
  atrPct: {
    term: 'ATR %',
    what: 'The ATR divided by the price: typical daily movement as a percentage.',
    why: 'It lets you compare the choppiness of a $2 REIT with a $60,000 Bitcoin on the same scale.',
    healthy: 'Under about 2% is calm for a stock.',
    risky: 'Above about 4% a day is very volatile; crypto often sits here.',
  },
  volatility: {
    term: 'Annualised volatility',
    what: 'How widely daily returns scatter around their average, scaled to one year.',
    why: 'It is the standard measure of risk. Roughly two-thirds of yearly outcomes land within plus or minus this percentage.',
    healthy: 'Below about 25% is typical for large, stable companies.',
    risky: 'Above about 50% means large swings in both directions are normal.',
  },
  range52w: {
    term: '52-week range position',
    what: 'Where the price sits between its lowest and highest point of the past year: 0% is the low, 100% is the high.',
    why: 'It shows at a glance whether you are buying strength or catching a falling price.',
    healthy: 'The upper half of the range: buyers have been in control.',
    risky: 'Near the bottom of the range: the market has been marking it down, usually for a reason.',
  },
  trendScore: {
    term: 'Trend score',
    what: 'Three yes/no checks: is the price above its 200-day average, is the EMA 20 above the EMA 50, and is the price above the EMA 50.',
    why: 'Trading with the trend is the simplest edge a beginner has.',
    healthy: 'All three checks pass (100).',
    risky: 'None pass (0): every time frame points down.',
  },
  macdScore: {
    term: 'MACD score',
    what: 'Three yes/no checks on MACD: line above signal, line above zero, histogram higher than three days ago.',
    why: 'It turns the MACD picture into one number that feeds the Technical score.',
    healthy: 'All three checks pass (100).',
    risky: 'None pass (0).',
  },
  rsiScore: {
    term: 'RSI score',
    what: 'The RSI mapped onto a 0 to 100 score that peaks at RSI 60 and falls away when RSI is extreme in either direction.',
    why: 'It rewards steady momentum and penalises both weak and overheated readings.',
    healthy: 'RSI between 50 and 65.',
    risky: 'RSI above 80 or below 30.',
  },
  rangeScore: {
    term: '52-week position score',
    what: 'The 52-week range position expressed as a 0 to 100 score.',
    why: 'Assets near their highs tend to keep outperforming assets near their lows.',
    healthy: 'Above 50.',
    risky: 'Below 25.',
  },
  technicalScore: {
    term: 'Technical score',
    what: 'A 0 to 100 summary of price behaviour: trend (40%), MACD momentum (25%), RSI (20%) and 52-week position (15%).',
    why: 'It answers "is the market currently agreeing with this idea?" independently of how good the business is.',
    healthy: '65 or more: trend and momentum are supportive.',
    risky: 'Below 45: the price action is working against you.',
  },

  /* ---------------- Reported fundamentals ---------------- */
  marketCap: {
    term: 'Market capitalisation',
    what: 'Share price multiplied by the number of shares: what the stock market says the whole company is worth. For crypto, price multiplied by coins in circulation.',
    why: 'Size matters: larger companies are usually more stable and easier to trade.',
    healthy: 'Not a quality signal on its own.',
    risky: 'Very small companies can be hard to sell quickly without moving the price.',
  },
  enterpriseValue: {
    term: 'Enterprise value (EV)',
    what: 'Market cap plus debt minus cash: the price of buying the whole business including its debts.',
    why: 'It allows fair comparison between companies with very different amounts of debt.',
    healthy: 'Used as an input to EV/EBITDA rather than judged alone.',
    risky: 'An EV far above market cap means debt is a large part of the price tag.',
    profileNotes: { FINANCIAL: 'For banks, deposits and borrowings distort EV, so it is shown for reference only.' },
  },
  ebit: {
    term: 'EBIT',
    what: 'Earnings Before Interest and Taxes: profit from the business before financing costs and tax.',
    why: 'It shows what the operations earn regardless of how the company is funded.',
    healthy: 'Positive and growing.',
    risky: 'Negative: the core business loses money.',
    profileNotes: { FINANCIAL: 'Banks do not report EBIT: interest is their core business, not a financing cost.' },
  },
  ebitda: {
    term: 'EBITDA',
    what: 'Earnings Before Interest, Taxes, Depreciation and Amortisation: a rough proxy for cash profit from operations.',
    why: 'It strips out accounting and financing choices so different companies can be compared.',
    healthy: 'Positive and large relative to debt.',
    risky: 'Negative, or small relative to debt.',
    profileNotes: { FINANCIAL: 'Banks do not report EBITDA: interest income and expense are their core business.' },
  },
  operatingIncome: {
    term: 'Operating income',
    what: 'Revenue minus the costs of running the business, before interest and tax.',
    why: 'It is the profit that management controls most directly.',
    healthy: 'A healthy share of revenue (see Operating margin).',
    risky: 'Negative or shrinking.',
    profileNotes: { FINANCIAL: 'Banks do not report a conventional operating income line.' },
  },
  totalDebt: {
    term: 'Total debt',
    what: 'All interest-bearing borrowings, short and long term.',
    why: 'Debt must be repaid whether or not business is good, so it amplifies both gains and losses.',
    healthy: 'Small relative to equity and to yearly cash flow.',
    risky: 'Large relative to equity, especially when profits are falling.',
    profileNotes: { FINANCIAL: 'Borrowing is a bank\'s raw material, so its debt is not judged like a normal company\'s.' },
  },
  freeCashFlow: {
    term: 'Free cash flow (FCF)',
    what: 'Cash from operations minus capital expenditure: the cash left after keeping the business running and growing.',
    why: 'It pays for dividends, buybacks and debt repayment. Profits can be flattered by accounting; cash is harder to fake.',
    healthy: 'Positive year after year.',
    risky: 'Negative for long periods without a clear investment reason.',
    profileNotes: { FINANCIAL: 'For banks, loan and deposit flows dominate cash flow, so FCF is not a useful measure.' },
  },
  trailingPE: {
    term: 'Trailing P/E',
    what: 'Price divided by the last twelve months of earnings per share: how many dollars you pay for each dollar of current profit.',
    why: 'It is the quickest gauge of how expensive a stock is relative to what it earns today.',
    healthy: 'Lower is cheaper. Below about 15 is modest for a mature company.',
    risky: 'Above about 35 the price assumes years of strong growth. Negative earnings give no P/E at all.',
  },
  forwardPE: {
    term: 'Forward P/E',
    what: 'Price divided by analysts\' forecast earnings for the next twelve months.',
    why: 'It shows the valuation if expected growth arrives. A forward P/E well below the trailing P/E means profits are expected to rise.',
    healthy: 'Below about 20, and below the trailing P/E.',
    risky: 'Above about 35, or above the trailing P/E (profits expected to fall). Forecasts can be wrong.',
  },
  priceToBook: {
    term: 'Price-to-Book (P/B)',
    what: 'Share price divided by book value per share (assets minus liabilities).',
    why: 'It compares the market price with the accounting value of what the company owns.',
    healthy: 'Lower is cheaper, but only if the returns on that book value are good.',
    risky: 'A very high P/B means the price depends on future profits rather than assets already held.',
    profileNotes: {
      FINANCIAL: 'For banks this is the core valuation measure, because their assets are mostly financial and marked close to market value. Around 1.5 or below is modest; above 2.5 is expensive unless ROE is exceptional.',
      REIT: 'For a REIT, book value approximates the appraised value of its properties (NAV). Below 1.0 means buying the property portfolio at a discount.',
      CORPORATE: 'For asset-light companies (software, brands) book value understates what the business is worth, so P/B is shown for reference and not scored.',
    },
  },
  roe: {
    term: 'Return on Equity (ROE)',
    what: 'Net income divided by shareholders\' equity: the profit earned on each dollar the owners have invested.',
    why: 'It measures how efficiently management turns your capital into profit.',
    healthy: 'Above about 15% sustained over time.',
    risky: 'Below about 5%, or negative. Very high ROE can also come from heavy debt or buybacks shrinking equity.',
    profileNotes: { FINANCIAL: 'For banks, 10% is roughly the cost of capital; 16% or more is excellent.' },
  },
  dividendYield: {
    term: 'Dividend yield (TTM)',
    what: 'Dividends paid over the last twelve months divided by the current price.',
    why: 'It is the cash return you receive just for holding, before any price change.',
    healthy: 'A steady yield covered by earnings or cash flow.',
    risky: 'An unusually high yield often means the price has fallen because a dividend cut is expected.',
    profileNotes: { REIT: 'REITs must distribute most of their income, so yield is a core part of the return. 4% to 6% is typical for Singapore REITs.' },
  },

  /* ---------------- Derived fundamentals ---------------- */
  evEbitda: {
    term: 'EV / EBITDA',
    what: 'Enterprise value divided by EBITDA: how many years of current cash profit it would take to pay for the whole business, debt included.',
    why: 'It is a valuation measure that is not distorted by how much debt a company uses, unlike P/E.',
    healthy: 'Below about 10 is inexpensive for a stable business.',
    risky: 'Above about 25 the price relies on strong growth continuing.',
    profileNotes: { FINANCIAL: 'Not meaningful for banks: interest is their core business, so EBITDA is not reported.' },
  },
  operatingMargin: {
    term: 'Operating margin',
    what: 'Operating income divided by revenue: cents of operating profit kept from each dollar of sales.',
    why: 'High margins signal pricing power and leave a cushion when costs rise or sales dip.',
    healthy: 'Above about 20%.',
    risky: 'Below about 5%, or negative.',
    profileNotes: {
      FINANCIAL: 'Not meaningful for banks, which do not report operating income. Net margin is used instead.',
      REIT: 'REITs run high margins because tenants bear many costs; 60% or more is normal.',
    },
  },
  netMargin: {
    term: 'Net margin',
    what: 'Net income divided by revenue: cents of final profit kept from each dollar of sales after all costs, interest and tax.',
    why: 'It is the bottom-line measure of profitability.',
    healthy: 'Above about 15% for most businesses.',
    risky: 'Below about 5%, or negative.',
    profileNotes: { FINANCIAL: 'Banks typically keep 20% to 35% of revenue as profit. Below 10% suggests high costs or bad loans.' },
  },
  fcfYield: {
    term: 'FCF yield',
    what: 'Free cash flow divided by market cap: the cash the business generates as a percentage of what you pay for it.',
    why: 'Think of it as the cash return if you owned the whole company. It is harder to manipulate than earnings.',
    healthy: 'Above about 5%.',
    risky: 'Below about 2%, or negative (the business consumes cash).',
    profileNotes: { FINANCIAL: 'Not meaningful for banks: deposit and loan flows dominate their cash flow.' },
  },
  debtToEquity: {
    term: 'Debt / Equity',
    what: 'Total debt divided by shareholders\' equity: how much the company borrows for each dollar its owners have put in.',
    why: 'More debt means higher fixed interest costs and less room for error in a downturn.',
    healthy: 'Below about 0.5.',
    risky: 'Above about 2. Share buybacks can also shrink equity and inflate this ratio.',
    profileNotes: {
      FINANCIAL: 'Not meaningful for banks: deposits and borrowings are their raw material. Regulators judge banks on capital ratios instead.',
      REIT: 'Shown for reference. REIT leverage is judged by gearing (debt divided by total assets).',
    },
  },
  gearing: {
    term: 'Gearing (aggregate leverage)',
    what: 'Total debt divided by total assets: the share of the property portfolio funded by borrowing.',
    why: 'Singapore REITs are capped at 50% by the regulator (MAS). The closer to the cap, the less room to borrow and the more exposed to falling property values.',
    healthy: 'Below about 35%.',
    risky: 'Above about 45%: close to the regulatory limit.',
    profileNotes: { CORPORATE: 'Shown for reference. Corporate leverage is scored with Debt / Equity.', FINANCIAL: 'Not used for banks.' },
  },
  fundamentalScore: {
    term: 'Fundamental score',
    what: 'A 0 to 100 summary of business quality and valuation. The ingredients depend on the kind of company: corporates, banks and REITs are each scored on the measures that actually apply to them.',
    why: 'It answers "is this a good business at a reasonable price?" independently of recent price moves.',
    healthy: '65 or more.',
    risky: 'Below 45. The thresholds are absolute and lean towards value, so fast-growing companies can score low on valuation.',
    profileNotes: {
      CORPORATE: 'Corporate profile: EV/EBITDA 25%, operating margin 20%, FCF yield 20%, Debt/Equity 15%, ROE 10%, forward P/E 10%.',
      FINANCIAL: 'Bank profile: ROE 35%, Price-to-Book 30%, net margin 20%, trailing P/E 15%.',
      REIT: 'REIT profile: Price-to-Book 35%, dividend yield 30%, gearing 25%, operating margin 10%.',
      CRYPTO: 'Crypto assets have no earnings, balance sheet or cash flow, so there is no fundamental score.',
    },
  },

  /* ---------------- Advisor ---------------- */
  compositeScore: {
    term: 'Composite score',
    what: 'For stocks, the average of the Technical and Fundamental scores. For crypto, the Technical score alone.',
    why: 'Good investments usually need both a sound business and a market that agrees. One number makes three assets comparable.',
    healthy: '65 or more.',
    risky: 'Below 45.',
  },
  verdict: {
    term: 'Verdict',
    what: 'A rule-based label from the composite score: BUY at 65 or more, HOLD from 45, SELL below 45. Safety rules can cap a BUY at HOLD.',
    why: 'It is a consistent starting point for your own research. It is an educational signal, not financial advice.',
    healthy: 'BUY with High confidence: price action and fundamentals agree.',
    risky: 'SELL, or any verdict with Low confidence: the evidence is weak or conflicting.',
  },
  confidence: {
    term: 'Confidence',
    what: 'How much the evidence agrees. High when the Technical and Fundamental scores are within 20 points and data is complete; Low when they disagree or only one is available.',
    why: 'A BUY built on one strong score and one weak score deserves a smaller position than one where both agree.',
    healthy: 'High.',
    risky: 'Low: treat the verdict as a question, not an answer.',
  },

  /* ---------------- Correlation ---------------- */
  correlation: {
    term: 'Correlation',
    what: 'How closely two assets\' daily returns move together, from −1 (opposite) through 0 (unrelated) to +1 (identical).',
    why: 'Three positions that move together are really one big bet. Diversification only works when holdings behave differently.',
    healthy: 'Below 0.6: the assets give you genuinely different exposures.',
    risky: '0.8 or more: they tend to rise and fall together, so losses arrive at the same time.',
  },
  correlationHaircut: {
    term: 'Correlation haircut',
    what: 'A reduction applied to each position when the compared assets move together.',
    why: 'It keeps your total risk the same as if the positions were independent, instead of silently stacking up.',
    healthy: '100%: no reduction needed.',
    risky: 'Around 60%: the assets overlap so much that each position is cut by almost half.',
  },

  /* ---------------- Position sizing ---------------- */
  riskBudget: {
    term: 'Risk budget',
    what: 'Your account size multiplied by the percentage you are willing to lose on one trade.',
    why: 'Deciding the loss first, and the position size second, is what keeps one bad trade from hurting the account.',
    healthy: '1% or less per trade.',
    risky: 'Above 2% per trade: a short losing streak does real damage.',
  },
  stopLoss: {
    term: 'Stop-loss level',
    what: 'The price at which you would exit to limit the loss: the entry price minus a multiple of the ATR.',
    why: 'Placing the stop beyond normal daily movement avoids being shaken out by noise.',
    healthy: 'About 2 ATR below entry for stocks.',
    risky: 'Less than 1 ATR: likely to be hit by ordinary fluctuation.',
  },
  riskPerUnit: {
    term: 'Risk per unit',
    what: 'Entry price minus stop price: what you lose on each share or coin if the stop is hit.',
    why: 'Dividing your risk budget by this number gives the position size.',
    healthy: 'No good or bad level; it sets the scale.',
    risky: 'A very large risk per unit means only a small position fits your budget.',
  },
  positionSize: {
    term: 'Suggested position size',
    what: 'The number of shares or coins such that hitting the stop loses about your risk budget, then reduced for correlation and for a weaker verdict, rounded down to a tradable lot, and capped as a share of the account.',
    why: 'It converts a signal into a concrete, risk-controlled amount.',
    healthy: 'A size where the loss at the stop is within your risk budget.',
    risky: 'Zero means the rules say not to open a new position (for example a SELL verdict).',
  },
  positionValue: {
    term: 'Position value',
    what: 'Units multiplied by the entry price: the cash needed to open the position.',
    why: 'It shows how much of the account one idea would occupy.',
    healthy: 'Well under the maximum position cap.',
    risky: 'At the cap: the position is limited by concentration, not by the stop distance.',
  },
  amountAtRisk: {
    term: 'Amount at risk',
    what: 'Units multiplied by risk per unit: the loss if the price falls to the stop.',
    why: 'This is the number that should feel acceptable before you place the trade.',
    healthy: 'At or below the risk budget.',
    risky: 'Gaps can jump past a stop, so real losses can be larger.',
  },
  target2R: {
    term: '2R target',
    what: 'A reference price twice as far above entry as the stop is below it.',
    why: 'If winners are about twice the size of losers, you can be right less than half the time and still come out ahead.',
    healthy: 'A target that is realistic given recent highs.',
    risky: 'A target far beyond the 52-week high may be wishful.',
  },
  portfolioHeat: {
    term: 'Total risk (portfolio heat)',
    what: 'The sum of the amounts at risk across all compared positions, as a percentage of the account.',
    why: 'It is the loss if every stop is hit together, which is exactly what happens when holdings are correlated.',
    healthy: 'Below about 3%.',
    risky: 'Above about 6%.',
  },

  /* ---------------- Monte Carlo ---------------- */
  monteCarlo: {
    term: 'Monte Carlo simulation',
    what: 'A thousand random price paths generated from the asset\'s own recent volatility.',
    why: 'It turns "volatility" into a picture of the range of outcomes you should be prepared for.',
    healthy: 'A narrow fan: outcomes cluster near today\'s price.',
    risky: 'A wide fan: both large gains and large losses are plausible. The model assumes volatility stays the same, which it does not.',
  },
  probStopFirst: {
    term: 'Chance the stop is hit first',
    what: 'The share of simulated paths that reach the stop-loss before the 2R target.',
    why: 'It shows that a stop being hit is a normal outcome, not a sign that the analysis was wrong.',
    healthy: 'With zero drift and a 2R target, roughly two in three paths that reach a level hit the stop first. That is expected.',
    risky: 'Much higher than that suggests the stop is too tight for this asset\'s volatility.',
  },
};

const FALLBACK = Object.freeze({
  term: 'Metric',
  what: 'No explainer is available for this metric yet.',
  why: 'Open the derivation to see exactly how it is calculated.',
  healthy: '',
  risky: '',
  note: null,
});

/**
 * Get the explainer for a metric.
 * @param {string} id metric id (pair ids such as "corr:AAPL|NVDA" resolve to "correlation")
 * @param {string} [profile] CORPORATE | FINANCIAL | REIT | CRYPTO
 * @returns {{ id:string, term:string, what:string, why:string, healthy:string, risky:string, note:string|null }}
 */
export function getExplainer(id, profile) {
  const key = typeof id === 'string' && id.startsWith('corr:') ? 'correlation' : id;
  const entry = ENTRIES[key];
  if (!entry) return { id: String(id), ...FALLBACK };
  const note = entry.profileNotes && profile && entry.profileNotes[profile] ? entry.profileNotes[profile] : null;
  return { id: key, term: entry.term, what: entry.what, why: entry.why, healthy: entry.healthy, risky: entry.risky, note };
}

export function hasExplainer(id) {
  const key = typeof id === 'string' && id.startsWith('corr:') ? 'correlation' : id;
  return Object.prototype.hasOwnProperty.call(ENTRIES, key);
}

/** All explainers, alphabetically by term, for a glossary view. */
export function listGlossary(profile) {
  return Object.keys(ENTRIES)
    .map((id) => getExplainer(id, profile))
    .sort((a, b) => a.term.localeCompare(b.term));
}

/** Ids of every metric that has an explainer (used by the test page). */
export function glossaryIds() {
  return Object.keys(ENTRIES);
}
