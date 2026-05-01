// ═══ Gumax — Sistema de Rating Premier-style ═══
//
// CS Rating numérico (0–30,000+) com 7 tiers visuais. Igual CS2 Premier.
//
// Flow:
//   1. Player começa SEM rating (csRating=null, "Calibrando 0/3")
//   2. Primeiras 3 partidas guardadas em calibrationMatches[]
//   3. Após 3ª partida, calibrationRating() calcula rating inicial (max 20k)
//   4. Partidas seguintes aplicam calculateMatchDelta() (Elo modificado)
//   5. Reset todo dia 01 do mês (cron) — zera csRating, salva lastSeasonTier
//
// Fórmula pós-calibração:
//   delta = baseResult + skillDiff + roundsDiff + perfBonus
//
//   baseResult     = ±200 (win/loss)
//   skillDiff      = (opponentTeamAvg - ownTeamAvg) / 5
//                    (oponente +5000 → +1000 extra ao vencer; -1000 ao perder)
//   roundsDiff     = (roundsScored - roundsConceded) × 8
//                    (13-1 = +96; 13-11 = +16)
//   perfBonus      = (kills - deaths)×4 + assists×2 + mvps×10
//
//   Limitado a [-1500, +1500] por partida.

const TIER_THRESHOLDS = [
  { min:     0, max:  4999, key: 'gray',    name: 'Bronze',     color: '#9ca3af', emoji: '⚪' },
  { min:  5000, max:  9999, key: 'silver',  name: 'Prata',      color: '#7dd3fc', emoji: '🩵' },
  { min: 10000, max: 14999, key: 'gold',    name: 'Ouro',       color: '#3b82f6', emoji: '🟦' },
  { min: 15000, max: 19999, key: 'plat',    name: 'Platina',    color: '#a855f7', emoji: '🟣' },
  { min: 20000, max: 24999, key: 'diamond', name: 'Diamante',   color: '#ec4899', emoji: '🩷' },
  { min: 25000, max: 29999, key: 'master',  name: 'Mestre',     color: '#ef4444', emoji: '🔴' },
  { min: 30000, max: 9e9,   key: 'top',     name: 'Top Global', color: '#facc15', emoji: '🟡' },
];

function getTierForRating(rating) {
  if (rating == null) return { key: 'calibrating', name: 'Calibrando', color: '#6b7280', emoji: '🎯' };
  const safeRating = Math.max(0, rating);
  for (const t of TIER_THRESHOLDS) {
    if (safeRating >= t.min && safeRating <= t.max) {
      return { key: t.key, name: t.name, color: t.color, emoji: t.emoji };
    }
  }
  return TIER_THRESHOLDS[TIER_THRESHOLDS.length - 1];
}

// Rating inicial após 3 partidas de calibração.
// Base 7000 (Prata-Ouro). Wins/Losses + KDR ajustam.
// Limitado a 20k (Diamante) — não dá pra cair direto em Top Global na calibração.
function calibrationRating(matches3) {
  if (!Array.isArray(matches3) || matches3.length < 3) {
    console.warn('[rating] calibrationRating chamado com menos de 3 matches:', matches3?.length);
    return 5000; // fallback Prata baixo
  }
  const m3 = matches3.slice(-3); // pega exatamente as 3 últimas
  let wins = 0, losses = 0, totalK = 0, totalD = 0, totalA = 0;
  m3.forEach(m => {
    if (m.result === 'win') wins++;
    if (m.result === 'loss') losses++;
    totalK += m.kills || 0;
    totalD += m.deaths || 0;
    totalA += m.assists || 0;
  });
  const avgKDR = totalK / Math.max(1, totalD);
  const avgKDA = (totalK + totalA) / Math.max(1, totalD);

  let rating = 7000;
  rating += wins * 1500;
  rating -= losses * 800;

  // KDR scaling — performance individual importa
  if (avgKDR >= 1.5)      rating += 3500;
  else if (avgKDR >= 1.3) rating += 2000;
  else if (avgKDR >= 1.1) rating += 800;
  else if (avgKDR >= 0.9) rating += 0;
  else if (avgKDR >= 0.7) rating -= 1200;
  else                    rating -= 2500;

  // KDA leve bonus pra suporte (assists balance)
  if (avgKDA > avgKDR + 0.3) rating += 500; // jogador de suporte (assists altos)

  // Bound: 0 (nunca negativo) — 20000 (max calibração = Diamante)
  return Math.max(0, Math.min(20000, Math.round(rating)));
}

// Delta de rating após partida pós-calibração.
// Implementa Elo modificado: oponente mais forte → ganho/perda inflada.
function calculateMatchDelta({
  won,
  ownTeamAvg = 7000,
  opponentTeamAvg = 7000,
  roundsScored = 0,
  roundsConceded = 0,
  kills = 0,
  deaths = 0,
  assists = 0,
  mvps = 0,
}) {
  const baseResult = won ? 200 : -200;

  // Skill differential: positive = oponente mais forte (favorável vencer = mais pontos)
  const skillDiffRaw = (opponentTeamAvg - ownTeamAvg) / 5;
  // Quando vence: ganha mais se oponente mais forte (skillDiffRaw positivo)
  // Quando perde: perde mais se oponente mais fraco (skillDiffRaw negativo)
  // Sinal: ao vencer, soma skillDiffRaw; ao perder, INVERTE (perde proporcional ao quão fraco era)
  const skillBonus = won ? skillDiffRaw : -Math.abs(skillDiffRaw) * (skillDiffRaw < 0 ? 1 : 0.3);

  // Rounds differential — afeta intensidade
  const roundsDiff = (roundsScored - roundsConceded) * 8;

  // Performance individual
  const perfBonus = (kills - deaths) * 4 + assists * 2 + mvps * 10;

  let delta = baseResult + skillBonus + roundsDiff + perfBonus;

  // Bound -1500 .. +1500
  delta = Math.max(-1500, Math.min(1500, delta));

  return Math.round(delta);
}

// Calcula rating médio do time. Players em calibração contam como 5000 (default).
function teamAverageRating(playerStatsArray) {
  if (!playerStatsArray || playerStatsArray.length === 0) return 5000;
  const ratings = playerStatsArray.map(p => p.csRating != null ? p.csRating : 5000);
  return ratings.reduce((a, b) => a + b, 0) / ratings.length;
}

module.exports = {
  TIER_THRESHOLDS,
  getTierForRating,
  calibrationRating,
  calculateMatchDelta,
  teamAverageRating,
};
