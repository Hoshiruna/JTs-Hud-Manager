import { CSGOGSI, CSGORaw, Score } from 'csgogsi'
import { Router, Request, Response } from 'express'
import { Server } from 'socket.io'
import { MatchService } from '../domains/matches/match.service'
import { TeamService } from '../domains/teams/team.service'
import { PlayerRepository } from '../domains/players/player.repository'
import { getSettings } from '../domains/settings/settings.routes'
import { Match, RoundData, Veto } from '../domains/matches/match.types'
import { Team } from '../domains/teams/team.types'
import { Player } from '../domains/players/player.types'

const matchService = new MatchService()
const teamService = new TeamService()
const playerRepo = new PlayerRepository()

// --- COACH FILTER CACHE ---
// Stores steamids of players marked as coaches so they can be stripped
// from GSI payloads before broadcasting. Refreshed on startup and after
// any player create/update via syncCoaches().
let coachSteamIds = new Set<string>()

export const syncCoaches = async () => {
  try {
    const all = await playerRepo.getPlayers()
    coachSteamIds = new Set(all.filter((p) => p.isCoach && p.steamid).map((p) => p.steamid))
  } catch (err) {
    console.error('[GSI] Failed to sync coach list:', err)
  }
}

export const GSI = new CSGOGSI()
GSI.regulationMR = 12
GSI.overtimeMR = 3

// Sync GSI.teams from the current match
// Call this whenever the match changes or on startup
// This may actually not be needed as huds create their own GSI instance, need to verify this
export const syncGSITeams = async () => {
  try {
    const match = await matchService.getCurrentMatch()

    if (match.left.id) {
      const left = await teamService.getTeamById(match.left.id)
      if (left) {
        const data = {
          id: left._id,
          name: left.name,
          country: left.country,
          logo: left.logo,
          map_score: match.left.wins,
          extra: left.extra
        }
        GSI.teams.left = data
      }
    } else {
      GSI.teams.left = null
    }

    if (match.right.id) {
      const right = await teamService.getTeamById(match.right.id)
      if (right) {
        const data = {
          id: right._id,
          name: right.name,
          country: right.country,
          logo: right.logo,
          map_score: match.right.wins,
          extra: right.extra
        }
        GSI.teams.right = data
      }
    } else {
      GSI.teams.right = null
    }
  } catch {
    // No current match — clear team data
    GSI.teams.left = null
    GSI.teams.right = null
  }
}

let lastGSIState: CSGORaw | null = null

export const getLastGSIState = (): CSGORaw | null => lastGSIState

type MatchSide = 'left' | 'right'

interface GSIOverrideCache {
  expiresAt: number
  match: Match | null
  teamsById: Map<string, Team>
  playersBySteamId: Map<string, Player>
  playersByTeamId: Map<string, Player[]>
}

let overrideCache: GSIOverrideCache = {
  expiresAt: 0,
  match: null,
  teamsById: new Map(),
  playersBySteamId: new Map(),
  playersByTeamId: new Map()
}

let playerOverrideByRawSteamId = new Map<string, Player>()

export const getOverriddenPlayerBySteamId = (steamid: string): Player | null =>
  playerOverrideByRawSteamId.get(steamid) ?? null

let pendingHudMatchRefreshes = 0
let lastHudMatchRefreshMapName: string | null = null

export const requestHudMatchRefresh = (): void => {
  pendingHudMatchRefreshes = Math.max(pendingHudMatchRefreshes, 1)
}

let overwriteSettingCache = {
  expiresAt: 0,
  value: false
}

const getOverwriteGSIFromMatchSetting = async (): Promise<boolean> => {
  const now = Date.now()
  if (overwriteSettingCache.expiresAt > now) return overwriteSettingCache.value

  const settings = await getSettings()
  overwriteSettingCache = {
    expiresAt: now + 1000,
    value: settings.overwriteGSIFromMatch
  }

  return overwriteSettingCache.value
}

const getShortMapName = (mapName: string | undefined): string | null => {
  if (!mapName) return null
  return mapName.substring(mapName.lastIndexOf('/') + 1)
}

const getCurrentMapVeto = (match: Match, mapName: string | null): Veto | null => {
  if (!mapName) return null
  return (
    match.vetos.find((v) => v.mapName === mapName && !v.mapEnd) ??
    match.vetos.find((v) => v.mapName === mapName) ??
    null
  )
}

const getSideTeamIds = (match: Match, veto: Veto | null): Record<'CT' | 'T', string | null> => {
  let ctSide: MatchSide = 'left'
  let tSide: MatchSide = 'right'

  if (veto?.side && veto.side !== 'NO' && veto.teamId) {
    const vetoTeamSide: MatchSide = veto.teamId === match.right.id ? 'right' : 'left'
    const otherSide: MatchSide = vetoTeamSide === 'left' ? 'right' : 'left'

    if (veto.side === 'CT') {
      ctSide = vetoTeamSide
      tSide = otherSide
    } else {
      ctSide = otherSide
      tSide = vetoTeamSide
    }
  }

  if (veto?.reverseSide) {
    ;[ctSide, tSide] = [tSide, ctSide]
  }

  return {
    CT: match[ctSide].id,
    T: match[tSide].id
  }
}

const getOverrideData = async (): Promise<GSIOverrideCache> => {
  const now = Date.now()

  if (overrideCache.expiresAt > now) {
    return overrideCache
  }

  let match: Match | null = null
  try {
    match = await matchService.getCurrentMatch()
  } catch {
    match = null
  }

  const teamIds = [match?.left.id, match?.right.id].filter(Boolean) as string[]
  const teams = await Promise.all(teamIds.map((id) => teamService.getTeamById(id)))
  const players = await playerRepo.getPlayers()
  const playersByTeamId = new Map<string, Player[]>()

  for (const player of players) {
    if (!player.team) continue
    const teamPlayers = playersByTeamId.get(player.team) ?? []
    teamPlayers.push(player)
    playersByTeamId.set(player.team, teamPlayers)
  }

  overrideCache = {
    expiresAt: now + 1000,
    match,
    teamsById: new Map(teams.filter(Boolean).map((team) => [team!._id, team!])),
    playersBySteamId: new Map(
      players.filter((player) => player.steamid).map((player) => [player.steamid, player])
    ),
    playersByTeamId
  }

  return overrideCache
}

const buildTeamOverride = (
  existing: any,
  team: Team,
  mapScore: number
): Record<string, unknown> => ({
  ...existing,
  id: team._id,
  name: team.name,
  country: team.country,
  shortName: team.shortName,
  logo: team.logo,
  map_score: mapScore,
  extra: team.extra
})

const getPlayerDisplayName = (player: Player, fallback: string): string =>
  player.username || [player.firstName, player.lastName].filter(Boolean).join(' ') || fallback

const getRawSlotOrder = (player: any): number => {
  const slot = typeof player?.observer_slot === 'number' ? player.observer_slot : 99
  return slot === 0 ? 10 : slot
}

const assignRosterPlayersToSide = (
  entries: [string, any][],
  roster: Player[],
  matchedPlayerIds: Set<string>
): Map<string, Player> => {
  const assignments = new Map<string, Player>()
  const availablePlayers = roster.filter((player) => !matchedPlayerIds.has(player._id))
  const sortedEntries = [...entries].sort(([, a], [, b]) => getRawSlotOrder(a) - getRawSlotOrder(b))

  sortedEntries.forEach(([steamid], index) => {
    const player = availablePlayers[index]
    if (!player) return
    assignments.set(steamid, player)
    matchedPlayerIds.add(player._id)
  })

  return assignments
}

const applyMatchOverrides = async (data: CSGORaw): Promise<CSGORaw> => {
  const allplayers = (data as any)?.allplayers
  const { match, teamsById, playersBySteamId, playersByTeamId } = await getOverrideData()

  if (!match) {
    GSI.players = []
    playerOverrideByRawSteamId = new Map()
    return data
  }

  let nextData: any = data
  const mapName = getShortMapName((data as any)?.map?.name)
  const currentVeto = getCurrentMapVeto(match, mapName)
  const sideTeamIds = getSideTeamIds(match, currentVeto)
  const matchedPlayerIds = new Set<string>()
  const steamAssignments = new Map<string, Player>()
  const rosterAssignments = new Map<string, Player>()

  if (allplayers) {
    for (const [steamid, player] of Object.entries(allplayers) as [string, any][]) {
      const steamPlayer = playersBySteamId.get(steamid)
      if (steamPlayer) {
        steamAssignments.set(steamid, steamPlayer)
        matchedPlayerIds.add(steamPlayer._id)
        continue
      }

      const teamId =
        player.team === 'CT' ? sideTeamIds.CT : player.team === 'T' ? sideTeamIds.T : null
      const roster = teamId ? (playersByTeamId.get(teamId) ?? []) : []
      const nameMatch = roster.find(
        (rosterPlayer) =>
          getPlayerDisplayName(rosterPlayer, '').toLocaleLowerCase() ===
          String(player.name ?? '').toLocaleLowerCase()
      )

      if (nameMatch && !matchedPlayerIds.has(nameMatch._id)) {
        rosterAssignments.set(steamid, nameMatch)
        matchedPlayerIds.add(nameMatch._id)
      }
    }

    for (const side of ['CT', 'T'] as const) {
      const teamId = sideTeamIds[side]
      if (!teamId) continue
      const sideEntries = (Object.entries(allplayers) as [string, any][]).filter(
        ([steamid, player]) =>
          player.team === side && !playersBySteamId.has(steamid) && !rosterAssignments.has(steamid)
      )
      const sideAssignments = assignRosterPlayersToSide(
        sideEntries,
        playersByTeamId.get(teamId) ?? [],
        matchedPlayerIds
      )
      sideAssignments.forEach((player, steamid) => rosterAssignments.set(steamid, player))
    }
  }

  const overridePlayers = new Map([...steamAssignments, ...rosterAssignments])
  playerOverrideByRawSteamId = new Map(overridePlayers)

  GSI.players = Array.from(overridePlayers.entries()).map(([steamid, player]) => ({
    id: player._id,
    steamid,
    name: getPlayerDisplayName(player, ''),
    realName: [player.firstName, player.lastName].filter(Boolean).join(' ') || null,
    country: player.country || null,
    avatar: player.avatar || null,
    extra: player.extra
  }))

  if ((data as any)?.map) {
    const ctTeamId = sideTeamIds.CT
    const tTeamId = sideTeamIds.T
    const ctTeam = ctTeamId ? teamsById.get(ctTeamId) : null
    const tTeam = tTeamId ? teamsById.get(tTeamId) : null

    nextData = {
      ...nextData,
      map: {
        ...(data as any).map,
        ...(ctTeam
          ? {
              team_ct: buildTeamOverride(
                (data as any).map.team_ct,
                ctTeam,
                ctTeamId === match.left.id ? match.left.wins : match.right.wins
              )
            }
          : {}),
        ...(tTeam
          ? {
              team_t: buildTeamOverride(
                (data as any).map.team_t,
                tTeam,
                tTeamId === match.left.id ? match.left.wins : match.right.wins
              )
            }
          : {})
      }
    }
  }

  if (allplayers && overridePlayers.size > 0) {
    nextData = {
      ...nextData,
      allplayers: Object.fromEntries(
        Object.entries(allplayers).map(([steamid, player]: [string, any]) => {
          const dbPlayer = overridePlayers.get(steamid)
          if (!dbPlayer) return [steamid, player]

          const displayName = getPlayerDisplayName(dbPlayer, player.name)

          return [
            steamid,
            {
              ...player,
              steamid: dbPlayer.steamid || steamid,
              name: displayName,
              firstName: dbPlayer.firstName,
              lastName: dbPlayer.lastName,
              username: dbPlayer.username,
              avatar: dbPlayer.avatar,
              country: dbPlayer.country,
              teamId: dbPlayer.team,
              isCoach: dbPlayer.isCoach,
              extra: dbPlayer.extra
            }
          ]
        })
      )
    }
  }

  return nextData
}

// Spectator slot map
// Populated via PUT /api/spectator/slots from the Spectator Binds page
let nameToSlot: Map<string, number> = new Map()

export const setSpectatorSlots = (slots: Record<number, string>): void => {
  nameToSlot = new Map()
  for (const [slot, name] of Object.entries(slots)) {
    if (name) nameToSlot.set(name, Number(slot) === 10 ? 0 : Number(slot))
  }
}

export const setupGSI = (io: Server) => {
  const router = Router()

  // Sync teams whenever the map changes (reverseSide may differ per map)
  GSI.on('data', (data) => {
    const prevMap = GSI.last?.map?.name
    const nextMap = data.map?.name
    if (nextMap && nextMap !== prevMap) {
      syncGSITeams()
    }
  })

  // Halftime Logic: flip reverseSide on the current map veto so team sides stay correct.
  // Overtime intermissions should not always flip sides
  GSI.on('intermissionEnd', async () => {
    try {
      const settings = await getSettings()
      if (!settings.autoSwitchSides) {
        console.log('[GSI] autoSwitchSides disabled — skipping halftime flip')
        return
      }

      const match = await matchService.getCurrentMatch()
      if (!match || !GSI.last) return

      const totalScore = GSI.last.map.team_ct.score + GSI.last.map.team_t.score
      const regulationTotal = GSI.regulationMR * 2 // 24
      const otPeriod = GSI.overtimeMR * 2 // 6

      // Skip reversing sides when going into a new OT period
      // e.g. 24, 30, 36: Sides are the same going into each new OT
      const isOvertimeEntry =
        totalScore >= regulationTotal && (totalScore - regulationTotal) % otPeriod === 0

      if (isOvertimeEntry) {
        console.log(`[GSI] Overtime entry (score ${totalScore}) — skipping reverseSide flip`)
        return
      }

      const mapName = GSI.last.map.name.substring(GSI.last.map.name.lastIndexOf('/') + 1)
      const updatedVetos = match.vetos.map((veto) =>
        veto.mapName === mapName ? { ...veto, reverseSide: !veto.reverseSide } : veto
      )

      await matchService.updateMatch(match.id, { vetos: updatedVetos })
      await syncGSITeams()
      io.emit('match')
      console.log(`[GSI] Halftime — flipped reverseSide for map: ${mapName}`)
    } catch (err) {
      console.error('[GSI] intermissionEnd error:', err)
    }
  })

  // Map end logic: record final score, winner, mapEnd flag, and increment series wins
  GSI.on('matchEnd', async (score: Score) => {
    try {
      const match = await matchService.getCurrentMatch()
      if (!match) return

      const mapName = score.map.name.substring(score.map.name.lastIndexOf('/') + 1)
      const isReversed = match.vetos.some((v) => v.mapName === mapName && v.reverseSide)

      const ctId = score.map.team_ct.id
      const tId = score.map.team_t.id
      const ctScore = score.map.team_ct.score
      const tScore = score.map.team_t.score

      const updatedVetos = match.vetos.map((veto) => {
        if (veto.mapName !== mapName || !ctId || !tId) return veto

        // Determine winner based on score and reverseSide
        const ctWon = ctScore > tScore
        const winnerSideId = ctWon ? ctId : tId
        const winnerTeamId = isReversed
          ? ctWon
            ? tId
            : ctId // reversed: CT in-game = T in database
          : winnerSideId

        return {
          ...veto,
          winner: winnerTeamId,
          mapEnd: true,
          score: isReversed
            ? { [ctId]: tScore, [tId]: ctScore } // swap scores back to match DB orientation
            : { [ctId]: ctScore, [tId]: tScore }
        }
      })

      // TODO: Verify this logic and if we need to actually utilize sync teams
      // TODO: Spectator binds also may also lead to bugs with this.

      // Increment series wins for the correct side
      let { left, right } = match
      const winnerId = score.winner.id
      if (winnerId === match.left.id) {
        left = { ...left, wins: left.wins + (isReversed ? 0 : 1) }
        right = { ...right, wins: right.wins + (isReversed ? 1 : 0) }
      } else if (winnerId === match.right.id) {
        right = { ...right, wins: right.wins + (isReversed ? 0 : 1) }
        left = { ...left, wins: left.wins + (isReversed ? 1 : 0) }
      }

      await matchService.updateMatch(match.id, { vetos: updatedVetos, left, right })
      await syncGSITeams()
      io.emit('match')
      console.log(`[GSI] Map ended: ${mapName} — winner: ${score.winner.name}`)
    } catch (err) {
      console.error('[GSI] matchEnd error:', err)
    }
  })

  // Round end logic: record per-round player stats and win type into the active veto
  GSI.on('roundEnd', async (score: Score) => {
    try {
      if (!GSI.current) return

      const getWinType = (outcome: string): RoundData['win_type'] => {
        switch (outcome) {
          case 'ct_win_defuse':
            return 'defuse'
          case 'ct_win_time':
            return 'time'
          case 't_win_bomb':
            return 'bomb'
          case 'ct_win_elimination':
          case 't_win_elimination':
            return 'elimination'
          default:
            return 'time'
        }
      }

      // At roundEnd, map.round is the round that just completed
      const roundNumber = score.map.round
      const roundOutcome = score.map.round_wins?.[roundNumber]

      const roundData: RoundData = {
        round: roundNumber,
        winner: score.winner.side,
        win_type: roundOutcome ? getWinType(roundOutcome) : 'elimination',
        players: Object.fromEntries(
          GSI.current.players.map((p) => [
            p.steamid,
            {
              kills: p.state.round_kills,
              killshs: p.state.round_killhs,
              damage: p.state.round_totaldmg
            }
          ])
        )
      }

      const match = await matchService.getCurrentMatch()
      if (!match) return

      const mapName = score.map.name.substring(score.map.name.lastIndexOf('/') + 1)
      const veto = match.vetos.find((v) => v.mapName === mapName && !v.mapEnd)
      if (!veto) return

      // Skip if this round's data hasn't changed
      const existing = veto.rounds?.[roundNumber - 1]
      if (existing && JSON.stringify(existing) === JSON.stringify(roundData)) return

      const updatedVetos = match.vetos.map((v) => {
        if (v.mapName !== mapName) return v
        const rounds = [...(v.rounds ?? [])]
        rounds[roundNumber - 1] = roundData
        return { ...v, rounds: rounds.slice(0, roundNumber) }
      })

      await matchService.updateMatch(match.id, { vetos: updatedVetos })
      io.emit('match')
    } catch (err) {
      console.error('[GSI] roundEnd error:', err)
    }
  })

  // --- GSI HTTP endpoint ---
  router.post('/input', async (req: Request, res: Response) => {
    try {
      const overwriteGSIFromMatch = await getOverwriteGSIFromMatchSetting()
      let gsiData = overwriteGSIFromMatch ? await applyMatchOverrides(req.body) : req.body
      if (!overwriteGSIFromMatch) {
        GSI.players = []
        playerOverrideByRawSteamId = new Map()
      }

      // --- Dead player position preservation ---
      // Cache: steamid -> last death position
      if (!global.deadPlayerPositions) global.deadPlayerPositions = {}
      const deadPlayerPositions = global.deadPlayerPositions

      if ((gsiData as any)?.allplayers) {
        for (const steamid of Object.keys((gsiData as any).allplayers)) {
          const player = (gsiData as any).allplayers[steamid]

          // Player is dead
          if (player.state && player.state.health === 0) {
            // If not already cached, cache their current position
            if (!deadPlayerPositions[steamid]) {
              deadPlayerPositions[steamid] = player.position
            }

            // Overwrite position with cached death position
            player.position = deadPlayerPositions[steamid]
          } else {
            // Player is alive, clear cache
            if (deadPlayerPositions[steamid]) {
              delete deadPlayerPositions[steamid]
            }
          }
        }
      }
      // Fix player observer_slot: CS2 raw data sends 0–10 but HUDs expect 1–10 with 10 wrapping to 0
      if ((gsiData as any)?.allplayers) {
        for (const key of Object.keys((gsiData as any).allplayers)) {
          const player = (gsiData as any).allplayers[key]
          if (typeof player?.observer_slot === 'number') {
            player.observer_slot = player.observer_slot + 1 === 10 ? 0 : player.observer_slot + 1
          }
        }
      }

      lastGSIState = gsiData

      // Build payload for for HUDs
      let hudPayload = gsiData
      const needsCoachFilter = (gsiData as any)?.allplayers && coachSteamIds.size > 0
      const needsSlotRemap = (gsiData as any)?.allplayers && nameToSlot.size > 0

      if (needsCoachFilter || needsSlotRemap) {
        let remapped = { ...(gsiData as any).allplayers }

        // Remove coaches
        if (needsCoachFilter) {
          for (const steamid of Object.keys(remapped)) {
            if (coachSteamIds.has(steamid)) delete remapped[steamid]
          }
        }

        // Remap observer_slot values to match custom slot assignments
        if (needsSlotRemap) {
          for (const steamid of Object.keys(remapped)) {
            const player = remapped[steamid]
            if (player?.name && nameToSlot.has(player.name)) {
              remapped[steamid] = { ...player, observer_slot: nameToSlot.get(player.name) }
            }
          }

          // Rebuild allplayers sorted by the new observer_slot
          const slotOrder = (s: number) => (s === 0 ? 10 : s)
          remapped = Object.fromEntries(
            Object.entries(remapped).sort(([, a], [, b]) => {
              const aSlot = (a as any)?.observer_slot ?? 99
              const bSlot = (b as any)?.observer_slot ?? 99
              return slotOrder(aSlot) - slotOrder(bSlot)
            })
          )
        }

        hudPayload = { ...(gsiData as any), allplayers: remapped }
      }

      // Feed raw payload into CSGOGSI so backend listeners fire
      GSI.digest(gsiData)

      // Vue UI gets the full payload (coaches visible in LiveView)
      io.except('huds').emit('update', gsiData)
      // HUDs get filtered payload
      io.to('huds').emit('update', hudPayload)

      const activeMapName = getShortMapName((hudPayload as any)?.map?.name)
      const shouldRefreshHudMatch =
        pendingHudMatchRefreshes > 0 ||
        (activeMapName !== null && activeMapName !== lastHudMatchRefreshMapName)

      if (shouldRefreshHudMatch) {
        if (pendingHudMatchRefreshes > 0) pendingHudMatchRefreshes -= 1
        lastHudMatchRefreshMapName = activeMapName
        io.to('huds').emit('match')
      }

      // CS2 expects a 200 OK so it doesn't throttle the GSI engine
      res.status(200).send('OK')
    } catch (error) {
      console.error('Error broadcasting GSI data:', error)
      res.status(500).send('Error')
    }
  })

  // Populate coach filter and Sync team data on startup
  syncGSITeams()
  syncCoaches()

  return router
}
