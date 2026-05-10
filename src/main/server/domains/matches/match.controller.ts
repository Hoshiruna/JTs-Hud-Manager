import { Request, Response } from 'express'
import { MatchService } from './match.service'
import { getLastGSIState } from '../../integrations/gsi'
import { Match, Veto } from './match.types'

const matchService = new MatchService()

type MatchSide = 'left' | 'right'

const getShortMapName = (mapName: string | undefined): string | null => {
  if (!mapName) return null
  return mapName.substring(mapName.lastIndexOf('/') + 1)
}

const getSideTeamIds = (match: Match, veto: Veto): Record<'CT' | 'T', string | null> => {
  let ctSide: MatchSide = 'left'
  let tSide: MatchSide = 'right'

  if (veto.side && veto.side !== 'NO' && veto.teamId) {
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

  if (veto.reverseSide) {
    ;[ctSide, tSide] = [tSide, ctSide]
  }

  return {
    CT: match[ctSide].id,
    T: match[tSide].id
  }
}

const getVisualSideByGameSide = (allplayers: any): Record<'CT' | 'T', MatchSide> | null => {
  if (!allplayers) return null

  const tPlayer = Object.values(allplayers).find(
    (player: any) => player?.observer_slot !== undefined && player?.team === 'T'
  ) as any
  const ctPlayer = Object.values(allplayers).find(
    (player: any) => player?.observer_slot !== undefined && player?.team === 'CT'
  ) as any

  if (!ctPlayer || !tPlayer) return null

  const isCTLeft = !((ctPlayer.observer_slot || 10) > (tPlayer.observer_slot || 10))

  return {
    CT: isCTLeft ? 'left' : 'right',
    T: isCTLeft ? 'right' : 'left'
  }
}

const getHudReverseSide = (match: Match, veto: Veto): boolean => {
  const lastGSIState = getLastGSIState()
  const activeMapName = getShortMapName((lastGSIState as any)?.map?.name)
  if (!activeMapName || activeMapName !== veto.mapName) return Boolean(veto.reverseSide)

  const visualSideByGameSide = getVisualSideByGameSide((lastGSIState as any)?.allplayers)
  if (!visualSideByGameSide) return Boolean(veto.reverseSide)

  const sideTeamIds = getSideTeamIds(match, veto)
  const leftTeamGameSide =
    sideTeamIds.CT === match.left.id ? 'CT' : sideTeamIds.T === match.left.id ? 'T' : null
  if (!leftTeamGameSide) return Boolean(veto.reverseSide)

  return visualSideByGameSide[leftTeamGameSide] === 'right'
}

const toHudMatch = (match: Match | null): Match | null => {
  if (!match) return match

  return {
    ...match,
    vetos: match.vetos.map((veto) => ({
      ...veto,
      reverseSide: getHudReverseSide(match, veto)
    }))
  }
}

export const getMatches = async (_req: Request, res: Response) => {
  try {
    const matches = await matchService.getAllMatches()
    res.json(matches)
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
}

export const getCurrentMatch = async (_req: Request, res: Response) => {
  try {
    const match = await matchService.getCurrentMatch()
    res.json(toHudMatch(match))
  } catch (error: any) {
    res.status(404).json({ error: error.message })
  }
}

export const getMatchById = async (req: Request, res: Response) => {
  try {
    const match = await matchService.getMatchById(req.params.id as string)
    res.json(match)
  } catch (error: any) {
    res.status(404).json({ error: error.message })
  }
}

export const createMatch = async (req: Request, res: Response) => {
  try {
    const match = await matchService.createMatch(req.body)
    res.status(201).json(match)
  } catch (error: any) {
    res.status(400).json({ error: error.message })
  }
}

export const updateMatch = async (req: Request, res: Response) => {
  try {
    const match = await matchService.updateMatch(req.params.id as string, req.body)
    res.json(match)
  } catch (error: any) {
    res.status(400).json({ error: error.message })
  }
}

export const deleteMatch = async (req: Request, res: Response) => {
  try {
    await matchService.deleteMatch(req.params.id as string)
    res.status(204).send()
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
}

export const toggleReverseSide = async (req: Request, res: Response) => {
  try {
    const match = await matchService.toggleVetoReverseSide(req.params.mapName as string)
    res.json(match)
  } catch (error: any) {
    res.status(400).json({ error: error.message })
  }
}
