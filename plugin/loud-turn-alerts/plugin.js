/**
 * loud-turn-alerts — louder, more visual prompt-completion alerts for Hermes
 * Desktop, with its own settings page.
 *
 * Two channels, each switchable:
 *   1. Sound  — a synthesized cue bank rendered through a limiter, so it is
 *               loud without clipping. Volume, preset, and repeats are live.
 *   2. Visual — a screen-edge glow pulse plus a top-centre banner carrying the
 *               reply preview. Duration, colour, and thickness are live.
 *
 * Everything persists through ctx.storage, so a reload keeps the settings.
 * This plugin never patches core: it listens to `message.complete`, the same
 * gateway event the built-in (quiet) completion chime listens to.
 */

import {
  atom,
  Button,
  cn,
  haptic,
  host,
  Input,
  PALETTE_AREA,
  ROUTES_AREA,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Tip,
  useValue
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'loud-turn-alerts'
const PAGE_PATH = '/loud-turn-alerts'

// ── settings ────────────────────────────────────────────────────────────────

const DEFAULTS = {
  enabled: true,
  sound: true,
  preset: 'klaxon',
  volume: 150, // percent; 100 = the loud bank at unity
  repeats: 3,
  visual: true,
  flash: true,
  banner: true,
  durationSec: 6,
  accent: 'amber',
  thickness: 14,
  preview: true,
  onlyFocused: true,
  osNotify: false,
  failureSound: true,
  position: 'top-right',
  soundSource: 'synth',
  customSoundName: '',
  voice: false,
  voiceMode: 'tts',
  voiceName: '',
  voiceClipName: '',
  voiceText: 'Prompt complete',
  voiceRate: 1,
  voiceVolume: 100
}

const POSITIONS = [
  { id: 'top-right', name: 'Top right' },
  { id: 'top-left', name: 'Top left' },
  { id: 'bottom-right', name: 'Bottom right' },
  { id: 'bottom-left', name: 'Bottom left' },
  { id: 'top-center', name: 'Top centre' },
  { id: 'bottom-center', name: 'Bottom centre' }
]

const PRESETS = [
  { id: 'klaxon', name: 'Klaxon (loudest)' },
  { id: 'triple', name: 'Triple beep' },
  { id: 'chime', name: 'Rising chime' },
  { id: 'gong', name: 'Deep gong' },
  { id: 'siren', name: 'Rising siren' }
]

const ACCENTS = [
  { id: 'amber', name: 'Amber' },
  { id: 'red', name: 'Red' },
  { id: 'green', name: 'Green' },
  { id: 'blue', name: 'Blue' },
  { id: 'violet', name: 'Violet' }
]

// Theme-independent literal colours: the alert must read the same on every
// skin, and these are the only places in this plugin that do not use vars.
const ACCENT_HEX = {
  amber: '#f5a524',
  red: '#f31260',
  green: '#17c964',
  blue: '#006fee',
  violet: '#9353d3'
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value))
}

function normalize(raw) {
  const next = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }

  next.volume = clamp(Number(next.volume) || 0, 0, 300)
  next.repeats = clamp(Math.round(Number(next.repeats) || 1), 1, 8)
  next.durationSec = clamp(Number(next.durationSec) || 1, 1, 60)
  next.thickness = clamp(Number(next.thickness) || 0, 0, 48)
  if (!PRESETS.some(item => item.id === next.preset)) {
    next.preset = DEFAULTS.preset
  }
  if (!ACCENTS.some(item => item.id === next.accent)) {
    next.accent = DEFAULTS.accent
  }
  if (!POSITIONS.some(item => item.id === next.position)) {
    next.position = DEFAULTS.position
  }
  next.voiceRate = clamp(Number(next.voiceRate) || 1, 0.5, 2)
  next.voiceVolume = clamp(Number(next.voiceVolume) || 0, 0, 100)

  return next
}

const $settings = atom(DEFAULTS)
const $voices = atom([])

function loadVoices() {
  try {
    const list = window.speechSynthesis?.getVoices?.() ?? []
    $voices.set(list.map(voice => ({ lang: voice.lang, name: voice.name })))
  } catch {
    $voices.set([])
  }
}
let storage = null
let os = null

function loadSettings() {
  if (!storage) {
    return
  }
  $settings.set(normalize(storage.get('settings', DEFAULTS)))
}

function patch(next) {
  const merged = normalize({ ...$settings.get(), ...next })
  $settings.set(merged)
  storage?.set('settings', merged)
}


// ── uploaded clips (IndexedDB) ──────────────────────────────────────────────
//
// localStorage caps at ~5 MB and ctx.storage rides it, so an uploaded MP3 or a
// recorded voice line lives in IndexedDB instead. The settings keep only the
// FILE NAME; the bytes stay out of the settings blob.

const CLIP_DB = 'loud-turn-alerts-clips'
let customSoundUrl = ''
let voiceClipUrl = ''

function clipDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CLIP_DB, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('clips')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function saveClip(key, value) {
  const db = await clipDb()

  return new Promise((resolve, reject) => {
    const tx = db.transaction('clips', 'readwrite')
    tx.objectStore('clips').put(value, key)
    tx.oncomplete = () => resolve(true)
    tx.onerror = () => reject(tx.error)
  })
}

async function loadClip(key) {
  try {
    const db = await clipDb()

    return await new Promise((resolve, reject) => {
      const tx = db.transaction('clips', 'readonly')
      const request = tx.objectStore('clips').get(key)
      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => reject(request.error)
    })
  } catch {
    return null
  }
}

async function deleteClip(key) {
  const db = await clipDb()
  db.transaction('clips', 'readwrite').objectStore('clips').delete(key)
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

function playClip(url, volume) {
  if (!url) {
    return false
  }

  try {
    const audio = new Audio(url)
    audio.volume = clamp((Number(volume) || 0) / 100, 0, 1)
    void audio.play()
    return true
  } catch {
    return false
  }
}

// ── audio ───────────────────────────────────────────────────────────────────

let audio = null

function context() {
  if (audio) {
    return audio
  }
  const Ctor = window.AudioContext || window.webkitAudioContext
  if (!Ctor) {
    return null
  }
  try {
    audio = new Ctor()
  } catch {
    return null
  }
  return audio
}

// Out = limiter → destination. A limiter is what buys loudness: we push the
// voices well past unity and let the brick wall stop the clipping.
function bus(ac, volume) {
  const limiter = ac.createDynamicsCompressor()
  limiter.threshold.setValueAtTime(-8, ac.currentTime)
  limiter.knee.setValueAtTime(0, ac.currentTime)
  limiter.ratio.setValueAtTime(20, ac.currentTime)
  limiter.attack.setValueAtTime(0.002, ac.currentTime)
  limiter.release.setValueAtTime(0.12, ac.currentTime)

  const master = ac.createGain()
  master.gain.setValueAtTime(clamp(volume / 100, 0, 3), ac.currentTime)

  master.connect(limiter)
  limiter.connect(ac.destination)

  return master
}

function tone(ac, out, at, spec) {
  const osc = ac.createOscillator()
  const env = ac.createGain()
  const start = at + (spec.delay ?? 0)
  const end = start + spec.dur
  const peak = Math.max(spec.gain ?? 0.2, 0.0002)

  osc.type = spec.type ?? 'square'
  osc.frequency.setValueAtTime(spec.freq, start)
  if (spec.to) {
    osc.frequency.exponentialRampToValueAtTime(spec.to, end)
  }

  env.gain.setValueAtTime(0.0001, start)
  env.gain.exponentialRampToValueAtTime(peak, start + (spec.attack ?? 0.005))
  env.gain.setValueAtTime(peak, start + spec.dur * 0.55)
  env.gain.exponentialRampToValueAtTime(0.0001, end)

  osc.connect(env)
  env.connect(out)
  osc.start(start)
  osc.stop(end + 0.02)
}

const BANK = {
  klaxon: (ac, out, at) => {
    // Two detuned squares, hard on/off — the "something finished" horn.
    for (let i = 0; i < 2; i += 1) {
      tone(ac, out, at, { freq: i ? 466 : 440, dur: 0.16, gain: 0.5, type: 'square', attack: 0.002 })
      tone(ac, out, at, { freq: i ? 233 : 220, dur: 0.16, gain: 0.3, type: 'square', attack: 0.002, delay: 0.005 })
    }
  },
  triple: (ac, out, at) => {
    ;[0, 0.16, 0.32].forEach(offset =>
      tone(ac, out, at, { freq: 1046, dur: 0.1, gain: 0.42, type: 'square', delay: offset, attack: 0.002 })
    )
    tone(ac, out, at, { freq: 523, dur: 0.55, gain: 0.16, type: 'sine', delay: 0.02, attack: 0.01 })
  },
  chime: (ac, out, at) => {
    ;[523, 659, 784, 1046].forEach((freq, index) =>
      tone(ac, out, at, { freq, dur: 0.42, gain: 0.3, type: 'sine', delay: index * 0.09, attack: 0.004 })
    )
  },
  gong: (ac, out, at) => {
    tone(ac, out, at, { freq: 98, dur: 1.6, gain: 0.6, type: 'sine', attack: 0.02 })
    tone(ac, out, at, { freq: 196, dur: 1.2, gain: 0.25, type: 'triangle', attack: 0.02 })
    tone(ac, out, at, { freq: 294, dur: 0.7, gain: 0.12, type: 'sine', attack: 0.04, delay: 0.01 })
  },
  siren: (ac, out, at) => {
    tone(ac, out, at, { freq: 420, to: 1250, dur: 0.55, gain: 0.4, type: 'sawtooth', attack: 0.01 })
    tone(ac, out, at, { freq: 210, to: 625, dur: 0.55, gain: 0.22, type: 'square', attack: 0.01 })
  }
}

function playCue({ preset, volume, repeats }) {
  const ac = context()
  if (!ac) {
    return
  }
  if (ac.state === 'suspended') {
    void ac.resume().catch(() => {})
  }

  const out = bus(ac, volume)
  const fire = BANK[preset] ?? BANK.klaxon
  const gap = preset === 'gong' ? 0.9 : 0.42
  const now = ac.currentTime + 0.02

  for (let index = 0; index < repeats; index += 1) {
    fire(ac, out, now + index * gap)
  }
}

// ── voice-over ──────────────────────────────────────────────────────────────

// Web Speech is optional: a locked-down build may ship no voices, and
// speechSynthesis.speak() never reports a failure. Best-effort by design.
function speak(text, rate, volume, voiceName) {
  const synth = window.speechSynthesis
  if (!synth || !text) {
    return
  }

  try {
    synth.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = clamp(Number(rate) || 1, 0.5, 2)
    utterance.volume = clamp((Number(volume) || 0) / 100, 0, 1)
    if (voiceName) {
      const match = synth.getVoices().find(voice => voice.name === voiceName)
      if (match) {
        utterance.voice = match
      }
    }
    synth.speak(utterance)
  } catch {
    // A missing voice must never break the alert.
  }
}

// ── visual overlay ──────────────────────────────────────────────────────────

const OVERLAY_ID = 'loud-turn-alerts-overlay'
let overlayTimer = null
let glowTimer = null

function overlayHost() {
  let node = document.getElementById(OVERLAY_ID)
  if (node) {
    return node
  }

  node = document.createElement('div')
  node.id = OVERLAY_ID
  node.setAttribute('data-loud-turn-alerts', '1')
  // Click-through by default so the alert never traps a click; the banner
  // re-enables pointer events on itself only.
  node.style.cssText = 'position:fixed;inset:0;z-index:99999;pointer-events:none;display:none'
  document.body.appendChild(node)

  return node
}

function paintSettingsStyles(settings) {
  const node = document.getElementById(OVERLAY_ID)
  if (!node || !settings.flash) {
    return
  }
  node.style.boxShadow = `inset 0 0 0 ${settings.thickness}px ${ACCENT_HEX[settings.accent] ?? ACCENT_HEX.amber}`
}

function clearOverlay() {
  const node = document.getElementById(OVERLAY_ID)
  if (!node) {
    return
  }
  node.style.display = 'none'
  node.replaceChildren()
  node.style.boxShadow = 'none'
}

function showVisual({ accent, thickness, durationSec, flash, banner, title, body, position }) {
  const node = overlayHost()
  const colour = ACCENT_HEX[accent] ?? ACCENT_HEX.amber

  node.style.display = 'block'
  node.replaceChildren()

  if (flash) {
    node.style.boxShadow = `inset 0 0 0 ${thickness}px ${colour}`
    node.animate(
      [
        { opacity: 0.2, filter: 'brightness(2.4)' },
        { opacity: 1, filter: 'brightness(1)' },
        { opacity: 0.55 },
        { opacity: 1 }
      ],
      { duration: 1600, iterations: 1, easing: 'ease-out' }
    )
    clearTimeout(glowTimer)
    glowTimer = setTimeout(() => {
      node.style.boxShadow = `inset 0 0 0 ${Math.max(2, Math.round(thickness / 3))}px ${colour}`
    }, 2200)
  } else {
    node.style.boxShadow = 'none'
  }

  if (banner) {
    const card = document.createElement('div')
    const POS_EDGE = {
      'top-right': 'top:18px;right:18px',
      'top-left': 'top:18px;left:18px',
      'bottom-right': 'bottom:18px;right:18px',
      'bottom-left': 'bottom:18px;left:18px',
      'top-center': 'top:18px;left:50%;transform:translateX(-50%)',
      'bottom-center': 'bottom:18px;left:50%;transform:translateX(-50%)'
    }

    card.style.cssText = [
      'pointer-events:auto',
      'cursor:pointer',
      'position:absolute',
      POS_EDGE[position] ?? POS_EDGE['top-right'],
      'max-width:min(420px, 86vw)',
      `border:2px solid ${colour}`,
      'border-radius:14px',
      'padding:14px 18px',
      'background:color-mix(in srgb, var(--card, #111) 92%, transparent)',
      'backdrop-filter:blur(10px)',
      `box-shadow:0 18px 60px -12px ${colour}`
    ].join(';')

    const head = document.createElement('div')
    head.textContent = title
    head.style.cssText = [
      'font-size:15px',
      'font-weight:700',
      'letter-spacing:0.02em',
      `color:${colour}`,
      'display:flex',
      'align-items:center',
      'gap:8px'
    ].join(';')

    const dot = document.createElement('span')
    dot.style.cssText = `width:9px;height:9px;border-radius:999px;background:${colour};box-shadow:0 0 12px ${colour}`
    head.prepend(dot)

    card.appendChild(head)

    if (body) {
      const text = document.createElement('div')
      text.textContent = body
      text.style.cssText = [
        'margin-top:6px',
        'font-size:13px',
        'line-height:1.45',
        'color:var(--foreground, #e8e8e8)',
        'opacity:0.86',
        'white-space:pre-wrap',
        'word-break:break-word',
        'max-height:8.5em',
        'overflow:hidden'
      ].join(';')
      card.appendChild(text)
    }

    card.addEventListener('click', () => clearOverlay())
    node.appendChild(card)
  }

  clearTimeout(overlayTimer)
  overlayTimer = setTimeout(clearOverlay, Math.round(durationSec * 1000))
}

// ── event handling ──────────────────────────────────────────────────────────

let lastFiredAt = 0

function previewFrom(payload) {
  const raw = payload?.text ?? payload?.rendered ?? ''
  const text = String(raw).replace(/```[a-zA-Z0-9_+-]*/g, '').replace(/\s+/g, ' ').trim()
  if (!text) {
    return ''
  }
  return text.length > 220 ? `${text.slice(0, 220).trim()} ...` : text
}

function fire({ failed = false, body = '' } = {}) {
  const settings = $settings.get()
  if (!settings.enabled) {
    return
  }

  // Collapse duplicate frames from a replayed event or a second window.
  const now = Date.now()
  if (now - lastFiredAt < 700) {
    return
  }
  lastFiredAt = now

  if (settings.sound && (!failed || settings.failureSound)) {
    if (settings.soundSource === 'custom' && customSoundUrl) {
      playClip(customSoundUrl, settings.volume > 100 ? 100 : settings.volume)
    } else {
      playCue({
        preset: failed ? 'triple' : settings.preset,
        volume: settings.volume,
        repeats: failed ? 2 : settings.repeats
      })
    }
  }

  if (settings.visual) {
    showVisual({
      accent: failed ? 'red' : settings.accent,
      thickness: settings.thickness,
      durationSec: settings.durationSec,
      flash: settings.flash,
      banner: settings.banner,
      title: failed ? 'Hermes hit an error' : 'Hermes finished',
      body: settings.preview ? body : '',
      position: settings.position
    })
  }

  if (settings.voice) {
    const line = failed ? `${settings.voiceText}. Error.` : settings.voiceText
    if (settings.voiceMode === 'clip' && voiceClipUrl) {
      playClip(voiceClipUrl, settings.voiceVolume)
    } else {
      speak(line, settings.voiceRate, settings.voiceVolume, settings.voiceName)
    }
  }

  if (settings.osNotify) {
    try {
      void os?.notify?.({
        title: failed ? 'Hermes hit an error' : 'Hermes finished',
        body: body.slice(0, 160)
      })
    } catch {
      // The OS door is best-effort; the in-app overlay already fired.
    }
  }
}

function onGatewayEvent(event) {
  if (!event || event.type !== 'message.complete') {
    return
  }

  const settings = $settings.get()
  if (!settings.enabled) {
    return
  }

  const sessionId = event.session_id ?? event.payload?.session_id ?? null
  if (settings.onlyFocused) {
    const focused = host.state.focusedSessionId?.get?.()
    if (focused && sessionId && sessionId !== focused) {
      return
    }
  }

  const payload = event.payload ?? {}
  const failed = payload.status === 'error'
  fire({ failed, body: previewFrom(payload) })
}

// ── settings page ───────────────────────────────────────────────────────────

function Row({ label, hint, children }) {
  return jsxs('div', {
    className: 'flex items-center justify-between gap-4 border-b border-(--ui-stroke-secondary) py-2',
    children: [
      jsxs('div', {
        className: 'min-w-0',
        children: [
          jsx('div', { className: 'text-[13px] font-medium text-foreground', children: label }),
          hint
            ? jsx('div', { className: 'mt-0.5 text-[11px] text-(--ui-text-tertiary)', children: hint })
            : null
        ]
      }),
      jsx('div', { className: 'shrink-0 pt-0.5', children })
    ]
  })
}

function NumberField({ value, min, max, onChange }) {
  return jsx(Input, {
    className: 'w-20 text-center',
    max,
    min,
    onChange: event => {
      const parsed = Number.parseInt(event.target.value, 10)
      if (!Number.isNaN(parsed)) {
        onChange(clamp(parsed, min, max))
      }
    },
    type: 'number',
    value: String(value)
  })
}

function SectionLabel({ children }) {
  return jsx('div', {
    className: 'pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wider text-(--ui-text-tertiary)',
    children
  })
}

function AudioPicker({ currentName, onClear, onPick }) {
  const choose = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'audio/*'
    input.onchange = async () => {
      const file = input.files && input.files[0]
      if (!file) {
        return
      }
      const dataUrl = await readFileAsDataUrl(file)
      if (dataUrl) {
        await onPick(file.name, dataUrl)
      }
    }
    input.click()
  }

  return jsxs('div', {
    className: 'flex items-center gap-2',
    children: [
      jsx(Button, {
        onClick: choose,
        size: 'sm',
        type: 'button',
        variant: 'outline',
        children: currentName ? 'Replace' : 'Upload'
      }),
      jsx('span', {
        className: 'max-w-24 truncate text-[11px] text-(--ui-text-tertiary)',
        children: currentName || 'No file'
      }),
      currentName
        ? jsx(Button, { onClick: onClear, size: 'sm', type: 'button', variant: 'ghost', children: 'Remove' })
        : null
    ]
  })
}

function SettingsPage() {
  const settings = useValue($settings)
  const voices = useValue($voices)
  const off = !settings.enabled
  const visualOff = off || !settings.visual

  return jsxs('div', {
    className: 'mx-auto flex w-full max-w-4xl flex-col gap-3 p-5',
    children: [
      jsxs('div', {
        children: [
          jsx('h1', { className: 'text-base font-semibold text-foreground', children: 'Turn Alerts' }),
          jsx('p', {
            className: 'mt-0.5 text-[12px] text-(--ui-text-tertiary)',
            children: 'Loud and visible prompt-completion alerts. Independent of the core completion sound.'
          })
        ]
      }),

      jsxs('div', {
        className: 'flex items-center justify-between gap-4 rounded-lg border border-(--ui-stroke-secondary) px-3 py-2',
        children: [
          jsx('span', { className: 'text-[13px] font-medium text-foreground', children: 'Enable turn alerts' }),
          jsx(Switch, { checked: settings.enabled, onCheckedChange: on => patch({ enabled: on }) })
        ]
      }),

      jsxs('div', {
        className: 'grid grid-cols-2 gap-x-8',
        children: [
          jsxs('div', {
            className: 'min-w-0',
            children: [
              jsx(SectionLabel, { children: 'Sound' }),
              jsx(Row, {
                label: 'Play a sound',
                hint: 'Synthesized in-app. No audio file.',
                children: jsx(Switch, {
                  checked: settings.sound,
                  disabled: off,
                  onCheckedChange: on => patch({ sound: on })
                })
              }),
              jsx(Row, {
                label: 'Cue',
                hint: 'Klaxon is the loudest.',
                children: jsxs(Select, {
                  onValueChange: value => {
                    patch({ preset: value })
                    playCue({ preset: value, volume: settings.volume, repeats: 1 })
                  },
                  value: settings.preset,
                  children: [
                    jsx(SelectTrigger, { className: 'w-44', children: jsx(SelectValue, {}) }),
                    jsx(SelectContent, {
                      children: PRESETS.map(item =>
                        jsx(SelectItem, { value: item.id, children: item.name }, item.id)
                      )
                    })
                  ]
                })
              }),
              jsx(Row, {
                label: 'Sound source',
                hint: 'Built-in cue, or a track you upload.',
                children: jsxs(Select, {
                  onValueChange: value => patch({ soundSource: value }),
                  value: settings.soundSource,
                  children: [
                    jsx(SelectTrigger, { className: 'w-32', children: jsx(SelectValue, {}) }),
                    jsx(SelectContent, {
                      children: [
                        jsx(SelectItem, { value: 'synth', children: 'Built-in cue' }, 'synth'),
                        jsx(SelectItem, { value: 'custom', children: 'My audio' }, 'custom')
                      ]
                    })
                  ]
                })
              }),
              settings.soundSource === 'custom'
                ? jsx(Row, {
                    label: 'Audio file',
                    hint: 'MP3, WAV, OGG or M4A.',
                    children: jsx(AudioPicker, {
                      currentName: settings.customSoundName,
                      onClear: async () => {
                        await deleteClip('sound')
                        customSoundUrl = ''
                        patch({ customSoundName: '' })
                      },
                      onPick: async (name, dataUrl) => {
                        await saveClip('sound', dataUrl)
                        customSoundUrl = dataUrl
                        patch({ customSoundName: name, soundSource: 'custom' })
                        playClip(dataUrl, 80)
                      }
                    })
                  })
                : null,
              jsx(Row, {
                label: 'Volume',
                hint: `${settings.volume}% of the loud bank`,
                children: jsx('input', {
                  'aria-label': 'Volume',
                  className: 'w-32 accent-(--ui-accent)',
                  max: 300,
                  min: 0,
                  onChange: event => patch({ volume: Number.parseInt(event.target.value, 10) }),
                  step: 10,
                  type: 'range',
                  value: String(settings.volume)
                })
              }),
              jsx(Row, {
                label: 'Repeats',
                hint: 'Fires per turn. 1 to 8.',
                children: jsx(NumberField, {
                  max: 8,
                  min: 1,
                  onChange: value => patch({ repeats: value }),
                  value: settings.repeats
                })
              })
            ]
          }),

          jsxs('div', {
            className: 'min-w-0',
            children: [
              jsx(SectionLabel, { children: 'Visual' }),
              jsx(Row, {
                label: 'Show a visual alert',
                hint: 'Edge glow plus a banner.',
                children: jsx(Switch, {
                  checked: settings.visual,
                  disabled: off,
                  onCheckedChange: on => patch({ visual: on })
                })
              }),
              jsx(Row, {
                label: 'Edge glow',
                hint: 'Pulses a frame around the window.',
                children: jsx(Switch, {
                  checked: settings.flash,
                  disabled: visualOff,
                  onCheckedChange: on => patch({ flash: on })
                })
              }),
              jsx(Row, {
                label: 'Banner',
                hint: 'Top-centre card. Click to dismiss.',
                children: jsx(Switch, {
                  checked: settings.banner,
                  disabled: visualOff,
                  onCheckedChange: on => patch({ banner: on })
                })
              }),
              jsx(Row, {
                label: 'Reply preview',
                hint: 'First 220 characters in the banner.',
                children: jsx(Switch, {
                  checked: settings.preview,
                  disabled: visualOff,
                  onCheckedChange: on => patch({ preview: on })
                })
              }),
              jsx(Row, {
                label: 'Position',
                hint: 'Where the alert card sits.',
                children: jsxs(Select, {
                  onValueChange: value => patch({ position: value }),
                  value: settings.position,
                  children: [
                    jsx(SelectTrigger, { className: 'w-32', children: jsx(SelectValue, {}) }),
                    jsx(SelectContent, {
                      children: POSITIONS.map(item =>
                        jsx(SelectItem, { value: item.id, children: item.name }, item.id)
                      )
                    })
                  ]
                })
              }),
              jsx(Row, {
                label: 'Colour',
                children: jsxs(Select, {
                  onValueChange: value => patch({ accent: value }),
                  value: settings.accent,
                  children: [
                    jsx(SelectTrigger, { className: 'w-32', children: jsx(SelectValue, {}) }),
                    jsx(SelectContent, {
                      children: ACCENTS.map(item =>
                        jsx(SelectItem, { value: item.id, children: item.name }, item.id)
                      )
                    })
                  ]
                })
              }),
              jsx(Row, {
                label: 'Glow / visible',
                hint: 'Thickness in px, seconds on screen.',
                children: jsxs('div', {
                  className: 'flex items-center gap-2',
                  children: [
                    jsx(NumberField, {
                      max: 48,
                      min: 0,
                      onChange: value => patch({ thickness: value }),
                      value: settings.thickness
                    }),
                    jsx(NumberField, {
                      max: 60,
                      min: 1,
                      onChange: value => patch({ durationSec: value }),
                      value: settings.durationSec
                    })
                  ]
                })
              }),

              jsx(SectionLabel, { children: 'Scope' }),
              jsx(Row, {
                label: 'This chat only',
                hint: 'Off: any tracked session may alert.',
                children: jsx(Switch, {
                  checked: settings.onlyFocused,
                  onCheckedChange: on => patch({ onlyFocused: on })
                })
              }),
              jsx(Row, {
                label: 'System notification',
                hint: 'Native OS toast while you are away.',
                children: jsx(Switch, {
                  checked: settings.osNotify,
                  onCheckedChange: on => patch({ osNotify: on })
                })
              }),
              jsx(Row, {
                label: 'Loud error cue',
                hint: 'Triple beep when a turn fails.',
                children: jsx(Switch, {
                  checked: settings.failureSound,
                  onCheckedChange: on => patch({ failureSound: on })
                })
              }),
              jsx(SectionLabel, { children: 'Voice' }),
              jsx(Row, {
                label: 'Voice mode',
                hint: 'System voice, or your own recorded line.',
                children: jsxs(Select, {
                  onValueChange: value => patch({ voiceMode: value }),
                  value: settings.voiceMode,
                  children: [
                    jsx(SelectTrigger, { className: 'w-32', children: jsx(SelectValue, {}) }),
                    jsx(SelectContent, {
                      children: [
                        jsx(SelectItem, { value: 'tts', children: 'System voice' }, 'tts'),
                        jsx(SelectItem, { value: 'clip', children: 'My recording' }, 'clip')
                      ]
                    })
                  ]
                })
              }),
              jsx(Row, {
                label: 'Speak the alert',
                hint: 'Reads the line aloud when a turn finishes.',
                children: jsx(Switch, {
                  checked: settings.voice,
                  onCheckedChange: on => patch({ voice: on })
                })
              }),
              settings.voiceMode === 'tts'
                ? jsx(Row, {
                    label: 'System voice',
                    hint: 'Pick the closest to Siri or Jarvis on this machine.',
                    children: jsxs(Select, {
                      onValueChange: value => {
                        patch({ voiceName: value })
                        speak(settings.voiceText, settings.voiceRate, settings.voiceVolume, value)
                      },
                      value: settings.voiceName,
                      children: [
                        jsx(SelectTrigger, { className: 'w-40', children: jsx(SelectValue, {}) }),
                        jsx(SelectContent, {
                          children: voices.map(voice =>
                            jsx(SelectItem, { value: voice.name, children: voice.name }, voice.name)
                          )
                        })
                      ]
                    })
                  })
                : jsx(Row, {
                    label: 'Voice clip',
                    hint: 'Your own line, from any voice service.',
                    children: jsx(AudioPicker, {
                      currentName: settings.voiceClipName,
                      onClear: async () => {
                        await deleteClip('voice')
                        voiceClipUrl = ''
                        patch({ voiceClipName: '' })
                      },
                      onPick: async (name, dataUrl) => {
                        await saveClip('voice', dataUrl)
                        voiceClipUrl = dataUrl
                        patch({ voiceClipName: name, voiceMode: 'clip' })
                        playClip(dataUrl, 80)
                      }
                    })
                  }),
              jsx(Row, {
                label: 'Spoken text',
                hint: 'The phrase the voice reads.',
                children: jsx(Input, {
                  className: 'w-40',
                  onChange: event => patch({ voiceText: event.target.value }),
                  value: settings.voiceText
                })
              }),
              jsx(Row, {
                label: 'Voice speed',
                hint: '0.5x to 2x. 1x is normal.',
                children: jsx('input', {
                  'aria-label': 'Voice speed',
                  className: 'w-32 accent-(--ui-accent)',
                  max: 200,
                  min: 50,
                  onChange: event => patch({ voiceRate: Number.parseInt(event.target.value, 10) / 100 }),
                  step: 10,
                  type: 'range',
                  value: String(Math.round(settings.voiceRate * 100))
                })
              })
            ]
          })
        ]
      }),

      jsxs('div', {
        className: 'flex flex-wrap items-center gap-2',
        children: [
          jsx(Button, {
            onClick: () => fire({ body: 'Test alert. This is what a finished turn looks like.' }),
            size: 'sm',
            type: 'button',
            children: 'Test alert'
          }),
          jsx(Button, {
            onClick: () => patch({ ...DEFAULTS }),
            size: 'sm',
            type: 'button',
            variant: 'outline',
            children: 'Reset to defaults'
          }),
          jsx('span', {
            className: 'text-[11.5px] text-(--ui-text-tertiary)',
            children: 'Click a test alert anywhere to dismiss it.'
          })
        ]
      })
    ]
  })
}


// ── settings door from core Settings → Notifications ───────────────────────

// The plugin cannot import react-dom, so it cannot mount into an arbitrary
// host element. Core Settings therefore sends an EVENT; this side opens the
// same workspace tab the status-bar chip opens.
const SETTINGS_EVENT = 'hermes:open-turn-alerts'

function listenForSettingsDoor() {
  window.addEventListener(SETTINGS_EVENT, () => {
    openSettings()
    host.notify({ kind: 'info', message: 'Turn Alerts opened in a workspace tab' })
  })
}

// ── plugin ──────────────────────────────────────────────────────────────────

// One door for every entry point. `host.openWorkspace` opens a closeable
// main-area tab, which works in every layout (tile stacks included); the
// route page is the fallback for a desktop build that predates it.
function openSettings() {
  if (typeof host.openWorkspace === 'function') {
    host.openWorkspace(`${ID}:settings`, {
      dock: { pane: 'workspace', pos: 'center' },
      title: 'Turn Alerts',
      render: () => jsx(SettingsPage, {})
    })

    return
  }

  host.navigate(PAGE_PATH)
}

function AlertChip() {
  const settings = useValue($settings)

  return jsx(Tip, {
    label: 'Turn Alerts — open the loud/visual alert settings',
    children: jsx('button', {
      className: cn(
        'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] transition-colors',
        'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
      ),
      type: 'button',
      onClick: () => {
        haptic('tap')
        openSettings()
      },
      children: settings.enabled ? '🔔 Alerts' : '🔕 Alerts'
    })
  })
}

export default {
  id: ID,
  name: 'Loud Turn Alerts',
  register(ctx) {
    storage = ctx.storage
    os = ctx.os
    loadSettings()

    // A hot reload re-runs register(). Drop the previous instance's listener,
    // timer, and overlay first, or every reload stacks another alert.
    const previous = window.__loudTurnAlertsCurrent
    try {
      previous?.dispose?.()
    } catch {
      // A dead instance is exactly what we are replacing.
    }

    void (async () => {
      customSoundUrl = (await loadClip('sound')) || ''
      voiceClipUrl = (await loadClip('voice')) || ''
    })()
    loadVoices()
    // Chromium fills getVoices() asynchronously on Windows; the first call is
    // usually empty. Retry so the picker is never blank when it opens.
    setTimeout(loadVoices, 1200)
    setTimeout(loadVoices, 4000)
    window.speechSynthesis?.addEventListener?.('voiceschanged', loadVoices)

    listenForSettingsDoor()
    const disposeEvent = host.onEvent('message.complete', onGatewayEvent)
    window.__loudTurnAlertsCurrent = {
      dispose: () => {
        disposeEvent()
        clearTimeout(overlayTimer)
        clearTimeout(glowTimer)
        document.getElementById(OVERLAY_ID)?.remove()
      }
    }

    ctx.register({
      id: `${ID}:page`,
      area: ROUTES_AREA,
      data: { path: PAGE_PATH },
      render: () => jsx(SettingsPage, {})
    })

    ctx.register({
      id: `${ID}:chip`,
      area: 'statusBar.right',
      order: 130,
      render: () => jsx(AlertChip, {})
    })

    ctx.register({
      id: `${ID}:command`,
      area: PALETTE_AREA,
      data: {
        id: `${ID}:settings`,
        label: 'Turn Alerts: open settings',
        keywords: ['alert', 'notification', 'sound', 'volume', 'loud'],
        run: () => openSettings()
      }
    })
  }
}

