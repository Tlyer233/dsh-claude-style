import { COMPOSER_STACK, conversationSessionId, findComposerCard, findComposerSeat, findConversationSession, findHeroRoot } from '@dsh-claude-style/engine/host'
import { motionReduced } from '../../core/prefs'
import { createMascotBubble } from './mascot-bubble'
import { createMascotSignals } from './mascot-signals'
import type { MascotMoment } from './mascot-signals'
import { decideStage, finishStage, freshStage, nextDecisionAt, switchSettles, takeMoment } from './mascot-stage'
import type { MascotPick, PlayMode } from './mascot-stage'
import { buildElement, createStamp, setAttributeIfChanged } from '@dsh-claude-style/engine/dom'
import type { HostContext } from '@dsh-claude-style/engine/host'
import type { FeatureUi } from '../../core/feature'
import type manifest from './mascot.manifest'

/** The keys a press starts: these always play from frame 0, never pose-matched. */
const REACTION_KEYS = new Set(['poke-left', 'poke-right', 'tickle', 'drag'])

/** One animation's sheet: its frame count, its crop box `[x, y, width, height]` in logical pixels, and its still frame. */
export interface MascotSheet {
  frames: number
  box: number[]
  still: number
  /** Each frame's own duration in milliseconds; absent means `frames` equal `frameMs` frames. */
  durs?: number[]
  /** This sheet's own frame time, when it plays at another pace than the character (the press reactions run faster). */
  frameMs?: number
  /** Frames per sheet row (eight when absent); a strip that holds one long row says so here. */
  columns?: number
}

/** A character's sheet pipeline: whether a sheet plays, whether it never will, how it is painted. */
export interface MascotSheets {
  ready(key: string): boolean
  failed(key: string): boolean
  paint(style: CSSStyleDeclaration, key: string): void
  /** Start loading these sheets ahead of the state that wants them, so a switch never waits on the network. */
  preload?(keys: string[]): void
  /** One frame's alpha silhouette at 12×12, for matching the new state's pose to the frame on screen. */
  pose?(key: string, frame: number, cellWidth: number, cellHeight: number, columns: number): number[] | null
  dispose(): void
}

/**
 * The characters the player plays. A union of literals: the anchor mark is
 * built from the name, and the build reads the marks the stylesheets key on
 * off this type (scripts/source-tree.mjs).
 */
export type MascotName = 'crab' | 'deepy' | 'whalegirl' | 'gemini' | 'qwen'

/** What one character hands the player (see createMascotPlayer). */
export interface MascotCharacter {
  name: MascotName
  sheets: Record<string, MascotSheet>
  frameMs: number
  gutter?: number
  extras: string[]
  /** Loops play forward and then back through the same frames: the seam has no jump, at the cost of reverse motion. */
  pingpongLoops?: boolean
  /** A click or drag plays its reaction to the end; another press during it is ignored. */
  patientInteractions?: boolean
  /** The sheet a released drag lands on before the next state: a short one-shot from the idle strip. */
  landingKey?: string
  /** Start a new state at the frame whose silhouette is closest to the frame on screen, instead of frame 0. */
  poseMatching?: boolean
  /** Image pixels per logical pixel in the routed sheets (4 for the 96×120 cells at 2× display). */
  cellScale?: number
  createSheets(onReady: () => void): MascotSheets
}

/**
 * One mascot on the composer — the crab or Deepy — played from its sheets
 * by the state the agent is in (packages/client/src/features/mascot/mascot-signals.ts).
 *
 * It stands on the composer card, or on the approval panel that takes the
 * card's place: that panel is the composer chain's fallback wrapper, whose
 * class-name fragment is the placement contract. The chat target is
 * subscribed while a session is followed, because an unsubscribed read
 * answers nothing in the trajectory view; one-off moments come from the
 * session's event stream. Priority and the clock rules are mascot-stage.ts's.
 *
 * Frames are a WAAPI `steps()` translation of the sheet strip, so playing
 * needs no timer and no DOM mutation and never wakes a pass; the old sheet
 * keeps playing until the new one is ready, so a switch never blinks. A host
 * placement slot or activity service retires the host reads here.
 *
 * @param ui - shared handle table (`ui.composer`).
 * @param character - `{ name, sheets, frameMs, gutter, extras, pingpongLoops, createSheets }`:
 *     `name` prefixes its class names and its anchor mark
 *     (`dsh-claude-<name>`, `data-dsh-claude-<name>-anchor`); `sheets` is the
 *     animation table (`{ frames, box, still, durs?, columns? }` per key, every
 *     key the signals, moments, sleep, extras and reactions name); `gutter` the
 *     transparent margin each frame cell carries in the character's sheets, in
 *     logical pixels (absent when they carry none); `extras` the idle extras;
 *     `pingpongLoops` plays every loop forward and back so its seam cannot jump;
 *     `createSheets(onReady)` returns `{ ready, failed, paint, preload?, dispose }`.
 * @returns `{ sync, release, onActivity, dispose }`.
 */
export function createMascotPlayer(ctx: HostContext, ui: FeatureUi<typeof manifest>, character: MascotCharacter) {
  /** Clicks this close in a row are one tickle when four of them land. */
  const TICKLE_GAP_MS = 450
  const TICKLE_CLICKS = 4
  /** How far a press travels before it lifts the mascot. */
  const LIFT_PX = 4
  const PREFIX = `dsh-claude-${character.name}` as const
  /** The transparent margin each frame cell carries in this character's sheets (DEEPY_GUTTER), in logical pixels. */
  const GUTTER = character.gutter ?? 0
  /** A marker on the host element the mascot stands on, which makes it the mascot's containing block. */
  const ANCHOR_ATTR = `data-${PREFIX}-anchor` as const
  /** The stamp carrying the anchor mark across re-renders. */
  const anchorStamp = createStamp(ANCHOR_ATTR)
  const SHEETS = character.sheets
  const FRAME_MS = character.frameMs

  /** The nodes the mascot is drawn with, built once per generation. */
  let root: HTMLElement | null = null
  let strip: HTMLElement | null = null
  /** Whether the character's sheets have been asked to load ahead of the states that want them. */
  let preloaded = false
  /** The signal reader, created when the mascot first stands somewhere. */
  let signals: ReturnType<typeof createMascotSignals> | null = null

  /**
   * Everything the mascot is doing on the page it stands on: the session it
   * follows, the moment on screen and the one waiting its turn, the
   * reaction, the idle extra, the sleep and wake flags, the quiet spell,
   * the animation playing and the reader's own press or click run
   * (mascot-stage.ts decides on it).
   */
  let stage = freshStage(Date.now())

  /** What the stage's decisions read off the page: an idle extra starts only in motion, on a visible page. */
  const surroundings = () => ({ extras: character.extras, extrasAllowed: !motionReduced() && !document.hidden, random: Math.random })

  /** How long one round of an animation lasts: its own per-frame durations, or its frame count at the sheet's pace. */
  const playMs = (key: string) => {
    const sheet = SHEETS[key]
    const frameMs = sheet.frameMs ?? FRAME_MS
    return sheet.durs === undefined ? sheet.frames * frameMs : sheet.durs.reduce((sum, ms) => sum + ms, 0)
  }

  /** The character's sheet pipeline. */
  const sheets = character.createSheets(onSheetReady)
  // The idle sheet starts loading as soon as the character is installed: the
  // first stand then shows it without waiting on the route.
  sheets.preload?.(['idle'])
  /** The balance bubble, carried inside the pointer window it answers to. */
  const bubble = createMascotBubble(ctx, ui)

  /** A sheet became playable: read the state again and play what it asks for. */
  function onSheetReady() {
    if (root !== null) step()
  }

  /** @returns the new root; the sprite and the strip are set beside it. */
  function build() {
    const built = buildElement('span', PREFIX)
    built.setAttribute('aria-hidden', 'true')
    const sprite = buildElement('span', `${PREFIX}-sprite`)
    strip = buildElement('span', `${PREFIX}-strip`)
    sprite.appendChild(strip)
    built.appendChild(sprite)
    const hit = buildElement('span', `${PREFIX}-hit`)
    hit.addEventListener('pointerdown', onPressStart)
    hit.addEventListener('pointermove', onPressMove)
    hit.addEventListener('pointerup', onPressEnd)
    hit.addEventListener('pointercancel', onPressCancel)
    // The card a mascot stands on can be a button of its own (the home
    // page's "choose a workspace" card): a click on the mascot stays here.
    hit.addEventListener('click', event => { event.stopPropagation() })
    hit.addEventListener('pointerenter', bubble.enter)
    hit.addEventListener('pointerleave', bubble.leave)
    hit.appendChild(bubble.element)
    built.appendChild(hit)
    return built
  }

  /**
   * Where the mascot stands on the page shown: the home page's card, or
   * the main conversation's input area (its composer stack, or the panel
   * that takes the card's place) when the conversation is in scope. Null
   * when neither is on screen.
   */
  function findStand(conversation: boolean): { element: Element, session: string | null, place: string } | null {
    // The composer pass answers with the card it read; with that feature off
    // the page (its scope preference) the hero root and the page's first card
    // are the same answer.
    const heroCard = ui.composer
      ? ui.composer.heroCard()
      : findHeroRoot() === null ? null : findComposerCard()
    if (heroCard !== null) return { element: heroCard, session: null, place: 'card' }
    if (!conversation) return null
    if (ui.composer !== undefined && ui.composer.isChatHidden()) return null
    const content = findConversationSession()
    const seat = content === null ? null : findComposerSeat(content)
    if (seat === null) return null
    const session = conversationSessionId(content)
    // The composer chain's own wrapper (ui-renderer): the host hides it
    // inline when a panel is elected, and mounts that panel right after it.
    const fallback = seat.querySelector<HTMLElement>('[data-chain-overlay-fallback="conversation.composer"]')
    if (fallback !== null && fallback.style.display === 'none') {
      const panel = fallback.nextElementSibling
      return panel === null ? null : { element: panel, session, place: 'panel' }
    }
    const stack = seat.querySelector(COMPOSER_STACK)
    return stack === null ? null : { element: stack, session, place: 'stack' }
  }

  /**
   * Each pass: stand where the page puts the mascot, follow that page's
   * session, read its state.
   * @param conversation - whether the conversation page is in scope.
   */
  function sync(conversation: boolean) {
    const stand = findStand(conversation)
    if (stand === null) {
      park()
      return
    }
    if (root === null) root = build()
    if (signals === null) {
      stage.quietSince = Date.now()
      signals = createMascotSignals(ctx, onMoment, refresh)
    }
    if (!preloaded) {
      preloaded = true
      // Load every state while the pet is on screen: the first switch to a
      // state then plays at once instead of waiting on the sheet.
      sheets.preload?.(Object.keys(SHEETS))
    }
    if (root.parentNode !== stand.element) stand.element.appendChild(root)
    anchorStamp.mark(stand.element, stand.place)
    if (stand.session !== stage.sessionId) {
      stage.sessionId = stand.session
      // A moment belongs to the page it happened on.
      stage.moment = null
      stage.queued = null
    }
    signals.follow(stage.sessionId)
    refresh()
  }

  /** Read the state again and play what it asks for. */
  function refresh() {
    if (signals === null) return
    stage.level = signals.read(stage.sessionId)
    step()
  }

  /** A moment happened: it takes the stage, or waits behind a greater one (takeMoment). */
  function onMoment(name: MascotMoment) {
    if (takeMoment(stage, name, Date.now())) step()
  }

  /** A once animation reached its last frame: whoever asked for it lets go. */
  function finish(key: string, now: number) {
    finishStage(stage, key, now, Math.random)
  }

  /** Whether the animation choice holds what is on screen now still. */
  function still() {
    return motionReduced() && stage.reaction === null
  }

  /** One frame cell of a sheet: the crop box plus the transparent margin around it. */
  function cellSize(sheet: MascotSheet) {
    return [sheet.box[2] + GUTTER * 2, sheet.box[3] + GUTTER * 2]
  }

  /** The strip translation that puts one frame of a sheet in the window. */
  function frameOffset(sheet: MascotSheet, frame: number) {
    const [cellWidth, cellHeight] = cellSize(sheet)
    const columns = sheet.columns ?? 8
    return `translate(${-((frame % columns) * cellWidth + GUTTER) * 2}px, ${-(Math.floor(frame / columns) * cellHeight + GUTTER) * 2}px)`
  }

  /**
   * Put an animation on the strip: a WAAPI animation whose keyframes hold
   * each frame for its own duration — the character's frame time when the
   * sheet carries none (steps(1) jumps at the slot's end), so a loop runs
   * entirely on the browser's animation engine with no tick of the mascot's
   * own; or the state's still frame, pinned while the motion choice says so. A
   * once animation's end is reported by its `finished`; the deadline
   * schedule() arms is the backstop for a throttled tab.
   */
  function play(strip: HTMLElement, key: string, mode: PlayMode, startFrame = 0) {
    if (stage.animation !== null) {
      stage.animation.cancel()
      stage.animation = null
    }
    const sheet = SHEETS[key]
    if (still()) {
      strip.style.transform = frameOffset(sheet, sheet.still)
      return
    }
    strip.style.transform = ''
    const keyframes: Keyframe[] = []
    let duration: number
    const sequence = sequenceOf(sheet, mode)
    const frameMs = sheet.frameMs ?? FRAME_MS
    if (sequence !== null) {
      duration = sequence.length * frameMs
      for (let at = 0; at < sequence.length; at++) {
        keyframes.push({ offset: at / sequence.length, transform: frameOffset(sheet, sequence[at]), easing: 'steps(1)' })
      }
      keyframes.push({ offset: 1, transform: frameOffset(sheet, mode === 'loop' ? 0 : sheet.frames - 1) })
    } else if (sheet.durs !== undefined) {
      const durs = sheet.durs
      duration = durs.reduce((sum, ms) => sum + ms, 0)
      let at = 0
      for (let frame = 0; frame < sheet.frames; frame++) {
        keyframes.push({ offset: at / duration, transform: frameOffset(sheet, frame), easing: 'steps(1)' })
        at += durs[frame]
      }
      keyframes.push({ offset: 1, transform: frameOffset(sheet, mode === 'loop' ? 0 : sheet.frames - 1) })
    } else {
      return
    }
    const playing = strip.animate(keyframes, {
      duration,
      iterations: mode === 'loop' ? Infinity : 1,
      fill: 'forwards',
    })
    stage.animation = playing
    const start = Math.max(0, Math.min(startFrame, sheet.frames - 1))
    if (start > 0) playing.currentTime = start * FRAME_MS
    if (mode !== 'once') return
    playing.finished.then(() => {
      if (stage.animation !== playing || stage.current === null || stage.current.key !== key || stage.current.done === true) return
      stage.current.done = true
      finish(key, Date.now())
      step()
    }, () => {
      // finished rejects on cancel(): a newer animation took the strip.
    })
  }

  /**
   * Advance the mascot: settle what is on screen, then arm the one timer
   * at the next moment a time-based decision can flip. Runs on state
   * reads, sheet arrivals, reactions, the reader's hand and that timer —
   * playing itself needs no tick (play()).
   */
  function step() {
    if (root === null || strip === null || stage.level === null) return
    const now = Date.now()
    if (stage.current !== null && stage.current.mode === 'once' && stage.current.done !== true && now - stage.current.start >= playMs(stage.current.key)) {
      stage.current.done = true
      finish(stage.current.key, now)
    }
    const next = decideStage(stage, now, stage.level, surroundings())
    const switching = stage.current === null || next.key !== stage.current.key || (stage.reaction !== null && stage.reaction.fresh)
    const settled = switchSettles(stage, next, now)
    if (switching && settled) {
      if (sheets.ready(next.key)) show(root, strip, next, now)
      // A once animation whose sheet never came counts as played, so the
      // mascot does not wait on it for good.
      else if (next.mode === 'once' && sheets.failed(next.key)) {
        if (stage.reaction !== null) stage.reaction.fresh = false
        finish(next.key, now)
      }
    } else if (!switching && stage.current !== null) {
      // The motion choice flipped under the animation on stage: pin its
      // still frame, or set it playing again from where it stands.
      if (still() && stage.animation !== null) {
        stage.animation.cancel()
        stage.animation = null
        strip.style.transform = frameOffset(SHEETS[stage.current.key], SHEETS[stage.current.key].still)
      } else if (!still() && stage.animation === null) {
        play(strip, stage.current.key, stage.current.mode)
        // play() put the new animation on the stage.
        const playing = stage.animation as Animation | null
        if (playing !== null && stage.current.mode === 'loop') {
          playing.currentTime = (now - stage.current.start) % playMs(stage.current.key)
        }
      }
    }
    schedule(now, switching && !settled)
  }

  function show(root: HTMLElement, strip: HTMLElement, next: MascotPick, now: number) {
    const sheet = SHEETS[next.key]
    const [cellWidth, cellHeight] = cellSize(sheet)
    // No fade: start the new state at the frame whose silhouette is closest to
    // the one on screen, so the cut lands on a similar pose. A press reaction
    // starts at its own first frame, which is the gesture the reader asked for.
    const startFrame = stage.current !== null && !REACTION_KEYS.has(next.key) ? matchFrame(next.key) : 0
    stage.current = { key: next.key, mode: next.mode, priority: next.priority, start: now }
    if (stage.reaction !== null && stage.reaction.key === next.key) stage.reaction.fresh = false
    const style = root.style
    sheets.paint(style, next.key)
    style.setProperty('--dsh-claude-mascot-x', String(sheet.box[0]))
    style.setProperty('--dsh-claude-mascot-y', String(sheet.box[1]))
    style.setProperty('--dsh-claude-mascot-w', String(sheet.box[2]))
    // The sprite's height is one custom property every character shares, and
    // its stylesheet reads it beside the window it clips.
    style.setProperty('--dsh-claude-mascot-h', String(sheet.box[3]))
    style.setProperty('--dsh-claude-mascot-cell-w', String(cellWidth))
    style.setProperty('--dsh-claude-mascot-columns', String(sheet.columns ?? 8))
    style.setProperty('--dsh-claude-mascot-strip-h', String(cellHeight * Math.ceil(sheet.frames / (sheet.columns ?? 8))))
    setAttributeIfChanged(root, 'data-animation', next.key)
    play(strip, next.key, next.mode, startFrame)
    if (next.key === 'landing') drop()
    strip.style.transition = 'none'
    strip.style.opacity = '1'
    if (!root.hasAttribute('data-ready')) root.setAttribute('data-ready', '')
  }

  /**
   * The frame order one round of an animation plays: a ping-pong loop walks
   * forward and then back through the same frames, so its seam repeats a pose
   * instead of jumping; a sheet with per-frame durations has no such order.
   */
  function sequenceOf(sheet: MascotSheet, mode: PlayMode): number[] | null {
    if (sheet.durs !== undefined) return null
    const sequence: number[] = []
    for (let frame = 0; frame < sheet.frames; frame++) sequence.push(frame)
    if (character.pingpongLoops === true && mode === 'loop' && sheet.frames > 2) {
      for (let frame = sheet.frames - 2; frame > 0; frame--) sequence.push(frame)
    }
    return sequence
  }

  /**
   * The frame on screen right now, read from the running animation's clock and
   * mapped back through the sequence the animation was built from.
   */
  function currentFrame(): { key: string, frame: number } | null {
    const current = stage.current
    if (current === null) return null
    const sheet = SHEETS[current.key]
    const sequence = sequenceOf(sheet, current.mode)
    if (sequence === null) return null
    if (still() && stage.animation === null) return { key: current.key, frame: sheet.still }
    const time = stage.animation !== null && typeof stage.animation.currentTime === 'number' ? stage.animation.currentTime : 0
    const frameMs = sheet.frameMs ?? FRAME_MS
    const at = Math.floor(Math.max(0, time) / frameMs) % sequence.length
    return { key: current.key, frame: sequence[at] }
  }

  /** A frame's alpha silhouette as the loaded sheet renders it, in the sheet's image pixels. */
  function poseOf(key: string, frame: number) {
    if (sheets.pose === undefined) return null
    const sheet = SHEETS[key]
    const scale = character.cellScale ?? 4
    return sheets.pose(key, frame, sheet.box[2] * scale, sheet.box[3] * scale, sheet.columns ?? 8)
  }

  /** The new sheet's frame whose silhouette is closest to the frame on screen. */
  function matchFrame(nextKey: string): number {
    if (character.poseMatching !== true || sheets.pose === undefined) return 0
    const current = currentFrame()
    if (current === null) return 0
    const oldPose = poseOf(current.key, current.frame)
    if (oldPose === null) return 0
    const next = SHEETS[nextKey]
    let best = 0
    let bestScore = Infinity
    for (let frame = 0; frame < next.frames; frame++) {
      const pose = poseOf(nextKey, frame)
      if (pose === null) continue
      const count = Math.min(oldPose.length, pose.length)
      let score = 0
      for (let at = 0; at < count; at++) score += Math.abs(oldPose[at] - pose[at])
      score /= count
      if (score < bestScore) {
        bestScore = score
        best = frame
      }
    }
    return best
  }

  /**
   * The released drag's last few pixels: the pet falls from a small lift to its
   * ground line while the landing frames play. No fade — a short drop.
   */
  function drop() {
    if (root === null || motionReduced()) return
    root.style.transition = 'none'
    root.style.transform = 'translateY(-14px)'
    requestAnimationFrame(() => {
      if (root === null) return
      root.style.transition = 'transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)'
      root.style.transform = 'translateY(0)'
    })
  }

  /**
   * The one timer, armed at the next moment a time-based decision can flip
   * (nextDecisionAt). Everything else arrives as an event.
   */
  function schedule(now: number, waitSettle: boolean) {
    if (stage.timer !== null) clearTimeout(stage.timer)
    stage.timer = null
    const at = nextDecisionAt(stage, now, waitSettle, playMs)
    if (at === Infinity) return
    stage.timer = setTimeout(() => {
      stage.timer = null
      step()
    }, Math.max(at - now, 0))
  }

  /**
   * The reader's hand on the mascot. A reaction always starts from its
   * first frame (`fresh` until it is shown, even over the same reaction
   * still on screen); until its sheet is ready, what is on screen keeps
   * playing.
   */
  function react(key: string, mode: PlayMode) {
    // A patient character finishes the reaction it is already playing before
    // another press can start one; the strip never restarts mid-poke.
    if (character.patientInteractions === true && stage.reaction !== null) return
    stage.reaction = { key, mode, fresh: true }
    step()
  }

  function onPressStart(event: PointerEvent) {
    if (event.button !== 0) return
    bubble.leave()
    stage.press = { id: event.pointerId, x: event.clientX, y: event.clientY, lifted: false }
      ; (event.currentTarget as Element).setPointerCapture(event.pointerId)
  }

  function onPressMove(event: PointerEvent) {
    if (stage.press === null || stage.press.lifted || event.pointerId !== stage.press.id) return
    if (Math.hypot(event.clientX - stage.press.x, event.clientY - stage.press.y) < LIFT_PX) return
    stage.press.lifted = true
    stage.clicks = []
    react('drag', 'loop')
  }

  /**
   * The tracked press is over — let go or cancelled: it is cleared, and a
   * lift ends with it. Returns whether it had lifted, or null when the event
   * is not the tracked press.
   */
  function endPress(event: PointerEvent): boolean | null {
    if (stage.press === null || event.pointerId !== stage.press.id) return null
    const lifted = stage.press.lifted
    stage.press = null
    if (lifted) {
      // Let go: the pet leaves the lifted drag pose at once. A patient
      // character plays its short landing first; the drag animation itself is
      // never left standing in the air.
      if (character.landingKey !== undefined && stage.reaction?.key === 'drag') {
        stage.reaction = { key: character.landingKey, mode: 'once', fresh: true }
        step()
      } else {
        stage.reaction = null
        step()
      }
    }
    return lifted
  }

  /** A press let go without a lift pokes the side it landed on — or tickles, the fourth in a row. */
  function onPressEnd(event: PointerEvent) {
    if (endPress(event) !== false) return
    const now = Date.now()
    if (stage.clicks.length > 0 && now - stage.clicks[stage.clicks.length - 1] > TICKLE_GAP_MS) stage.clicks = []
    stage.clicks.push(now)
    if (stage.clicks.length >= TICKLE_CLICKS) {
      stage.clicks = []
      react('tickle', 'once')
      return
    }
    const box = (event.currentTarget as Element).getBoundingClientRect()
    react(event.clientX - box.left < box.width / 2 ? 'poke-left' : 'poke-right', 'once')
  }

  /** A cancelled press never pokes; endPress has already ended a lift. */
  function onPressCancel(event: PointerEvent) {
    endPress(event)
  }

  /**
   * The reader is at the page: a sleeping mascot wakes up, startled unless
   * stillness was asked for. The hook fires once at the wake (a quiet
   * reader's pointer sweep only rewrites quietSince), so the scheduler's
   * pointer and key paths stay cheap.
   */
  function onActivity() {
    stage.quietSince = Date.now()
    if (!stage.asleep) return
    stage.asleep = false
    stage.waking = !motionReduced()
    step()
  }

  /**
   * The page shows no stand for now (a route change, an overlay, a panel
   * swapping under the composer): detach the pet, but keep its last frame, its
   * stage and its reading. The next stand re-attaches the same node, so the pet
   * never blinks through a page that is still finding its composer.
   */
  function park() {
    if (stage.timer !== null) {
      clearTimeout(stage.timer)
      stage.timer = null
    }
    bubble.leave()
    if (root !== null && root.parentNode !== null) root.parentNode.removeChild(root)
    anchorStamp.release()
  }

  /** The page shows no stand: the mascot leaves it, and its reading stops. */
  function release() {
    if (stage.timer !== null) clearTimeout(stage.timer)
    if (stage.animation !== null) stage.animation.cancel()
    bubble.leave()
    if (root !== null && root.parentNode !== null) root.parentNode.removeChild(root)
    anchorStamp.release()
    if (signals !== null) signals.dispose()
    signals = null
    // One replacement for every field the page owned.
    stage = freshStage(Date.now())
  }

  function dispose() {
    release()
    sheets.dispose()
    bubble.dispose()
    root = null
    strip = null
  }

  return { sync, release, onActivity, dispose }
}
