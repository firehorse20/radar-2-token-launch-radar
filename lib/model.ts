// Token Radar model, radar-2: one sealed snapshot in, one ranked board out.
//
// The whole model is five factors, each a small function below, so the
// dashboard can restate it and a reader can check any row by hand:
//
//   implied = base x growth x maturity x chain x category
//
//   base     = tvl_usd x 0.25
//   growth   = 1 + clamp(change_7d, -60, 120) / 100 x 0.60
//   maturity = 0.55 + min(age_days, 1095) / 1095 x 0.45   (age unknown: 365)
//   chain    = 1 + 0.025 x min(chains - 1, 8)              (1.00 - 1.20)
//   category = the table in section 3                      (0.90 - 1.08)
//
// Only the snapshot's own figures feed it — TVL, seven-day growth, age
// since listed_at, chain count, category. No protocol name is ever
// special-cased: the same function scores every row, and the board is the
// rows sorted by what it returns. TVL still dominates; growth and age move
// a row; chain breadth and category are modest on purpose, so no factor
// alone can lift a small protocol above a large one.
//
// Why breadth and category at all: a protocol live on many chains has
// distribution a single-chain one does not, so breadth earns a small
// premium capped at 20%. Fee-earning categories (Dexs, Lending) earn a
// small premium; wrapped, bridged and staking products earn a discount,
// because their token — if one ever comes — captures less of the
// protocol's own value.

// ---------------------------------------------------------------------------
// 1. Shapes: the snapshot, the model, one board row, the dashboard's data.
// ---------------------------------------------------------------------------

/** One protocol as the sealed snapshot carries it: exactly ten fields. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, stated in the dashboard's model panel too. */
export interface ModelConstants {
  base_multiple: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  chain_step: number;
  chain_max_extra: number;
}

export const MODEL: ModelConstants = {
  base_multiple: 0.25,
  growth_weight: 0.6,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.55,
  maturity_range: 0.45,
  maturity_days: 1095,
  unknown_age_days: 365,
  chain_step: 0.025,
  chain_max_extra: 8,
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-2';

/** How many pre-token protocols below the watchlist floor the early radar carries, by TVL. */
export const EARLY_ROWS = 210;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** Category multipliers: fee-earning categories up, wrapped/bridged down, else 1.00. */
export const CATEGORY_MULT: Record<string, number> = {
  Dexs: 1.08,
  Lending: 1.08,
  CDP: 1.08,
  Yield: 1.06,
  Derivatives: 1.05,
  'Risk Curators': 1.05,
  'Onchain Capital Allocator': 1.05,
  'Yield Aggregator': 1.04,
  'Basis Trading': 1.04,
  'Leveraged Farming': 1.04,
  'Liquidity Manager': 1.05,
  Farm: 1.04,
  RWA: 1.02,
  'Liquid Staking': 0.92,
  'Staking Pool': 0.92,
  Restaking: 0.92,
  Bridge: 0.9,
  'Canonical Bridge': 0.9,
  'Liquid Restaking': 0.92,
  'Restaked BTC': 0.92,
};

/** One farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    chain_multiplier: number;
    category_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with farm plans generated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  chain_multiplier: number;
  category_multiplier: number;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

// ---------------------------------------------------------------------------
// 2. Small helpers: dates, numbers, ordering.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Clamp `n` into [`lo`, `hi`]. */
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Four-decimal rounding, for the multipliers the board records. */
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** Whole days from `listedAt` to `asOf`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Slug order: the tie-break every sort in this file shares. */
function bySlug(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// 3. The five factors, one function each.
// ---------------------------------------------------------------------------

/** Factor 1 — base value: a quarter of TVL, before any adjustment. */
export function baseValue(tvlUsd: number, model: ModelConstants): number {
  return tvlUsd * model.base_multiple;
}

/** The week's growth, clamped to the model's band; unreported growth reads as 0. */
export function clampedGrowth(change7d: number | null, model: ModelConstants): number {
  return clamp(numberOr(change7d, 0), model.growth_floor, model.growth_cap);
}

/** Factor 2 — growth: up 0.6% of implied value per point of weekly growth. */
export function growthMultiplier(change7d: number | null, model: ModelConstants): number {
  return 1 + (clampedGrowth(change7d, model) / 100) * model.growth_weight;
}

/** Factor 3 — maturity: 0.55 for a newborn protocol, rising to 1.00 after three years. */
export function maturityMultiplier(age: number | null, model: ModelConstants): number {
  const days = clamp(age ?? model.unknown_age_days, 0, model.maturity_days);
  return model.maturity_floor + (days / model.maturity_days) * model.maturity_range;
}

/** Factor 4 — chain breadth: 1 + 0.025 per extra chain, capped at eight extra chains (1.00–1.20). */
export function chainMultiplier(chains: string[], model: ModelConstants): number {
  const extra = clamp(chains.length - 1, 0, model.chain_max_extra);
  return 1 + model.chain_step * extra;
}

/** Factor 5 — category: the table above; 1.00 when unlisted, 0.97 when none is named. */
export function categoryMultiplier(category: string | null): number {
  if (category === null) return 0.97;
  return CATEGORY_MULT[category] ?? 1.0;
}

/** Every factor at once, plus the implied value they multiply to. */
export interface ScoredProtocol {
  implied: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  chainMult: number;
  catMult: number;
  age: number | null;
}

export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
): ScoredProtocol {
  const age = ageDays(asOf, protocol.listed_at);
  const growthPct = clampedGrowth(protocol.change_7d, model);
  const growthMult = growthMultiplier(protocol.change_7d, model);
  const maturityMult = maturityMultiplier(age, model);
  const chainMult = chainMultiplier(protocol.chains, model);
  const catMult = categoryMultiplier(protocol.category);
  const implied = Math.max(
    1,
    Math.round(baseValue(protocol.tvl_usd, model) * growthMult * maturityMult * chainMult * catMult),
  );
  return { implied, growthPct, growthMult, maturityMult, chainMult, catMult, age };
}

// ---------------------------------------------------------------------------
// 4. Eligibility: which protocols the board may rank at all.
// ---------------------------------------------------------------------------

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The snapshot's protocols by slug. */
function indexBySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

// ---------------------------------------------------------------------------
// 5. Board assembly: watchlist first, then the early radar, then the ranking.
// ---------------------------------------------------------------------------

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = indexBySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every one of its protocols is on the board.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: the highest-TVL rankable protocols below the floor.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || bySlug(a.slug, b.slug))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => ({ p, score: impliedValue(p, snapshot.as_of, model) }));
  scored.sort((a, b) => b.score.implied - a.score.implied || bySlug(a.p.slug, b.p.slug));
  return scored.map((s, i) => toBoardRow(s.p, s.score, i + 1, model));
}

/** One scored protocol, laid out as the board.json row the gate reads. */
function toBoardRow(
  p: SnapshotProtocol,
  s: ScoredProtocol,
  rank: number,
  model: ModelConstants,
): BoardRow {
  return {
    rank,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    mcap_usd: p.mcap_usd,
    listed_at: p.listed_at,
    gecko_id: p.gecko_id,
    symbol: p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      base_multiple: model.base_multiple,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      chain_multiplier: round4(s.chainMult),
      category_multiplier: round4(s.catMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(p, s.age).map(stepText),
  };
}

// ---------------------------------------------------------------------------
// 6. Farm plans: nine concrete steps per protocol, derived from its record.
//    The action and the weekly action are tables of (category test, text),
//    tried in order — the first test that matches wins, exactly as the
//    if-chain they replace did. No name is special-cased.
// ---------------------------------------------------------------------------

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

interface FarmContext {
  p: SnapshotProtocol;
  capital: number;
  chain: string;
}

type ActionBuilder = (ctx: FarmContext) => string;

/** One row of the main-action table: a category test and the action it picks. */
interface ActionRule {
  test: (category: string) => boolean;
  build: ActionBuilder;
}

const MAIN_ACTIONS: ActionRule[] = [
  {
    test: (c) => c.includes('lend') || c.includes('cdp') || c.includes('collateral'),
    build: ({ p, capital, chain }) =>
      `Supply $${capital} of USDC to ${p.name} on ${chain} and keep the position open.`,
  },
  {
    test: (c) => c.includes('dex') || c.includes('yield') || c.includes('leveraged farm'),
    build: ({ p, capital, chain }) =>
      `Provide $${capital} of liquidity to ${p.name}'s main pool on ${chain} and keep the position open.`,
  },
  {
    test: (c) => c.includes('bridge'),
    build: ({ p, capital, chain }) =>
      `Bridge $${capital} of USDC to ${chain} through ${p.name} and use the bridged funds in its app.`,
  },
  {
    test: (c) => c.includes('staking') || c.includes('restak'),
    build: ({ p, capital }) =>
      `Stake $${capital} of the chain's staking asset through ${p.name} and keep the receipt.`,
  },
  {
    test: (c) => c.includes('perpetual') || c.includes('derivative'),
    build: ({ p, capital }) =>
      `Deposit $${capital} of USDC as margin on ${p.name} and open one small hedge.`,
  },
  {
    test: (c) => c.includes('prediction'),
    build: ({ p, capital }) => `Fund $${capital} and place one market position on ${p.name}.`,
  },
  {
    test: (c) => c.includes('curator') || c.includes('allocator'),
    build: ({ p, capital, chain }) =>
      `Deposit $${capital} into a ${p.name} vault on ${chain} and keep the shares.`,
  },
  {
    test: (c) => c.includes('stable'),
    build: ({ p, capital, chain }) =>
      `Mint or deposit $${capital} of the stable asset through ${p.name} on ${chain}.`,
  },
  {
    test: (c) => c.includes('rwa'),
    build: ({ p, capital, chain }) =>
      `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`,
  },
  {
    test: (c) => c.includes('insurance'),
    build: ({ p, capital, chain }) =>
      `Buy $${capital} of cover from ${p.name} on ${chain} and keep the policy.`,
  },
];

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  for (const rule of MAIN_ACTIONS) {
    if (rule.test(c)) return rule.build({ p, capital, chain });
  }
  return `Deposit $${capital} of USDC into ${p.name} on ${chain} and keep the position open.`;
}

/** A second position: on a second chain when the protocol has one, else a top-up a week later. */
function secondActionFor(p: SnapshotProtocol, half: number): string {
  if (p.chains.length >= 2) {
    return `Repeat the main position on ${p.chains[1]} with $${half} so the farm is counted on two chains, not one.`;
  }
  return `Top up the main position with another $${half} a week later so the farm shows repeat activity, not one deposit.`;
}

/** One row of the weekly-action table: a category test and the action it picks. */
interface WeeklyRule {
  test: (category: string) => boolean;
  build: () => string;
}

const WEEKLY_ACTIONS: WeeklyRule[] = [
  {
    test: (c) => c.includes('lend') || c.includes('cdp'),
    build: () => `Borrow $20 against the deposit and repay it the same week, so the position shows both sides.`,
  },
  {
    test: (c) => c.includes('dex'),
    build: () => `Swap $20 through the protocol's own pool and add $10 of liquidity if the pool allows it.`,
  },
  {
    test: (c) => c.includes('perpetual') || c.includes('derivative'),
    build: () => `Close the hedge and open a fresh small one, keeping the margin in place.`,
  },
  {
    test: (c) => c.includes('bridge'),
    build: () => `Bridge $20 to a second chain the protocol supports and use it in its app.`,
  },
  {
    test: (c) => c.includes('staking') || c.includes('restak'),
    build: () => `Restake the rewards the position earned and keep the receipt token.`,
  },
  {
    test: (c) => c.includes('prediction'),
    build: () => `Place one small market position and settle it before the week ends.`,
  },
  {
    test: (c) => c.includes('yield') || c.includes('curator') || c.includes('allocator'),
    build: () => `Harvest the yield the vault earned and redeposit it into the same vault.`,
  },
];

/** The weekly qualifying action, by category: the same kind of use the protocol rewards. */
function weeklyFor(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  for (const rule of WEEKLY_ACTIONS) {
    if (rule.test(c)) return rule.build();
  }
  return `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`;
}

/**
 * A protocol's farm plan: nine steps, each an action with a cost and a time.
 * Derived from the protocol's own record (category, chains, TVL, age), never
 * from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const half = Math.max(10, Math.floor(capital / 2));
  const hold = holdDaysFor(age);
  const gas = capital >= 150 ? 8 : 4;
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: `Move $${capital} of USDC to your farm wallet on ${chain} and keep $5 aside for gas on that chain.`,
      cost: `$${capital} of capital and about $${gas} of gas`,
      time: '10 minutes to fund',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital and about $${gas} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: secondActionFor(p, half),
      cost: `$${half} of capital and about $3 of gas`,
      time: '15 minutes',
    },
    { text: weeklyFor(p), cost: 'about $2 of gas a week', time: '10 minutes a week' },
    {
      text: `Open the protocol's own points or rewards page once a week and check the position is counted; use only the link the protocol itself publishes.`,
      cost: 'no fee to check',
      time: '5 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes; never pay a fee to claim.`,
      cost: 'no fee to claim, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

// ---------------------------------------------------------------------------
// 7. The live set and the dashboard's dataset.
// ---------------------------------------------------------------------------

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    chain_multiplier: row.model.chain_multiplier,
    category_multiplier: row.model.category_multiplier,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(
  snapshot: Snapshot,
  model: ModelConstants = MODEL,
): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

// ---------------------------------------------------------------------------
// 8. Reading the snapshot: strict shape checks, one clear error each.
// ---------------------------------------------------------------------------

/** A JSON value that must be an object, or the error the caller reports. */
function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SnapshotError(`snapshot.json's ${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

/** One protocol entry out of the snapshot's array, with missing fields made safe. */
function parseProtocol(value: unknown, i: number): SnapshotProtocol {
  const p = asObject(value, `protocol ${i}`);
  if (
    typeof p.slug !== 'string' ||
    typeof p.name !== 'string' ||
    typeof p.tvl_usd !== 'number' ||
    !Number.isFinite(p.tvl_usd)
  ) {
    throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
  }
  return {
    slug: p.slug,
    name: p.name,
    category: typeof p.category === 'string' ? p.category : null,
    chains: Array.isArray(p.chains)
      ? p.chains.filter((c): c is string => typeof c === 'string')
      : [],
    tvl_usd: p.tvl_usd,
    change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
    mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
    listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
    gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
    symbol: typeof p.symbol === 'string' ? p.symbol : null,
  };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotError('snapshot.json is not a JSON object');
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) {
    throw new SnapshotError('snapshot.json has no as_of date');
  }
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols: o.protocols.map((v, i) => parseProtocol(v, i)),
    watchlist: o.watchlist as string[],
  };
}

// ---------------------------------------------------------------------------
// 9. The gate's own self-check, run before main.ts writes anything.
// ---------------------------------------------------------------------------

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) {
    return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  }
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  }
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) {
      return `row ${i + 1} outranks row ${i} on implied value`;
    }
  }
  if (
    board.length >= 2 &&
    board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd
  ) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) {
      return `${r.slug} has ${r.farm_steps.length} farm steps`;
    }
    for (const s of r.farm_steps) {
      if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 10. The dashboard's dataset, as one script: no fetch, no network.
// ---------------------------------------------------------------------------

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
