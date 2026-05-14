import { ref } from 'vue'
import { API_URL } from '../../../index'

export interface AppSettings {
  autoSwitchSides: boolean
  overwriteGSIFromMatch: boolean
  gsiPlayerOverlayMode: boolean
  telnetHost: string
  telnetPort: number
}

export function useSettings() {
  const settings = ref<AppSettings>({
    autoSwitchSides: true,
    overwriteGSIFromMatch: false,
    gsiPlayerOverlayMode: false,
    telnetHost: '127.0.0.1',
    telnetPort: 2020
  })
  const isLoading = ref(false)
  const isSaving = ref(false)

  const fetchSettings = async () => {
    isLoading.value = true
    try {
      const res = await fetch(`${API_URL}/settings`)
      if (res.ok) settings.value = await res.json()
    } catch (err) {
      console.error('Failed to fetch settings:', err)
    } finally {
      isLoading.value = false
    }
  }

  const saveSettings = async (updates: Partial<AppSettings>) => {
    isSaving.value = true
    try {
      const res = await fetch(`${API_URL}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      })
      if (res.ok) settings.value = await res.json()
    } catch (err) {
      console.error('Failed to save settings:', err)
    } finally {
      isSaving.value = false
    }
  }

  return { settings, isLoading, isSaving, fetchSettings, saveSettings }
}
