import { CURRENCY_SYMBOL, formatMoneyMicro } from '@dsh-claude-style/contracts/prices'
import { buildElement } from '@dsh-claude-style/engine/dom'
import { copy } from './copy'
import type { SessionCostReading } from '../context-stats/session-stats'
import type { FeatureUi } from '../../core/feature'
import type manifest from './mascot.manifest'

/** The figure a row prints while its amount is unknown: formatMoneyMicro's own dash. */
const DASH = '—'

/** How long the pointer rests on the mascot before the bubble opens. */
const HOVER_DELAY_MS = 250

/**
 * The pixel bubble over the mascot: the shown conversation's cost, quieter.
 *
 * The figure is the one the statistics print (`ui.contextStats.sessionCost`),
 * so the two never disagree, and it is rewritten each time the statistics are;
 * the home page and billing turned off leave the row out, and with no row there
 * is no bubble. The account balance is deliberately not read or shown. It opens
 * only for a resting mouse or pen; a press on the mascot closes it, since the
 * press plays a reaction there.
 *
 * @returns `{ element, enter, leave, dispose }`: `element` is put inside the
 *     mascot's pointer window, the rest are the player's pointer hooks.
 */
export function createMascotBubble(ui: FeatureUi<typeof manifest>) {
  const root = buildElement('span', 'dsh-claude-mascot-bubble')
  let timer: ReturnType<typeof setTimeout> | null = null
  let open = false
  let offCost: (() => void) | null = null

  /** One row: its label, then one figure per amount. */
  function row(kind: 'session', label: string, figures: string[]) {
    const line = buildElement('span', 'dsh-claude-mascot-bubble-row')
    line.setAttribute('data-row', kind)
    line.appendChild(buildElement('span', 'dsh-claude-mascot-bubble-label', label))
    for (const figure of figures) line.appendChild(buildElement('span', 'dsh-claude-mascot-bubble-figure', figure))
    return line
  }

  /** The session row's figure, or null when it has none to print. */
  function sessionFigure(reading: SessionCostReading | null): string | null {
    if (reading === null) return null
    if (reading.cost !== null) return formatMoneyMicro(reading.cost, reading.currency)
    return reading.pending ? `${CURRENCY_SYMBOL[reading.currency]}${DASH}` : null
  }

  /** Write the row the bubble owes now; it shows only while it has one. */
  function render() {
    if (!open) return
    const reading = ui.contextStats?.sessionCost() ?? null
    const session = sessionFigure(reading)
    const rows: HTMLElement[] = session === null ? [] : [row('session', copy('mascotSessionLabel'), [session])]
    const same = rows.length === root.children.length &&
      rows.every((line, i) => line.isEqualNode(root.children[i]))
    if (!same) root.replaceChildren(...rows)
    if (rows.length > 0) root.setAttribute('data-open', '')
    else root.removeAttribute('data-open')
  }

  function show() {
    timer = null
    open = true
    offCost = ui.contextStats?.onSessionCost(render) ?? null
    render()
  }

  /** The pointer came to rest on the mascot. */
  function enter(event: PointerEvent) {
    if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return
    if (open || timer !== null) return
    timer = setTimeout(show, HOVER_DELAY_MS)
  }

  /** The pointer left, a press started, or the mascot left the page. */
  function leave() {
    if (timer !== null) clearTimeout(timer)
    timer = null
    open = false
    if (offCost !== null) offCost()
    offCost = null
    root.removeAttribute('data-open')
  }

  return {
    element: root,
    enter,
    leave,
    dispose() {
      leave()
      root.remove()
    },
  }
}
