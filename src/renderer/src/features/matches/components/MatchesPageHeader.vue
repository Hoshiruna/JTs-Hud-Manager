<script setup lang="ts">
import BaseButton from '../../../components/base/BaseButton.vue'

defineProps<{
  overwriteGSIFromMatch: boolean
  isSavingSettings: boolean
}>()

defineEmits<{
  create: []
  toggleGSIOverwrite: []
}>()
</script>

<template>
  <div class="flex justify-between items-center mb-6">
    <div>
      <h1 class="text-2xl font-bold text-text-main tracking-tight">Matches</h1>
      <p class="text-zinc-400 text-sm mt-1">Manage all matches in the database.</p>
    </div>
    <div class="flex gap-3">
      <BaseButton
        :variant="overwriteGSIFromMatch ? 'primary' : 'secondary'"
        :disabled="isSavingSettings"
        @click="$emit('toggleGSIOverwrite')"
      >
        <span
          class="w-2 h-2 rounded-full"
          :class="overwriteGSIFromMatch ? 'bg-emerald-300' : 'bg-zinc-500'"
        />
        GSI Overwrite {{ overwriteGSIFromMatch ? 'On' : 'Off' }}
      </BaseButton>
      <BaseButton variant="primary" @click="$emit('create')">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          class="w-4 h-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
        </svg>
        Create Match
      </BaseButton>
    </div>
  </div>
</template>
