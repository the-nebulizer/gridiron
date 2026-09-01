// Thin client for the Sleeper public read-only API (no auth, no keys).
import { stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const BASE = 'https://api.sleeper.app/v1';

async function get(p) {
  const url = `${BASE}${p}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sleeper API ${res.status} for ${url}`);
  return res.json();
}

export const getState = () => get('/state/nfl');
export const getLeague = (leagueId) => get(`/league/${leagueId}`);
export const getRosters = (leagueId) => get(`/league/${leagueId}/rosters`);
export const getUsers = (leagueId) => get(`/league/${leagueId}/users`);
export const getMatchups = (leagueId, week) => get(`/league/${leagueId}/matchups/${week}`);
export const getTransactions = (leagueId, week) => get(`/league/${leagueId}/transactions/${week}`);
export const getTrending = (type) => get(`/players/nfl/trending/${type}?lookback_hours=48&limit=50`);

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
