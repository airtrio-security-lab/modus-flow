/**
 * «Путь Посла» (ADR-0032): what an envoy wears, as data — civilization × rank. `EnvoyFigure` draws it.
 * No imports on purpose: the rules «every rank looks different» and «every civilization has its own
 * attire» are checked by a test without a browser (test/platform/envoy-outfits.test.ts).
 *
 * The figure has no head and no face: a headwear sits over a high collar. Each next rank ADDS new
 * pieces of clothing, heraldry or equipment, not only a colour. Historical names are decoration.
 */
export type OutfitCiv = 'camelot' | 'japan' | 'kazakh' | 'russia' | 'mongolia';
export const OUTFIT_CIVS: readonly OutfitCiv[] = ['camelot', 'japan', 'kazakh', 'russia', 'mongolia'];

/** How far down the garment goes: knee (I–II), ankle (III–IV), floor (V–VI), floor with a train (VII). */
export type Length = 'knee' | 'ankle' | 'floor' | 'train';
export type Cloak = 'travel' | 'fine' | 'long' | 'parade' | 'embroidered' | 'mantle' | 'ceremonial';
export type Metal = 'none' | 'bronze' | 'silver' | 'gold';

/** Pieces shared by every civilization (drawn in each civilization's manner). */
export type Piece =
  | 'satchel' // I: leather bag
  | 'scroll' // I–IV: a plain scroll in hand
  | 'belt' // II+
  | 'clasp' // II+: cloak clasp (bronze → silver → gold)
  | 'crest' // III+: the department's coat of arms on the chest
  | 'seal' // III+: official seal on a cord
  | 'staff' // IV–V: silver staff (Japan: a ceremonial fan)
  | 'banner' // IV+: small banner
  | 'chain' // V+: gold chain
  | 'ornate-scroll' // V+: decorated scroll with gold caps (replaces the plain one)
  | 'embroidery' // V+: civilization's ornament on the cloak
  | 'gold-staff' // VI+: gold staff (replaces the silver one)
  | 'insignia' // VI+: orders and insignia on the chest
  | 'fur' // VI+: fur or rich trim along the mantle
  | 'medallion' // VII: medallion with the symbols of every civilization
  | 'commonwealth-standard' // VII: the standard of the Great Commonwealth (replaces the small banner)
  | 'commonwealth-ring'; // VII: the ring of the Commonwealth above the figure (visible on the map)

export interface CivStyle {
  name: string;
  /** Garment of the civilization at ranks I–II / III–IV / V–VII (drawn by its own painter). */
  garment: [string, string, string];
  /** Headwear per rank band I–II / III–V / VI–VII. */
  headwear: [string, string, string];
  /** The extra piece only this civilization has, from rank IV. */
  signature: string;
  /** Ornament name used for the embroidery. */
  ornament: string;
  /** What «staff» is in this civilization. */
  staff: string;
  palette: { travel: string; dyed: string; robe: string; robe2: string; trim: string; ceremonial: string };
}

export const CIV_STYLES: Record<OutfitCiv, CivStyle> = {
  camelot: {
    name: 'Камелот',
    garment: ['дорожная туника', 'рыцарская накидка-табар', 'геральдическое сюрко'],
    headwear: ['дорожный капюшон', 'шаперон', 'берет с плюмажем'],
    signature: 'геральдические четверти на табаре',
    ornament: 'геральдические шевроны',
    staff: 'жезл с державным шаром',
    palette: { travel: '#7d6a4f', dyed: '#5b6f8f', robe: '#2f5d8a', robe2: '#8f2f3a', trim: '#e8d9b0', ceremonial: '#f4efe2' },
  },
  japan: {
    name: 'Японский сёгунат',
    garment: ['дорожная накидка', 'хаори и хакама', 'парадное хаори с гербом-моном'],
    headwear: ['соломенная шляпа каса', 'чёрная шапка эбоси', 'высокая шапка эбоси'],
    signature: 'плечевая накидка катагину',
    ornament: 'волны сэйгайха',
    staff: 'церемониальный веер',
    palette: { travel: '#8a7a5c', dyed: '#4f5f6f', robe: '#2b3a55', robe2: '#6e2a3c', trim: '#d9c79a', ceremonial: '#f2ece0' },
  },
  kazakh: {
    name: 'Казахское ханство',
    garment: ['дорожный шапан', 'длинный шапан с каймой', 'парадный бархатный шапан'],
    headwear: ['войлочный калпак', 'бөрік с меховой опушкой', 'высокий бөрік с пером'],
    signature: 'пояс с накладными бляхами',
    ornament: 'орнамент «қошқар мүйіз»',
    staff: 'посольский посох',
    palette: { travel: '#8b6d48', dyed: '#2f6f6a', robe: '#2b4f7a', robe2: '#7a2f2f', trim: '#e3c27a', ceremonial: '#f3ead6' },
  },
  russia: {
    name: 'Русское царство',
    garment: ['дорожный кафтан', 'ферязь с нашивками', 'парчовая ферязь с откидными рукавами'],
    headwear: ['суконный колпак', 'мурмолка с опушкой', 'высокая горлатная шапка'],
    signature: 'откидные рукава ферязи',
    ornament: 'ромбовый узор',
    staff: 'посольский посох',
    palette: { travel: '#6f5a46', dyed: '#7a3b2e', robe: '#8c2f2f', robe2: '#2f4f3f', trim: '#e2c27a', ceremonial: '#f4ecdc' },
  },
  mongolia: {
    name: 'Монгольская держава',
    garment: ['дорожный халат', 'дээл с косым запахом', 'парадный дээл с парчой'],
    headwear: ['войлочная шапка', 'лисья шапка лоовууз', 'шапка с красной кистью'],
    signature: 'широкий кушак',
    ornament: 'узор «өлзий»',
    staff: 'туг с конским хвостом',
    palette: { travel: '#7f6a4d', dyed: '#3f5f7f', robe: '#2f5f8f', robe2: '#8a3a2a', trim: '#e0c07a', ceremonial: '#f2ead8' },
  },
};

export interface Outfit {
  civ: OutfitCiv;
  rank: number;
  length: Length;
  cloak: Cloak;
  metal: Metal;
  /** Index into CivStyle.garment / headwear. */
  garment: 0 | 1 | 2;
  headwear: 0 | 1 | 2;
  pieces: Piece[];
  /** The civilization's own piece from rank IV. */
  signature: boolean;
  /** Fill of the garment and the cloak. */
  cloth: string;
  cloakCloth: string;
  trim: string;
  /** How much the map shows (owner brief): I–II simple, III–IV insignia, V–VI ceremonial, VII the symbol. */
  mapTier: 'simple' | 'insignia' | 'ceremonial' | 'commonwealth';
}

const RANK_PIECES: Piece[][] = [
  ['satchel', 'scroll'],
  ['satchel', 'scroll', 'belt', 'clasp'],
  ['scroll', 'belt', 'clasp', 'crest', 'seal'],
  ['scroll', 'belt', 'clasp', 'crest', 'seal', 'staff', 'banner'],
  ['belt', 'clasp', 'crest', 'seal', 'staff', 'banner', 'chain', 'ornate-scroll', 'embroidery'],
  ['belt', 'clasp', 'crest', 'seal', 'banner', 'chain', 'ornate-scroll', 'embroidery', 'gold-staff', 'insignia', 'fur'],
  ['belt', 'clasp', 'crest', 'seal', 'chain', 'ornate-scroll', 'embroidery', 'gold-staff', 'insignia', 'fur', 'medallion', 'commonwealth-standard', 'commonwealth-ring'],
];
const CLOAKS: Cloak[] = ['travel', 'fine', 'long', 'parade', 'embroidered', 'mantle', 'ceremonial'];
const LENGTHS: Length[] = ['knee', 'knee', 'ankle', 'ankle', 'floor', 'floor', 'train'];
const METALS: Metal[] = ['none', 'bronze', 'silver', 'silver', 'gold', 'gold', 'gold'];
const TIERS: Outfit['mapTier'][] = ['simple', 'simple', 'insignia', 'insignia', 'ceremonial', 'ceremonial', 'commonwealth'];

export const outfitCiv = (id: string | null | undefined): OutfitCiv => (OUTFIT_CIVS.includes(id as OutfitCiv) ? (id as OutfitCiv) : 'camelot');
export const clampRank = (rank: number) => Math.max(1, Math.min(7, Math.round(rank) || 1));

export function outfit(civId: string | null | undefined, rankIn: number): Outfit {
  const civ = outfitCiv(civId);
  const rank = clampRank(rankIn);
  const i = rank - 1;
  const p = CIV_STYLES[civ].palette;
  const cloth = [p.travel, p.dyed, p.robe, p.robe, p.robe2, p.robe2, p.ceremonial][i]!;
  const cloakCloth = [p.travel, p.dyed, p.dyed, p.robe2, p.robe, p.robe, p.trim][i]!;
  return {
    civ,
    rank,
    length: LENGTHS[i]!,
    cloak: CLOAKS[i]!,
    metal: METALS[i]!,
    garment: rank <= 2 ? 0 : rank <= 4 ? 1 : 2,
    headwear: rank <= 2 ? 0 : rank <= 5 ? 1 : 2,
    pieces: RANK_PIECES[i]!,
    signature: rank >= 4,
    cloth,
    cloakCloth,
    trim: rank >= 5 ? '#c99a2e' : rank >= 3 ? '#b8bcc4' : rank === 2 ? '#a8743a' : p.trim,
    mapTier: TIERS[i]!,
  };
}

/** A stable text signature of what is worn — used to check that ranks and civilizations differ. */
export function outfitSignature(o: Outfit): string {
  const s = CIV_STYLES[o.civ];
  return [s.garment[o.garment], s.headwear[o.headwear], o.length, o.cloak, o.metal, o.signature ? s.signature : '-', ...o.pieces].join('|');
}

/** Plain words for the profile: «Одеяние: …». */
export function outfitWords(o: Outfit): string {
  const s = CIV_STYLES[o.civ];
  const extra = [
    o.pieces.includes('embroidery') ? s.ornament : null,
    o.signature ? s.signature : null,
    o.pieces.includes('staff') ? s.staff : null,
    o.pieces.includes('gold-staff') ? `${s.staff}, золото` : null,
  ].filter(Boolean);
  return [s.garment[o.garment], s.headwear[o.headwear], ...extra].join(', ');
}

/** Rank names (mirror of platform/domain/envoy.ts; a test keeps them equal). */
export const ENVOY_RANK_NAMES = ['Гонец', 'Вестник', 'Доверенный посланник', 'Герольд', 'Посол Совета', 'Великий посол', 'Посол Великого Содружества'] as const;
export const envoyRankName = (rank: number) => ENVOY_RANK_NAMES[clampRank(rank) - 1]!;
