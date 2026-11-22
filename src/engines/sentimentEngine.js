/**
 * sentimentEngine.js: turns the snapshot's news block into a traced metric.
 *
 * The pipeline has already done the heavy work: it fetched the 15 most recent
 * headlines, collapsed syndicated copies (85% similarity within a rolling
 * 24 hours) and scored the three most recent unique stories with VADER.
 * This engine recomputes the average from those scores, labels it, and
 * explains exactly what it does and does not mean.
 *
 *   Headline tone = mean of the stories' VADER compound scores   (−1 .. +1)
 *   positive at +0.05 or more · negative at −0.05 or less · otherwise neutral
 *
 * Headline tone is context. It is not part of any score or the trend regime:
 * VADER is a general-purpose word list that does not know financial vocabulary,
 * and three headlines are a very small sample.
 */

import { isNum, mean } from '../core/precisionMath.js';
import {
  traced, notAvailable, input, step, threshold, interpretation, fmtN,
} from '../core/derivationTracer.js';

export const SENTIMENT_CONFIG = Object.freeze({ positive: 0.05, negative: -0.05, tolerance: 0.001 });

const TONE_BY_LABEL = Object.freeze({ positive: 'healthy', neutral: 'neutral', negative: 'caution' });
const THRESHOLDS = [
  threshold('+0.05 or more', 'Positive wording', 'healthy'),
  threshold('−0.05 to +0.05', 'Neutral wording', 'neutral'),
  threshold('−0.05 or less', 'Negative wording', 'caution'),
];
const FORMULA = 'Headline tone = mean of the VADER compound scores of the most recent unique stories';

/** Label a compound score with VADER's conventional cut-offs. */
export function labelForCompound(compound) {
  if (!isNum(compound)) return null;
  if (compound >= SENTIMENT_CONFIG.positive) return 'positive';
  if (compound <= SENTIMENT_CONFIG.negative) return 'negative';
  return 'neutral';
}

function hoursBetween(earlier, later) {
  const from = Date.parse(earlier);
  const to = later instanceof Date ? later.getTime() : Date.parse(later);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.max(0, (to - from) / 3600000);
}

function ageText(hours) {
  if (!isNum(hours)) return 'at an unknown time';
  if (hours < 1) return 'under an hour ago';
  if (hours < 48) return `${Math.round(hours)} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/**
 * @param {object} asset normalised asset from snapshotService (needs ticker and news)
 * @param {{ now?: Date|string }} [options] reference time for story ages (defaults to the current time)
 * @returns {{ ticker:string, status:string, note:string|null, stories:object[], metrics:{ headlineTone:object } }}
 */
export function analyzeSentiment(asset, { now = new Date() } = {}) {
  const news = asset.news ?? { status: 'unavailable', clusters: [], sentiment: null, note: null };
  const id = 'headlineTone';
  const label = 'Headline tone';
  const stories = news.clusters.map((story) => ({ ...story, ageHours: hoursBetween(story.publishedAt, now) }));
  const base = { id, label, unit: 'ratio', formula: FORMULA };
  const result = (metric) => ({ ticker: asset.ticker, status: news.status, note: news.note ?? null, stories, metrics: { headlineTone: metric } });

  if (news.status === 'unavailable' || stories.length === 0) {
    return result(notAvailable({ ...base, meta: { status: news.status }, reason: news.note || 'No recent headlines are available for this asset.' }));
  }
  const scored = stories.filter((story) => story.scores && isNum(story.scores.compound));
  if (scored.length === 0) {
    return result(notAvailable({ ...base, meta: { status: news.status, stories: stories.length }, reason: 'Headlines are available but were not scored, because the sentiment package was not installed when the data was built.' }));
  }

  const compounds = scored.map((story) => story.scores.compound);
  const value = mean(compounds);
  const verdict = labelForCompound(value);
  const stored = news.sentiment && isNum(news.sentiment.compound) ? news.sentiment.compound : null;
  const agrees = stored === null || Math.abs(stored - value) <= SENTIMENT_CONFIG.tolerance;
  const newestAge = hoursBetween(news.newestAt ?? scored[0].publishedAt, now);
  const stale = news.status === 'stale';
  const duplicates = stories.reduce((total, story) => total + story.duplicates, 0);

  let caveat = 'VADER is a general-purpose word list. It does not know that "beats estimates" is good or that "cuts guidance" is bad, and many financial headlines score exactly zero. Tone is context only and is not part of any score.';
  if (stale) caveat = `These headlines are old (the newest is from ${ageText(newestAge)}), so they say little about today. ${caveat}`;
  if (!agrees) caveat = `The average stored in the snapshot (${fmtN(stored, 4)}) differs from the one recomputed here; the recomputed value is shown. ${caveat}`;

  return result(traced({
    ...base,
    value,
    tone: stale ? 'neutral' : TONE_BY_LABEL[verdict],
    meta: {
      label: verdict, basis: scored.length, status: news.status, stale, newestAgeHours: newestAge,
      headlineCount: news.headlineCount ?? null, clusterCount: news.clusterCount ?? null, duplicates, agreesWithSnapshot: agrees,
    },
    rawInputs: scored.map((story, index) => input(
      `Story ${index + 1}: ${story.title}`,
      story.scores.compound,
      'compound',
      `Yahoo Finance RSS, scored by VADER${story.duplicates ? `, ${story.duplicates} syndicated cop${story.duplicates === 1 ? 'y' : 'ies'} folded in` : ''}`,
      typeof story.publishedAt === 'string' ? story.publishedAt.slice(0, 10) : null,
    )),
    steps: [
      step(`Add the ${scored.length} compound score${scored.length === 1 ? '' : 's'}`, compounds.map((score) => fmtN(score, 4)).join(' + '), compounds.reduce((total, score) => total + score, 0)),
      step(`Divide by ${scored.length}`, `${fmtN(compounds.reduce((total, score) => total + score, 0), 4)} ÷ ${scored.length}`, value),
      step('Label it: positive at +0.05 or more, negative at −0.05 or less', `${fmtN(value, 4)} against ±0.05`, verdict),
    ],
    interpretation: interpretation(
      `The wording of the ${scored.length} most recent unique stor${scored.length === 1 ? 'y' : 'ies'} reads as ${verdict} (${fmtN(value, 2)} on a scale of −1 to +1). The newest is from ${ageText(newestAge)}.`,
      THRESHOLDS,
      caveat,
    ),
  }));
}
