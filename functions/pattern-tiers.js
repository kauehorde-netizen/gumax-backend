// ═══ Gumax — Pattern & Float Tier Analysis ═══
// Análise refinada por float + paintseed + paintindex:
//
//   1. Float tier — posição do float dentro do range do wear
//      - FT range = 0.15-0.38. Float 0.16 = top 1%, MUITO mais caro que 0.37.
//      - Retorna percentil + multiplicador de preço estimado.
//
//   2. Doppler phase — skin Doppler (faca) tem Phase 1/2/3/4 + Ruby/Sapphire/BP/Emerald.
//      Identificado pelo paintindex. Ruby >>> Sapphire > Phase 2 > Phase 1 > Phase 4 > Phase 3.
//
//   3. Blue Gem pattern — Case Hardened (AK, Karambit, Bayonet, AWP Safari Mesh Desert Storm)
//      tem patterns raros (blue dominant pattern). Tier 1 = muito raro, preço 10-50x base.
//
//   4. Fade % — Karambit/M9 Fade, Marble Fade: paintseed determina o "fade percentage"
//      (0-100%). >90% = "Max Fade", muito caro. Não implementado aqui ainda (fórmula
//      complexa por skin).
//
// Export:
//   analyzeFloatTier(name, floatvalue)     → { tier, percentile, label, priceFactor }
//   analyzeDopplerPhase(name, paintindex)  → { phase, rarity, priceFactor } | null
//   analyzeBlueGem(name, paintseed)        → { tier, notable, priceFactor } | null
//   analyzePatternOverall(item)            → resultado agregado

// ── 1. Float tiers por wear ────────────────────────────────────────────────
// Ranges oficiais do CS2. Dentro de cada wear, dividimos em tiers:
//   Low (top 15%)    → premium (ex: +15-40% do preço médio)
//   Mid              → baseline
//   High (bottom 15%) → desconto (-5-15%)
// Multiplicadores são heurística conservadora; skins específicas variam muito.
const WEAR_RANGES = {
  'Factory New':    { min: 0.00, max: 0.07, code: 'FN' },
  'Minimal Wear':   { min: 0.07, max: 0.15, code: 'MW' },
  'Field-Tested':   { min: 0.15, max: 0.38, code: 'FT' },
  'Well-Worn':      { min: 0.38, max: 0.45, code: 'WW' },
  'Battle-Scarred': { min: 0.45, max: 1.00, code: 'BS' },
};

function detectWearFromName(name) {
  if (!name) return null;
  for (const [label, r] of Object.entries(WEAR_RANGES)) {
    if (name.includes(`(${label})`)) return { label, ...r };
  }
  return null;
}

function analyzeFloatTier(name, floatvalue) {
  if (floatvalue == null || !isFinite(floatvalue)) return null;
  const wear = detectWearFromName(name);
  if (!wear) return null;

  const clamped = Math.max(wear.min, Math.min(wear.max, floatvalue));
  // pctInRange: 0 = float mínimo (melhor), 1 = float máximo (pior)
  const pctInRange = (clamped - wear.min) / (wear.max - wear.min);
  const percentile = Math.round(pctInRange * 100);

  let tier, label, priceFactor;
  if (pctInRange <= 0.05) {
    tier = 'legendary';
    label = `Top 5% do ${wear.code} — Float excepcional`;
    priceFactor = 1.25; // +25%
  } else if (pctInRange <= 0.15) {
    tier = 'premium';
    label = `Top 15% do ${wear.code} — Float muito bom`;
    priceFactor = 1.12; // +12%
  } else if (pctInRange >= 0.85) {
    tier = 'worst';
    label = `Bottom 15% do ${wear.code} — Float ruim, difícil vender`;
    priceFactor = 0.90; // -10%
  } else if (pctInRange >= 0.65) {
    tier = 'below_avg';
    label = `Acima da média do ${wear.code} — float baixo`;
    priceFactor = 0.97;
  } else {
    tier = 'average';
    label = `Float médio pro ${wear.code}`;
    priceFactor = 1.00;
  }

  return {
    floatvalue,
    wear: wear.code,
    wearRange: [wear.min, wear.max],
    percentile,
    pctInRange: +pctInRange.toFixed(4),
    tier,
    label,
    priceFactor,
  };
}

// ── 2. Doppler phases ──────────────────────────────────────────────────────
// Paintindex oficial do CS2 pros Dopplers/Gamma Dopplers/Marble Fade.
// Valores: https://wiki.cs.money/doppler-phases, fontes da Valve e Steam community.
const DOPPLER_PHASES = {
  // Doppler tradicional (azul, escarlate, roxo, rosa)
  415: { phase: 'Ruby',        rarity: 'legendary', priceFactor: 2.5, color: '#e11d48' },
  416: { phase: 'Sapphire',    rarity: 'legendary', priceFactor: 2.2, color: '#2563eb' },
  417: { phase: 'Black Pearl', rarity: 'legendary', priceFactor: 1.8, color: '#0f172a' },
  418: { phase: 'Phase 1',     rarity: 'uncommon',  priceFactor: 1.0, color: '#7c3aed' },
  419: { phase: 'Phase 2',     rarity: 'rare',      priceFactor: 1.3, color: '#a855f7' },
  420: { phase: 'Phase 3',     rarity: 'uncommon',  priceFactor: 0.95, color: '#ec4899' },
  421: { phase: 'Phase 4',     rarity: 'uncommon',  priceFactor: 1.0, color: '#db2777' },

  // Gamma Doppler (fases verdes + Emerald)
  568: { phase: 'Gamma Phase 1', rarity: 'uncommon',  priceFactor: 1.0, color: '#15803d' },
  569: { phase: 'Gamma Phase 2', rarity: 'rare',      priceFactor: 1.15, color: '#16a34a' },
  570: { phase: 'Gamma Phase 3', rarity: 'uncommon',  priceFactor: 0.95, color: '#22c55e' },
  571: { phase: 'Gamma Phase 4', rarity: 'uncommon',  priceFactor: 1.05, color: '#4ade80' },
  572: { phase: 'Emerald',       rarity: 'legendary', priceFactor: 2.8, color: '#059669' },

  // Marble Fade (FireIce, FakeBlueGem, etc) — paintindexes aproximados
  413: { phase: 'Marble Fade',   rarity: 'standard', priceFactor: 1.0, color: '#f59e0b' },
};

function analyzeDopplerPhase(name, paintindex) {
  if (paintindex == null) return null;
  const info = DOPPLER_PHASES[parseInt(paintindex, 10)];
  if (!info) return null;
  // Marble Fade tem tiers especiais (FireIce, FakeBlueGem) determinados por paintseed,
  // mas isso é skin-specific — deixamos pra análise de pattern abaixo.
  const isDoppler = /Doppler/i.test(name || '');
  const isMarble = /Marble Fade/i.test(name || '');
  return {
    paintindex: parseInt(paintindex, 10),
    phase: info.phase,
    rarity: info.rarity,
    priceFactor: info.priceFactor,
    color: info.color,
    isDoppler,
    isMarble,
  };
}

// ── 3. Blue Gem patterns (Case Hardened) ───────────────────────────────────
// Lista conservadora dos patterns mais conhecidos/documentados. Fonte:
// csblue.gem, reddit /r/csgotrading, csgofloat. Tier 1 = top-tier blue gem
// (muito azul dominante); Tier 2/3 = bluish notáveis mas menos raros.
// Preços: Tier 1 AK geralmente 5-30x o preço base; Karambit pode passar 50x.
const BLUE_GEM_PATTERNS = {
  'AK-47 | Case Hardened': {
    tier1: [661, 670, 321, 151, 179, 555, 592, 760, 868, 955],
    tier2: [690, 387, 809, 787, 576, 382, 784, 727, 592, 603],
    tier3: [403, 578, 756, 903, 920, 760, 875],
  },
  '★ Karambit | Case Hardened': {
    tier1: [387, 442, 444, 463, 542, 589, 874, 884, 902, 922],
    tier2: [231, 534, 555, 617, 672, 682, 683, 750, 843],
    tier3: [45, 84, 191, 235, 263, 278, 356, 433, 550],
  },
  '★ Bayonet | Case Hardened': {
    tier1: [148, 364, 587, 620, 675, 760, 863, 902, 908, 969],
    tier2: [19, 134, 227, 335, 366, 439, 475, 526],
    tier3: [44, 151, 225, 305, 430, 529, 686],
  },
  '★ M9 Bayonet | Case Hardened': {
    tier1: [150, 215, 321, 385, 408, 416, 569, 592, 675, 939],
    tier2: [52, 98, 143, 245, 370, 530, 720, 811],
    tier3: [23, 175, 268, 314, 453, 564, 781],
  },
  'Five-SeveN | Case Hardened': {
    tier1: [278, 363, 369, 472, 691, 868, 872],
    tier2: [184, 395, 476, 516, 556, 720],
    tier3: [31, 166, 358, 463, 515],
  },
  'Desert Eagle | Heat Treated': {
    tier1: [148, 151, 230, 266, 411, 490, 546, 790],
    tier2: [52, 117, 283, 355, 431, 644],
    tier3: [10, 82, 230, 325, 557],
  },
};

function analyzeBlueGem(name, paintseed) {
  if (paintseed == null) return null;
  const ps = parseInt(paintseed, 10);
  if (!isFinite(ps)) return null;
  const bare = String(name || '').replace(/^StatTrak™\s*/, '').replace(/^Souvenir\s*/, '').trim();
  // Normaliza: remove wear "(Xxx)"
  const canonical = bare.replace(/\s*\((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/, '');
  const db = BLUE_GEM_PATTERNS[canonical];
  if (!db) return null;

  let tier = null, notable = false, priceFactor = 1.0, label = null;
  if (db.tier1?.includes(ps)) { tier = 1; priceFactor = 8.0; notable = true; label = 'Blue Gem Tier 1 — top-tier, muito raro'; }
  else if (db.tier2?.includes(ps)) { tier = 2; priceFactor = 3.0; notable = true; label = 'Blue Gem Tier 2 — notável'; }
  else if (db.tier3?.includes(ps)) { tier = 3; priceFactor = 1.8; notable = true; label = 'Blue Gem Tier 3 — bluish interessante'; }
  else { label = 'Pattern comum'; }

  return { paintseed: ps, tier, notable, priceFactor, label };
}

// ── 4. Pattern overall ─────────────────────────────────────────────────────
// Combina tudo. Pega o nome + inputs opcionais (float, paintseed, paintindex)
// e retorna análise agregada + multiplicador final recomendado.
function analyzePatternOverall(name, { floatvalue, paintseed, paintindex } = {}) {
  const float = analyzeFloatTier(name, floatvalue);
  const doppler = analyzeDopplerPhase(name, paintindex);
  const blueGem = analyzeBlueGem(name, paintseed);

  // Multiplicador combinado — multiplicativo pra empilhar: ex. Top-5% float +
  // Tier 1 Blue Gem pode dar 1.25 × 8.0 = 10x base.
  let factor = 1.0;
  if (float?.priceFactor) factor *= float.priceFactor;
  if (doppler?.priceFactor) factor *= doppler.priceFactor;
  if (blueGem?.priceFactor) factor *= blueGem.priceFactor;
  factor = Math.round(factor * 100) / 100;

  const notes = [];
  if (float) notes.push(float.label);
  if (doppler) notes.push(`${doppler.phase} (${doppler.rarity})`);
  if (blueGem?.notable) notes.push(blueGem.label);

  return {
    float,
    doppler,
    blueGem,
    combinedPriceFactor: factor,
    notes,
    hasRefinement: !!(float || doppler || blueGem?.notable),
  };
}

module.exports = {
  analyzeFloatTier,
  analyzeDopplerPhase,
  analyzeBlueGem,
  analyzePatternOverall,
  detectWearFromName,
  WEAR_RANGES,
  DOPPLER_PHASES,
  BLUE_GEM_PATTERNS,
};
