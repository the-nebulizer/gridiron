// Thin client for the Sleeper public read-only API (no auth, no keys).
import { stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const BASE = 'https://api.sleeper.app/v1';
const HOST = 'https://api.sleeper.app';

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sleeper API ${res.status} for ${url}`);
  return res.json();
}

const get = (p) => fetchJson(`${BASE}${p}`);

export const getState = () => get('/state/nfl');
export const getLeague = (leagueId) => get(`/league/${leagueId}`);
export const getRosters = (leagueId) => get(`/league/${leagueId}/rosters`);
export const getUsers = (leagueId) => get(`/league/${leagueId}/users`);
export const getMatchups = (leagueId, week) => get(`/league/${leagueId}/matchups/${week}`);
export const getTransactions = (leagueId, week) => get(`/league/${leagueId}/transactions/${week}`);
export const getTrending = (type) => get(`/players/nfl/trending/${type}?lookback_hours=48&limit=50`);

// Season schedule: one entry per game ({week, date, home, away, status}).
// NOT under /v1 — this is the path Sleeper's own clients use. It is the only
// source of bye weeks: the players dump carries no bye field at all.
export const getSchedule = (season, seasonType = 'regular') =>
  fetchJson(`${HOST}/schedule/nfl/${seasonType}/${season}`);

// Team -> bye week, derived from the schedule (the week a team has no game).
export function byeWeeks(schedule) {
  const weeks = [...new Set(schedule.map((g) => g.week))].sort((a, b) => a - b);
  const played = new Map();
  for (const g of schedule) {
    for (const team of [g.home, g.away]) {
      if (!played.has(team)) played.set(team, new Set());
      played.get(team).add(g.week);
    }
  }
  const byes = new Map();
  for (const [team, weeksPlayed] of played) {
    const bye = weeks.filter((w) => !weeksPlayed.has(w));
    // A single missed week is a bye; anything else means an incomplete schedule.
    if (bye.length === 1) byes.set(team, bye[0]);
  }
  return byes;
}

// Kickoff has happened once any game has moved off pre_game. Comparing today's
// date to season_start_date flips a day early (it parses as UTC midnight).
export const kickoffHasHappened = (schedule) =>
  schedule.some((g) => g.status && g.status !== 'pre_game' && g.status !== 'canceled');

// ~5MB dump; Sleeper asks clients to fetch it at most once per day.
export async function getPlayers(cacheFile) {
  try {
    const s = await stat(cacheFile);
    if (Date.now() - s.mtimeMs < 24 * 60 * 60 * 1000) {
      return JSON.parse(await readFile(cacheFile, 'utf8'));
    }
  } catch {
    // no cache yet
  }
  const players = await get('/players/nfl');
  await mkdir(path.dirname(cacheFile), { recursive: true });
  await writeFile(cacheFile, JSON.stringify(players));
  return players;
}
