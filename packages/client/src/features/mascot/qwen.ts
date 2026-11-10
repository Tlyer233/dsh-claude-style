import { QWEN_FRAME_MS, QWEN_SHEETS } from './sheets'
import { createMascotPlayer } from './mascot-player'
import { createRoutedSheetAdapter } from './routed-sheets'
import { QWEN_SHEET_URLS } from 'virtual:dsh-claude-style/generated'
import type { HostContext } from '@dsh-claude-style/engine/host'
import type { FeatureUi } from '../../core/feature'
import type manifest from './mascot.manifest'

/**
 * Qwen, the blue-haired girl of the Qwen pack, as a mascot character
 * (packages/client/src/features/mascot/mascot-player.ts plays her; packages/client/src/features/mascot/
 * mascot.ts decides which mascot is out).
 *
 * Her animations share the other characters' keys, so the one state machine
 * drives all five (QWEN_SHEETS). The sheets are served from the host half
 * and fetched the first time an animation is wanted (routed-sheets.ts), so
 * the deferred mascot chunk carries no art.
 *
 * @param ui - shared handle table (`ui.composer`).
 * @returns `{ sync, release, onActivity, dispose }`.
 */
export function createMascotQwen(ctx: HostContext, ui: FeatureUi<typeof manifest>) {
  return createMascotPlayer(ctx, ui, {
    name: 'qwen',
    sheets: QWEN_SHEETS,
    frameMs: QWEN_FRAME_MS,
    extras: ['idle-look', 'idle-spout'],
    pingpongLoops: true,
    patientInteractions: true,
    landingKey: 'landing',
    poseMatching: true,
    cellScale: 4,
    createSheets: createRoutedSheetAdapter(QWEN_SHEET_URLS, 'Qwen'),
  })
}
