import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useMatches } from './useMatches'
import { useTeams } from '../../teams/composables/useTeams'
import { useSettings } from '../../settings/composables/useSettings'

const TABLE_HEADERS = [
  { key: 'matchup', label: 'Matchup' },
  { key: 'matchType', label: 'Type' },
  { key: 'score', label: 'Series Score' }
]

export function useMatchesView() {
  const router = useRouter()
  const { matches, isLoading, fetchMatches, deleteMatch, toggleCurrent } = useMatches()
  const { teams: availableTeams, fetchTeams } = useTeams()
  const { settings, isSaving: isSavingSettings, fetchSettings, saveSettings } = useSettings()

  const teamMap = computed(() => {
    const map: Record<string, { logo: string; name: string }> = {}
    for (const t of availableTeams.value) map[t._id] = { logo: t.logo, name: t.name }
    return map
  })

  const getTeamLogo = (teamId: string | null): string | null => {
    if (!teamId) return null
    const team = teamMap.value[teamId]
    return team?.logo ? team.logo : null
  }

  const openEdit = (match: any) => {
    router.push(`/matches/${match._id || match.id}/edit`)
  }

  const openCreate = () => {
    router.push('/matches/new')
  }

  onMounted(() => {
    fetchMatches()
    fetchTeams()
    fetchSettings()
  })

  const toggleGSIOverwrite = async () => {
    await saveSettings({
      overwriteGSIFromMatch: !settings.value.overwriteGSIFromMatch,
      gsiPlayerOverlayMode: settings.value.overwriteGSIFromMatch
        ? false
        : settings.value.gsiPlayerOverlayMode
    })
  }

  return {
    matches,
    isLoading,
    settings,
    isSavingSettings,
    tableHeaders: TABLE_HEADERS,
    getTeamLogo,
    deleteMatch,
    toggleCurrent,
    toggleGSIOverwrite,
    openEdit,
    openCreate
  }
}
