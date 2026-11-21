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
    what: 'A 0 to 100 summary of price behaviour: trend (40%), MACD momentum (25%), RSI (20%) and 52-week position (15%). It is a readout of its own, never blended with the Fundamental score.',
    why: 'It summarises how the price has been behaving, independently of how good the business is. Its track record shows it did not predict the next month on this watchlist over 2022–2026.',
    healthy: '65 or more: trend and momentum have been supportive.',
    risky: 'Below 45: the price action has been weak. A description, not a sell signal.',
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
    what: 'A 0 to 100 summary of business quality and valuation. The ingredients depend on the kind of company: corporates, financial companies and REITs are each scored on the measures that actually apply to them. ETFs, indices and crypto have no accounts of their own, so they have no fundamental score.',
    why: 'It answers "is this a good business at a reasonable price?" independently of recent price moves.',
    healthy: '65 or more.',
    risky: 'Below 45. The thresholds are absolute and lean towards value, so fast-growing companies can score low on valuation.',
    profileNotes: {
      CORPORATE: 'Corporate profile: EV/EBITDA 25%, operating margin 20%, FCF yield 20%, Debt/Equity 15%, ROE 10%, forward P/E 10%.',
      FINANCIAL: 'Financial profile (banks, insurers, asset managers): ROE 35%, Price-to-Book 30%, net margin 20%, trailing P/E 15%.',
      REIT: 'REIT profile: Price-to-Book 35%, dividend yield 30%, gearing 25%, operating margin 10%.',
      CRYPTO: 'Crypto assets have no earnings, balance sheet or cash flow, so there is no fundamental score.',
      ETF: 'An ETF is a basket of companies with no accounts of its own, so there is no fundamental score. Its trend regime and Technical score come from price behaviour alone.',
      INDEX: 'An index is a calculated level, not a business, so there is no fundamental score. Its trend regime and Technical score come from price behaviour alone, and it cannot be bought directly.',
    },
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
    what: 'The number of shares or coins such that hitting the stop loses about your risk budget, reduced for correlation with the other compared assets, rounded down to a tradable lot, and capped as a share of the account and at 5% of the 20-day volume.',
    why: 'It is risk control, not a view on direction: it tells you how much a position can be, not whether to open one. It does not depend on the trend regime.',
    healthy: 'A size where the loss at the stop is within your risk budget.',
    risky: 'Zero means not even one lot fits your limits (for example an expensive SGX board lot in a small account).',
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

  /* ---------------- Time-range window (follows the time slicer) ---------------- */
  periodReturn: {
    term: 'Period return',
    what: 'How much the price changed from the first to the last day of the selected time range.',
    why: 'It is the plainest answer to "how has this done lately?". Changing the range shows how much that answer depends on where you start counting.',
    healthy: 'Positive over several ranges, not only the shortest.',
    risky: 'Negative over the longer ranges: the weakness is not just a recent dip.',
  },
  periodVolatility: {
    term: 'Volatility (selected range)',
    what: 'How widely daily returns scattered over the selected time range, scaled to one year so that ranges can be compared.',
    why: 'Risk is not constant. Comparing 1 month with 1 year shows whether the asset has recently become calmer or rougher.',
    healthy: 'Below about 25% a year for a stock.',
    risky: 'Above about 50%, or much higher over the short range than the long one. Short ranges give a rough estimate.',
  },
  periodRange: {
    term: 'Position in period range',
    what: 'Where the latest close sits between the lowest and highest close of the selected time range: 0% is the low, 100% is the high.',
    why: 'It shows at a glance whether the price is near the top or the bottom of its recent range. It changes with the time range you pick; the trend regime never does.',
    healthy: 'In the upper half of the range.',
    risky: 'In the bottom quarter, close to the lows of the window.',
  },
  ewmaVolatility: {
    term: 'EWMA volatility',
    what: 'How much the price is swinging now, with recent days counting more: each day the newest move gets 6% of the weight and the rest fades (RiskMetrics, λ = 0.94).',
    why: 'An equal-weighted average remembers a calm month as much as yesterday. EWMA reacts within days when markets turn, which is what a stop-loss and a simulation should be sized for.',
    healthy: 'Below 25% a year, and not far above the equal-weighted figure.',
    risky: 'Above 50% a year, or well above its own equal-weighted average: volatility is rising.',
  },
  var95: {
    term: '1-day VaR 95%',
    what: 'Value at risk: the loss that the worst 5% of days in the selected range exceeded. Read directly from the actual returns, with no bell-curve assumption.',
    why: 'It puts a number on a bad but ordinary day: about one trading day a month is worse than this.',
    healthy: 'Below about 2% a day.',
    risky: 'Above about 4% a day. And remember the 5% of days beyond it can be much worse: see CVaR.',
  },
  cvar95: {
    term: '1-day CVaR 95%',
    what: 'Expected shortfall: the average loss on the worst 5% of days, the ones beyond VaR.',
    why: 'VaR says where bad days start; CVaR says how bad they are on average. Two assets with the same VaR can have very different CVaR if one has a fatter tail.',
    healthy: 'Not much above VaR: losses beyond the threshold stay contained.',
    risky: 'Far above VaR: when it goes wrong, it goes very wrong.',
  },
  var99: {
    term: '1-day VaR 99%',
    what: 'The loss that the worst 1% of days exceeded: two or three days a year.',
    why: 'It describes a rare, sharp day. It needs at least 250 returns, because the tail is so thin; choose 1Y or 5Y.',
    healthy: 'Below about 3% a day.',
    risky: 'Above about 6% a day.',
  },
  cvar99: {
    term: '1-day CVaR 99%',
    what: 'The average loss on the worst 1% of days.',
    why: 'The closest single number to "a really bad day" for this asset. It rests on very few days, so it is fragile.',
    healthy: 'Below about 4% a day.',
    risky: 'Above about 8% a day.',
  },
  var95x10: {
    term: '10-day VaR 95%',
    what: 'The loss that the worst 5% of 10-day stretches exceeded, measured on overlapping 10-day returns.',
    why: 'Losses build over days. Ten trading days is the conventional holding period that bank risk rules use.',
    healthy: 'Below about 6%.',
    risky: 'Above about 12%. Overlapping windows share days, so this is less certain than it looks.',
  },
  cvar95x10: {
    term: '10-day CVaR 95%',
    what: 'The average loss over the worst 5% of 10-day stretches.',
    why: 'How bad a bad fortnight has been, on average.',
    healthy: 'Below about 8%.',
    risky: 'Above about 15%.',
  },
  positionVar95: {
    term: 'Position VaR 95% (1 day)',
    what: 'The suggested position value times its 1-day 95% VaR: the money a bad but ordinary day would cost.',
    why: 'It sets the daily swing you should expect against the total you planned to risk at the stop.',
    healthy: 'Small next to the amount at risk: several bad days are needed to reach the stop.',
    risky: 'Close to the amount at risk: one ordinary bad day could take the position to its stop.',
  },
  positionCvar95: {
    term: 'Position CVaR 95% (1 day)',
    what: 'The suggested position value times its 1-day 95% CVaR: the average cost of the worst 5% of days.',
    why: 'If this approaches the amount at risk, a single bad day can use up the whole risk budget.',
    healthy: 'Well below the amount at risk.',
    risky: 'Near or above the amount at risk.',
  },
  averageVolume: {
    term: 'Average volume',
    what: 'How many shares (or coins) changed hands on an average day over the last 20 sessions.',
    why: 'It sets how large a position can be before buying or selling it moves the price. The sizer caps a position at 5% of it.',
    healthy: 'Trades every day.',
    risky: 'Three or more days without a single trade in the last 20: thinly traded.',
  },
  dollarVolume: {
    term: 'Average traded value',
    what: 'The value that changed hands on an average day over the last 20 sessions: close × volume.',
    why: 'Unlike share volume, it compares across prices and markets: it is how much money the market absorbs each day.',
    healthy: 'US$10 million a day or more.',
    risky: 'Below US$1 million a day.',
  },
  amihud: {
    term: 'Amihud illiquidity',
    what: 'The average daily price move per US$1 million traded, in basis points (Amihud, 2002).',
    why: 'It measures price impact: how easily trading pushes the price around. Useful for comparing assets, rough as a level.',
    healthy: 'Below 0.1 bp per US$1M: a deep market.',
    risky: 'Above 1 bp per US$1M: prices move easily.',
  },
  spreadEstimate: {
    term: 'Bid-ask spread (minimum)',
    what: 'One tick of the exchange\'s price grid divided by the price: the narrowest spread possible. SGX ticks are S$0.001 below S$0.20, S$0.005 below S$1 and S$0.01 above; US ticks are US$0.01.',
    why: 'Every round trip pays the spread. For a S$2 REIT one tick is about 0.5%, which matters more than any fee; for a US$400 stock it is negligible.',
    healthy: 'Up to 0.10%.',
    risky: 'Above 0.50%: the price grid alone costs half a percent a round trip.',
  },
  rangeSpread: {
    term: 'Range-based spread (Corwin–Schultz)',
    what: 'A spread estimated from daily highs and lows alone (Corwin and Schultz, 2012).',
    why: 'Shown for reference: in volatile markets it reads volatility as spread and overstates liquid stocks\' spreads many times over, so it is never used for a cost.',
    healthy: 'Close to the one-tick minimum.',
    risky: 'Many times the one-tick minimum: the estimator is picking up volatility, not the spread.',
  },
  volumeShare: {
    term: 'Share of daily volume',
    what: 'The suggested position as a share of the 20-day average volume.',
    why: 'Above about 1% an order can move the price; the sizer never suggests more than 5%.',
    healthy: 'Up to 1%: unnoticeable.',
    risky: '1% to 5%: may move the price. At 5% the size is capped.',
  },
  spreadCost: {
    term: 'Spread cost',
    what: 'What buying at the ask and later selling at the bid costs at least: position value × one tick ÷ price.',
    why: 'A cost paid on every trade, win or lose. Next to the amount at risk it shows whether the price grid eats into the trade.',
    healthy: 'Up to 10% of the amount at risk.',
    risky: 'Above 10% of the amount at risk.',
  },
  beta: {
    term: 'Beta',
    what: 'How much the asset typically moves when its benchmark moves 1%: ^GSPC for US- and London-listed assets, ^STI for Singapore, Bitcoin for other coins.',
    why: 'Beta is the part of the risk that comes with the market. A beta of 2 doubles every market move, up and down; holding more assets does not remove it.',
    healthy: 'Near 1, or below it for a defensive holding. What suits you depends on how much market risk you want.',
    risky: 'Above 1.3: market moves are amplified. Above 2, strongly so.',
  },
  rSquared: {
    term: 'R² (share explained by the benchmark)',
    what: 'The share of the asset\'s ups and downs that its benchmark explains: the squared correlation.',
    why: 'It says how much to trust the beta. With a low R², the asset mostly follows its own news and beta is a weak guide.',
    healthy: 'There is no good or bad value: high means the asset is mostly market, low means mostly its own story.',
    risky: 'A very low R² with a high beta: the beta is unreliable.',
  },
  idioVolatility: {
    term: 'Idiosyncratic volatility',
    what: 'The volatility the benchmark does not explain: what is left after removing the beta-driven part of each move.',
    why: 'This is the company-specific risk that holding many unrelated assets averages away. Market risk (beta) cannot be diversified away.',
    healthy: 'Below 20% a year.',
    risky: 'Above 40% a year: company news dominates the price.',
  },
  relativeStrength1m: {
    term: 'Relative strength (1 month)',
    what: 'How the asset did against its benchmark over the last 30 days: (1 + its return) ÷ (1 + the benchmark\'s) − 1.',
    why: 'It separates the asset\'s own performance from the market\'s: a stock that fell 5% while the market fell 10% held up well.',
    healthy: 'A description, not a signal. Over 2022–2026 momentum did not predict the next month on this watchlist, and it is not part of any score.',
    risky: 'Stock closes include dividends but indices do not, which flatters high-yield stocks slightly.',
  },
  relativeStrength3m: {
    term: 'Relative strength (3 months)',
    what: 'How the asset did against its benchmark over the last 91 days: (1 + its return) ÷ (1 + the benchmark\'s) − 1.',
    why: 'A longer view of whether the asset is leading or lagging its market.',
    healthy: 'A description, not a signal. Over 2022–2026 momentum did not predict the next month on this watchlist, and it is not part of any score.',
    risky: 'Over three months the dividend flattery is about a quarter of a stock\'s yearly yield, about 1.5% for a 6% REIT.',
  },
  portfolioBeta: {
    term: 'Portfolio beta',
    what: 'The portfolio\'s typical move when the S&P 500 moves 1%: the weighted sum of each holding\'s beta, in your portfolio currency. Times 100% of capital, it is the beta-adjusted exposure.',
    why: 'It turns a mix of holdings into one number of market exposure: a beta of 1.5 behaves like 150% of the money in the index.',
    healthy: 'Whatever you intend. Below 1 is less market risk than the index; around 1 is about the same.',
    risky: 'Above 1.2: market moves are amplified. Above 2, strongly so.',
  },
  concentration: {
    term: 'Concentration',
    what: 'The share of the portfolio\'s variance explained by its largest common driver (the first principal component), and which holdings move with it.',
    why: 'Several holdings can be one bet in disguise. When one driver explains most of the variance and two or more holdings move tightly with it, they rise and fall together.',
    healthy: 'Below 60%: no single driver dominates.',
    risky: '60% or more with two or more holdings correlated 0.8+ with the driver: one crowded bet.',
  },
  effectiveBets: {
    term: 'Effective number of bets',
    what: 'How many independent bets the portfolio behaves like, from how its variance spreads across its common drivers.',
    why: 'Eight holdings that move together are closer to one bet than to eight. This counts what the risk actually depends on.',
    healthy: '2 or more.',
    risky: 'Below 1.3: effectively one bet.',
  },
  trendRegime: {
    term: 'Trend regime',
    what: 'Where the price stands against its own averages: Uptrend, Extended (RSI above 70), Pullback, Recovering or Downtrend, from the 200-day average, the 20- and 50-day EMAs and RSI.',
    why: 'It says what kind of market the asset is in, in plain words. It is a description, not a forecast: over 2022–2026 no trend or momentum signal predicted the next month on this watchlist.',
    healthy: 'Uptrend: above the 200-day average with the shorter averages rising.',
    risky: 'Downtrend: below the 200-day average with the shorter averages falling. Not a sell signal: see the regime track record for what followed.',
  },
  regimeRecord: {
    term: 'Regime track record',
    what: 'What followed past days with the same trend regime on this asset: the average return over the next 21 sessions, for every regime, overall and within normal, elevated and stressed VIX periods.',
    why: 'It shows how much, or how little, a trend label has told you about the next month here, so a label is never mistaken for a prediction.',
    healthy: 'There is no good or bad value: it is a record of the past, published so it can be checked.',
    risky: 'Small samples: stressed VIX periods are a few short episodes, and overlapping 21-day windows share days.',
  },
  nextMacroEvent: {
    term: 'Next FOMC / CPI',
    what: 'Days to the next Federal Reserve rate decision or US inflation (CPI) release, from a calendar kept by hand from the Fed and BLS schedules, with what else is due in the next 7 and 30 days.',
    why: 'Scheduled announcements move every asset at once, often with a gap at the open that no stop can catch. Knowing they are coming is the cheapest risk control there is.',
    healthy: 'More than 48 hours away, outside the plan for any trade you are about to open.',
    risky: 'Within 48 hours. Context only: it changes no score, trend regime or position size.',
  },
  marketRegime: {
    term: 'Market regime',
    what: 'A three-way reading of the US options market from the VIX curve: normal, elevated, or stressed when the curve is inverted (VIX at or above VIX3M).',
    why: 'Risk figures here are measured from past days and react with a lag. The VIX curve shows what protection costs today, so it can flag a stressed market before the history catches up.',
    healthy: 'Normal: VIX below 20 and the curve sloping up.',
    risky: 'Stressed: the curve is inverted, so the next month is priced as riskier than the next three. Context only; it changes no score or position size.',
  },
  vixLevel: {
    term: 'VIX',
    what: 'The 30-day implied volatility of the S&P 500, priced from options, in annualised percentage points. VIX ÷ √252 is the daily move options are pricing.',
    why: 'It is the market\'s own price for uncertainty: when it rises, protection is expensive and large moves are expected.',
    healthy: 'Below 20 (its five-year median is about 18).',
    risky: '30 and above, seen on about one session in twenty over five years.',
  },
  vixTermRatio: {
    term: 'VIX term structure',
    what: 'VIX divided by VIX3M, the 3-month equivalent. Below 1 the curve slopes up (contango); at or above 1 it is inverted.',
    why: 'An inverted curve means traders pay more for protection now than later, which is how stress shows up in option prices.',
    healthy: 'Below 0.95: the usual upward slope.',
    risky: 'At or above 1.00: inverted. Rare (about 6% of sessions over five years) and usually brief.',
  },
  vixFrontRatio: {
    term: 'Front of the VIX curve',
    what: 'VIX9D divided by VIX: the next nine days against the next month.',
    why: 'Above 1, the stress is concentrated in the coming days, often around an event or a sharp sell-off.',
    healthy: 'Below 1.00.',
    risky: 'Above 1.00. Shown for context; the regime itself is decided by VIX and VIX3M.',
  },
  nextEarnings: {
    term: 'Next earnings',
    what: 'Days until the next earnings release, with its timing against the trading session, and whether it falls inside the sizing, simulation and projection horizons.',
    why: 'Earnings are the most common reason for a price to open far from the last close. A stop-loss is an order, not a guarantee: a gap can jump straight over it.',
    healthy: 'Beyond the 21-day sizing horizon, or a stock whose earnings rarely move it (see the typical move).',
    risky: 'Within 21 trading days, for a stock with large earnings-day moves.',
  },
  earningsMove: {
    term: 'Typical earnings-day move',
    what: 'The median absolute price reaction to this company\'s own past earnings releases over five years, with the worst one and a comparison with an ordinary day.',
    why: 'It sizes the surprise risk: a stock that moves 8% on earnings needs a very different plan from one that moves 1%.',
    healthy: 'Under about three ordinary days\' worth of movement.',
    risky: 'Three times an ordinary day or more, or a worst fall larger than your stop distance.',
  },
  nextExDividend: {
    term: 'Next ex-dividend date',
    what: 'The next date the shares trade without the coming dividend, from Yahoo when it lists one, otherwise estimated from the usual gap between payments, and the price drop it implies.',
    why: 'On the ex-date the price opens lower by about the dividend. That is not a loss to a holder, but it can trigger a tight stop.',
    healthy: 'A small drop relative to the stop distance.',
    risky: 'A large dividend (common for REITs and banks) close to a tight stop.',
  },
  gapRisk: {
    term: 'Loss in an earnings gap',
    what: 'What the suggested position would lose if the price gapped down by the worst earnings-day fall on record, compared with the amount you planned to risk at the stop.',
    why: 'Position size is set so that hitting the stop costs a fixed amount. A gap through the stop breaks that promise; this shows by how much.',
    healthy: 'Within the planned amount at risk.',
    risky: 'Several times the planned amount, especially with earnings inside the next 21 trading days.',
  },
  crashReplay: {
    term: 'Crash replay',
    what: 'Your allocation bought at the close on an S&P 500 high and held, at the same weights with no rebalancing, to the low that followed: the 2022 rate-hike bear market, the August 2024 yen carry unwind, the 2025 tariff shock and the autumn 2026 sell-off (to the latest close). Prices are in your display currency at each day\'s exchange rate, set against the S&P 500 replayed the same way.',
    why: 'Volatility and VaR summarise ordinary days. A replay shows what this exact mix would have done in a real, fast fall: how deep it went, its worst day, and whether it held up better or worse than the market.',
    healthy: 'A smaller loss than the S&P 500 over the same window.',
    risky: 'A loss much deeper than the market\'s. The windows were chosen after the fact, and a holding with no prices at the start is left out and the rest scaled up, as each card says.',
  },
  scoreBacktest: {
    term: 'Technical score track record',
    what: 'How the Technical score would have done over the stored years: each past day is rescored from the year behind it and compared with the next 21 trading days. The headline is the rank IC, the correlation between the score and what followed, with the highest and lowest third of days by score.',
    why: 'A score is only worth acting on if it has worked before. This is the same discipline the forecast row applies to the projection, and the reason QuantLens shows a trend regime rather than BUY, HOLD or SELL.',
    healthy: 'A rank IC of 0.05 or more that is unlikely to be luck (t of 2 or more), with high-score days beating the asset\'s average day.',
    risky: 'A negative IC, or high-score days that did no better than any other day: the score then describes the trend without predicting anything.',
  },
  maxDrawdown: {
    term: 'Maximum drawdown',
    what: 'The largest fall from a high to a later low within the selected time range.',
    why: 'It is the loss a holder actually sat through at the worst moment, which is what tests whether you would have held on. A 50% fall needs a 100% gain to recover.',
    healthy: 'Shallower than about −10%.',
    risky: 'Deeper than about −25%. It uses daily closes, so intraday falls were larger.',
  },

  /* ---------------- News and forecast (context, never part of a score) ---------------- */
  headlineTone: {
    term: 'Headline tone',
    what: 'The average wording of the three most recent unique news stories, from −1 (very negative) to +1 (very positive). Syndicated copies of the same story are counted once.',
    why: 'It tells you whether the latest coverage reads as good or bad news, so you know to go and read it. It is context, not a signal.',
    healthy: '+0.05 or more: the recent headlines use positive language.',
    risky: '−0.05 or less: negative language. A general word list scores it, so financial phrases are often misread and many headlines score zero.',
  },
  forecast30d: {
    term: '30-day projection',
    what: 'Where the price would be in 30 calendar days if its recent trend and weekly pattern simply continued, with a band the model expects most outcomes to fall in.',
    why: 'It makes the current trend concrete. It is an extrapolation, not a prediction: the model sees only past prices and knows nothing about news, earnings or rates.',
    healthy: 'A projection whose track record beats "the price will not move" is at least adding a little information.',
    risky: 'A projection that did no better than assuming no change should be ignored. Always read it next to its track record.',
  },
  forecastBacktest: {
    term: 'Projection track record',
    what: 'How wrong the same model was over the last 30 days: it is refitted with those days hidden, and its projection is compared with what actually happened.',
    why: 'A forecast without a measured error is just a line. This shows the size of the model\'s recent miss next to the miss from simply assuming no change.',
    healthy: 'An error below the "no change" error.',
    risky: 'An error at or above the "no change" error: the model added nothing. One 30-day test is a small sample either way.',
  },

  /* ---------------- Portfolio ---------------- */
  portfolioReturn: {
    term: 'Historical return (annualised)',
    what: 'The average daily return of the portfolio at your weights over the selected period, scaled up to one year.',
    why: 'It shows what this mix would have earned. It is a description of the past, not an expectation: one year of returns is a very noisy guide to the next.',
    healthy: 'Comfortably above the risk-free rate.',
    risky: 'Below the risk-free rate: government bonds would have paid more with far less risk.',
  },
  portfolioVolatility: {
    term: 'Portfolio volatility',
    what: 'How widely the portfolio\'s yearly return would typically swing, calculated from each asset\'s own volatility and from how the assets move together.',
    why: 'It is the portfolio\'s risk in one number. When assets do not move in step it is lower than the weighted average of their individual volatilities; that gap is diversification.',
    healthy: 'Below about 15% a year.',
    risky: 'Above about 30% a year: large swings in both directions are normal.',
  },
  sharpeRatio: {
    term: 'Sharpe ratio',
    what: 'The portfolio\'s return above the risk-free rate, divided by its volatility: how much extra return was earned for each unit of risk.',
    why: 'It lets you compare portfolios with different amounts of risk on one scale. A higher return is only better if it was not bought with proportionally more risk.',
    healthy: '1.0 or more is strong; 0.5 to 1.0 is acceptable.',
    risky: 'Below 0: the portfolio returned less than government bonds. Built on one year of history, the ratio can change sharply from month to month.',
  },
  diversificationRatio: {
    term: 'Diversification ratio',
    what: 'The weighted average of the assets\' individual volatilities divided by the portfolio\'s volatility.',
    why: 'It measures how much risk combining these assets removed. At exactly 1 the assets move as one and combining them achieved nothing.',
    healthy: '1.2 or more: the mix removes a meaningful share of risk.',
    risky: 'Close to 1: effectively a single bet, however many names it holds.',
  },
  riskFreeRate: {
    term: 'Risk-free rate',
    what: 'The yield on a 10-year government bond in the portfolio\'s currency: US Treasuries for USD, Singapore Government Securities for SGD.',
    why: 'It is the return available for taking almost no risk, so it is the bar a risky portfolio has to clear. The Sharpe ratio measures return above it.',
    healthy: 'A fresh value from today\'s data.',
    risky: 'A value marked "proxy" is another country\'s yield standing in because the real one could not be fetched; the Sharpe ratio is then approximate.',
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
/** Pair ids ("corr:AMD|MU") and crash-replay ids ("replay:bear2022") share one explainer each. */
function explainerKey(id) {
  if (typeof id !== 'string') return id;
  if (id.startsWith('corr:')) return 'correlation';
  if (id.startsWith('replay:')) return 'crashReplay';
  return id;
}

export function getExplainer(id, profile) {
  const key = explainerKey(id);
  const entry = ENTRIES[key];
  if (!entry) return { id: String(id), ...FALLBACK };
  const note = entry.profileNotes && profile && entry.profileNotes[profile] ? entry.profileNotes[profile] : null;
  return { id: key, term: entry.term, what: entry.what, why: entry.why, healthy: entry.healthy, risky: entry.risky, note };
}

export function hasExplainer(id) {
  const key = explainerKey(id);
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
