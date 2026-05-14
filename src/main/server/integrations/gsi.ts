import { CSGOGSI, CSGORaw, Score } from 'csgogsi'
import { Router, Request, Response } from 'express'
import { Server } from 'socket.io'
import { MatchService } from '../domains/matches/match.service'
import { TeamService } from '../domains/teams/team.service'
import { PlayerRepository } from '../domains/players/player.repository'
import { Player } from '../domains/players/player.types'
import { getSettings } from '../domains/settings/settings.routes'
import { RoundData } from '../domains/matches/match.types'

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
let socketServer: Server | null = null
let playerOverlayCacheKey = ''
let playerOverlayAssignments = new Map<string, Player>()
let playerOverlayOrientations = new Map<string, MatchOrientation>()
let playerOverlayDisplaySlots = new Map<string, number>()
let overriddenPlayersBySteamId = new Map<string, Player>()

export const getLastGSIState = (): CSGORaw | null => lastGSIState

export const requestHudMatchRefresh = (): void => {
  socketServer?.emit('match')
}

export const getOverriddenPlayerBySteamId = (steamid: string): Player | null => {
  return overriddenPlayersBySteamId.get(steamid) || null
}

type MatchOrientation = 'left' | 'right'
type GameSide = 'CT' | 'T'

const normalizeMapName = (mapName: string): string =>
  mapName.substring(mapName.lastIndexOf('/') + 1).toLowerCase().replace(/^de_/, '')

const getObserverSlotOrder = (player: any): number => {
  const slot = typeof player?.observer_slot === 'number' ? player.observer_slot : 99
  return slot === 0 ? 10 : slot
}

const getObserverSlot = (player: any): number | null =>
  typeof player?.observer_slot === 'number' ? player.observer_slot : null

const getOppositeSide = (side: GameSide): GameSide => (side === 'CT' ? 'T' : 'CT')

const getActiveVeto = (match: Awaited<ReturnType<MatchService['getCurrentMatch']>>, mapName: string) => {
  if (!match?.vetos) return null
  const activeMap = normalizeMapName(mapName)
  return match.vetos.find((veto) => normalizeMapName(veto.mapName) === activeMap) || null
}

const getLeftGameSide = (
  match: Awaited<ReturnType<MatchService['getCurrentMatch']>>,
  veto: ReturnType<typeof getActiveVeto>
): GameSide | null => {
  if (!match || !veto) {
    return null
  }

  if (veto.gsiSideOverride && (veto.gsiLeftSide === 'CT' || veto.gsiLeftSide === 'T')) {
    return veto.reverseSide ? getOppositeSide(veto.gsiLeftSide) : veto.gsiLeftSide
  }

  if (!veto.teamId || veto.side === 'NO') {
    return null
  }

  const vetoTeamOrientation: MatchOrientation = veto.teamId === match.right.id ? 'right' : 'left'
  const leftSide =
    vetoTeamOrientation === 'left' ? veto.side : getOppositeSide(veto.side as GameSide)

  return veto.reverseSide ? getOppositeSide(leftSide) : leftSide
}

const getLeftStartingSide = (
  match: Awaited<ReturnType<MatchService['getCurrentMatch']>>,
  veto: ReturnType<typeof getActiveVeto>
): GameSide | null => {
  if (!match || !veto) {
    return null
  }

  if (veto.gsiSideOverride && (veto.gsiLeftSide === 'CT' || veto.gsiLeftSide === 'T')) {
    return veto.gsiLeftSide
  }

  if (!veto.teamId || veto.side === 'NO') {
    return null
  }

  const vetoTeamOrientation: MatchOrientation = veto.teamId === match.right.id ? 'right' : 'left'
  return vetoTeamOrientation === 'left' ? veto.side : getOppositeSide(veto.side as GameSide)
}

const getRosterByTeam = async (teamId: string | null): Promise<Player[]> => {
  if (!teamId) return []
  const players = await playerRepo.getPlayers()
  return players.filter((player) => player.team === teamId && !player.isCoach)
}

const assignRosterPlayers = (
  rawPlayers: [string, any][],
  roster: Player[],
  orientation: MatchOrientation,
  assignments: Map<string, Player>,
  orientations: Map<string, MatchOrientation>,
  displaySlots: Map<string, number>
) => {
  const sidePlayers = rawPlayers
    .filter(([, player]) => player.__matchOrientation === orientation)
    .sort(([, a], [, b]) => {
      const aIndex = typeof a.__displayIndex === 'number' ? a.__displayIndex : getObserverSlotOrder(a)
      const bIndex = typeof b.__displayIndex === 'number' ? b.__displayIndex : getObserverSlotOrder(b)
      return aIndex - bIndex
    })

  sidePlayers.forEach(([steamid, player], fallbackIndex) => {
    const index =
      typeof player.__displayIndex === 'number' ? player.__displayIndex : fallbackIndex
    if (!orientations.has(steamid)) {
      orientations.set(steamid, orientation)
    }
    if (!assignments.has(steamid) && roster[index]) {
      assignments.set(steamid, roster[index])
    }
    if (!displaySlots.has(steamid)) {
      displaySlots.set(steamid, getDisplayObserverSlot(orientation, index))
    }
  })
}

const getDisplayObserverSlot = (orientation: MatchOrientation, index: number): number => {
  if (orientation === 'left') return index + 1
  const slot = index + 6
  return slot === 10 ? 0 : slot
}

type OverlayPlayerPayload = NonNullable<CSGORaw['allplayers']>[string] & {
  __matchOrientation?: MatchOrientation
  __displayIndex?: number
  avatar?: string
  country?: string
  extra?: Record<string, string>
  firstName?: string
  isCoach?: boolean
  lastName?: string
  realName?: string
  teamId?: string | null
  username?: string
  displayName?: string
  displayAvatar?: string
  displayTeamId?: string | null
  displaySide?: GameSide
  displayOrientation?: MatchOrientation
  displayObserverSlot?: number
}

const getConfiguredPlayerSlot = (
  veto: ReturnType<typeof getActiveVeto>,
  slot: number | null
): { orientation: MatchOrientation; index: number } | null => {
  if (slot === null || !veto?.gsiPlayerSlots) return null
  const leftIndex = veto.gsiPlayerSlots.left?.indexOf(slot) ?? -1
  if (leftIndex >= 0) return { orientation: 'left', index: leftIndex }

  const rightIndex = veto.gsiPlayerSlots.right?.indexOf(slot) ?? -1
  if (rightIndex >= 0) return { orientation: 'right', index: rightIndex }

  return null
}

const getPhysicalSlotIndex = (slot: number): number => {
  if (slot >= 1 && slot <= 5) return slot - 1
  if (slot >= 6 && slot <= 9) return slot - 6
  return 4
}

const applyPlayerOverlayMode = async (payload: CSGORaw): Promise<CSGORaw> => {
  const settings = await getSettings()
  if (!settings.overwriteGSIFromMatch || !settings.gsiPlayerOverlayMode || !payload?.allplayers) {
    overriddenPlayersBySteamId = new Map()
    return payload
  }

  const match = await matchService.getCurrentMatch()
  const activeVeto = getActiveVeto(match, payload.map?.name || '')
  const leftSide = getLeftGameSide(match, activeVeto)
  const leftStartingSide = getLeftStartingSide(match, activeVeto)
  if (!match || !activeVeto || !leftSide || !leftStartingSide) {
    overriddenPlayersBySteamId = new Map()
    return payload
  }

  const rightSide = getOppositeSide(leftSide)
  const rawPlayers = Object.entries(payload.allplayers)
    .map(([steamid, player]) => {
      const physicalSlot = getObserverSlot(player)
      const configuredSlot = getConfiguredPlayerSlot(activeVeto, physicalSlot)
      const isPhysicalCtSlot = getObserverSlotOrder(player) <= 5
      const orientation: MatchOrientation =
        configuredSlot?.orientation ??
        (isPhysicalCtSlot === (leftStartingSide === 'CT') ? 'left' : 'right')
      const displayIndex = configuredSlot?.index ?? getPhysicalSlotIndex(getObserverSlotOrder(player))
      return [
        steamid,
        {
          ...(player as any),
          __matchOrientation: orientation,
          __displayIndex: displayIndex
        }
      ] as [string, any]
    })
    .sort(([, a], [, b]) => getObserverSlotOrder(a) - getObserverSlotOrder(b))

  const cacheKey = `${match.id}:${normalizeMapName(payload.map?.name || '')}`
  if (playerOverlayCacheKey !== cacheKey) {
    const [leftRoster, rightRoster] = await Promise.all([
      getRosterByTeam(match.left.id),
      getRosterByTeam(match.right.id)
    ])
    playerOverlayCacheKey = cacheKey
    playerOverlayAssignments = new Map()
    playerOverlayOrientations = new Map()
    playerOverlayDisplaySlots = new Map()
    assignRosterPlayers(
      rawPlayers,
      leftRoster,
      'left',
      playerOverlayAssignments,
      playerOverlayOrientations,
      playerOverlayDisplaySlots
    )
    assignRosterPlayers(
      rawPlayers,
      rightRoster,
      'right',
      playerOverlayAssignments,
      playerOverlayOrientations,
      playerOverlayDisplaySlots
    )
  }

  overriddenPlayersBySteamId = new Map(playerOverlayAssignments)

  const allplayers = Object.fromEntries(
    rawPlayers.map(([steamid, player]) => {
      const orientation =
        playerOverlayOrientations.get(steamid) || (player.__matchOrientation as MatchOrientation)
      const rosterPlayer = playerOverlayAssignments.get(steamid)
      const side = orientation === 'left' ? leftSide : rightSide
      const displayObserverSlot = playerOverlayDisplaySlots.get(steamid)
      const nextPlayer: OverlayPlayerPayload = { ...player }
      delete nextPlayer.__matchOrientation
      delete nextPlayer.__displayIndex

      nextPlayer.team = side
      nextPlayer.displaySide = side
      nextPlayer.displayOrientation = orientation
      if (typeof displayObserverSlot === 'number') {
        nextPlayer.displayObserverSlot = displayObserverSlot
      }

      if (rosterPlayer) {
        const displayName = rosterPlayer.username || player.name
        const displayAvatar = rosterPlayer.avatar || player.avatar

        nextPlayer.name = displayName
        nextPlayer.realName =
          `${rosterPlayer.firstName || ''} ${rosterPlayer.lastName || ''}`.trim() ||
          rosterPlayer.username ||
          player.realName
        nextPlayer.avatar = displayAvatar
        nextPlayer.country = rosterPlayer.country || player.country
        nextPlayer.teamId = rosterPlayer.team || null
        nextPlayer.username = rosterPlayer.username
        nextPlayer.firstName = rosterPlayer.firstName
        nextPlayer.lastName = rosterPlayer.lastName
        nextPlayer.extra = rosterPlayer.extra
        nextPlayer.isCoach = rosterPlayer.isCoach

        nextPlayer.displayName = displayName
        nextPlayer.displayAvatar = displayAvatar
        nextPlayer.displayTeamId = rosterPlayer.team || null
      }

      return [steamid, nextPlayer]
    })
  )

  return {
    ...payload,
    allplayers
  }
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
  socketServer = io
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
      // --- Dead player position preservation ---
      // Cache: steamid -> last death position
      if (!global.deadPlayerPositions) global.deadPlayerPositions = {}
      const deadPlayerPositions = global.deadPlayerPositions

      if (req.body?.allplayers) {
        for (const steamid of Object.keys(req.body.allplayers)) {
          const player = req.body.allplayers[steamid]

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
      if (req.body?.allplayers) {
        for (const key of Object.keys(req.body.allplayers)) {
          const player = req.body.allplayers[key]
          if (typeof player?.observer_slot === 'number') {
            player.observer_slot = player.observer_slot + 1 === 10 ? 0 : player.observer_slot + 1
          }
        }
      }

      lastGSIState = req.body

      // Build payload for for HUDs
      let hudPayload = req.body
      const needsCoachFilter = req.body?.allplayers && coachSteamIds.size > 0
      const needsSlotRemap = req.body?.allplayers && nameToSlot.size > 0

      if (needsCoachFilter || needsSlotRemap) {
        let remapped = { ...req.body.allplayers }

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

        hudPayload = { ...req.body, allplayers: remapped }
      }

      hudPayload = await applyPlayerOverlayMode(hudPayload)

      // Feed raw payload into CSGOGSI so backend listeners fire
      GSI.digest(req.body)

      // Vue UI gets the full payload (coaches visible in LiveView)
      io.except('huds').emit('update', req.body)
      // HUDs get filtered payload
      io.to('huds').emit('update', hudPayload)

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
