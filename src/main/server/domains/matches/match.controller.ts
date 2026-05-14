import { Request, Response } from 'express'
import { MatchService } from './match.service'
import { Match, Veto } from './match.types'
import { getSettings } from '../settings/settings.routes'

const matchService = new MatchService()

type HudVeto = Veto & {
  /**
   * Effective side state for HUDs that want side-aware colors without moving
   * fixed match teams between left and right positions.
   */
  hudReverseSide: boolean
  leftSide: 'CT' | 'T' | null
  rightSide: 'CT' | 'T' | null
}

type HudMatch = Omit<Match, 'vetos'> & {
  vetos: HudVeto[]
  gsiPlayerOverlayMode: boolean
}

const getVetoSides = (
  match: Match,
  veto: Veto,
  reverseSide: boolean,
  enableGsiSideOverride: boolean
): Pick<HudVeto, 'leftSide' | 'rightSide'> => {
  if (
    enableGsiSideOverride &&
    veto.gsiSideOverride &&
    (veto.gsiLeftSide === 'CT' || veto.gsiLeftSide === 'T')
  ) {
    const leftSide =
      reverseSide && veto.gsiLeftSide === 'CT'
        ? 'T'
        : reverseSide && veto.gsiLeftSide === 'T'
          ? 'CT'
          : veto.gsiLeftSide
    return {
      leftSide,
      rightSide: leftSide === 'CT' ? 'T' : 'CT'
    }
  }

  if (!veto.teamId || veto.side === 'NO') {
    return { leftSide: null, rightSide: null }
  }

  const vetoTeamSide = veto.teamId === match.right.id ? 'right' : 'left'
  const otherTeamSide = vetoTeamSide === 'left' ? 'right' : 'left'
  const sides: Pick<HudVeto, 'leftSide' | 'rightSide'> = {
    leftSide: null,
    rightSide: null
  }

  sides[vetoTeamSide === 'left' ? 'leftSide' : 'rightSide'] = veto.side
  sides[otherTeamSide === 'left' ? 'leftSide' : 'rightSide'] = veto.side === 'CT' ? 'T' : 'CT'

  if (reverseSide) {
    ;[sides.leftSide, sides.rightSide] = [sides.rightSide, sides.leftSide]
  }

  return sides
}

const toHudMatch = (match: Match | null, enableGsiSideOverride: boolean): HudMatch | null => {
  if (!match) return match

  return {
    ...match,
    gsiPlayerOverlayMode: false,
    vetos: match.vetos.map((veto) => {
      const fallbackHudReverseSide = Boolean(veto.reverseSide)
      const { leftSide, rightSide } = getVetoSides(
        match,
        veto,
        fallbackHudReverseSide,
        enableGsiSideOverride
      )
      const hudReverseSide = leftSide ? leftSide === 'T' : fallbackHudReverseSide

      return {
        ...veto,
        hudReverseSide,
        leftSide,
        rightSide,
        // Keep matchbar team identity fixed in match order. HUDs that need the
        // effective side swap for colors should use hudReverseSide/leftSide/rightSide.
        reverseSide: false
      }
    })
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
    const [match, settings] = await Promise.all([matchService.getCurrentMatch(), getSettings()])
    const hudMatch = toHudMatch(match, settings.overwriteGSIFromMatch)
    if (hudMatch) {
      hudMatch.gsiPlayerOverlayMode =
        settings.overwriteGSIFromMatch && settings.gsiPlayerOverlayMode
    }
    res.json(hudMatch)
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
