import { Router } from 'express'
import { Server } from 'socket.io'
import { upload } from '../../utils/multer'
import {
  getTeams,
  getTeamLogo,
  getTeamById,
  createTeam,
  updateTeam,
  deleteTeam
} from './team.controller'
import { syncGSITeams } from '../../integrations/gsi'

export default function createTeamRouter(io: Server) {
  const router = Router()

  const notifyTeamChange = () => {
    io.emit('match')
    syncGSITeams()
  }

  router.get('/', getTeams)
  router.get('/logo/:id', getTeamLogo) // must be before /:id to avoid conflict
  router.get('/:id', getTeamById)
  router.post('/', upload.single('logo'), async (req, res) => {
    await createTeam(req, res)
    if (res.statusCode < 400) notifyTeamChange()
  })
  router.put('/:id', upload.single('logo'), async (req, res) => {
    await updateTeam(req, res)
    if (res.statusCode < 400) notifyTeamChange()
  })
  router.delete('/:id', async (req, res) => {
    await deleteTeam(req, res)
    if (res.statusCode < 400) notifyTeamChange()
  })

  return router
}
