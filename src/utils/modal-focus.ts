import { onBeforeUnmount, watch, type Ref } from 'vue'

interface Scope { panel: HTMLElement; focus: () => void }
const scopes: Scope[] = []
const isolated = new WeakMap<HTMLElement, { count: number; inert: string | null; hidden: string | null }>()
const selector = 'button, input, select, textarea, a[href], [tabindex]'

function available(element: HTMLElement): boolean {
  if (!element.isConnected || element.matches(':disabled') || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden') return false
  }
  return true
}

/** Hide sibling branches from keyboard/assistive navigation, including nested dialogs. */
function isolate(panel: HTMLElement): () => void {
  const siblings: HTMLElement[] = []
  for (let node: HTMLElement = panel; node.parentElement; node = node.parentElement) {
    for (const sibling of node.parentElement.children) {
      if (!(sibling instanceof HTMLElement) || sibling === node) continue
      const state = isolated.get(sibling) ?? { count: 0, inert: sibling.getAttribute('inert'), hidden: sibling.getAttribute('aria-hidden') }
      state.count += 1; isolated.set(sibling, state); siblings.push(sibling)
      sibling.setAttribute('inert', ''); sibling.setAttribute('aria-hidden', 'true')
    }
    if (node.parentElement === document.body) break
  }
  return () => {
    for (const sibling of siblings) {
      const state = isolated.get(sibling)!
      if (--state.count) continue
      for (const [name, value] of [['inert', state.inert], ['aria-hidden', state.hidden]] as const) {
        if (value === null) sibling.removeAttribute(name)
        else sibling.setAttribute(name, value)
      }
      isolated.delete(sibling)
    }
  }
}

/** Only the top dialog owns Tab/Escape. Preserve focus across busy states and nested prompts. */
export function useModalFocus(open: () => boolean, panel: Ref<HTMLElement | null>, escape: () => void) {
  let release: (() => void) | undefined
  watch(() => open() && panel.value, (element) => {
    release?.(); release = undefined
    if (!element) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const choices = () => Array.from(element.querySelectorAll<HTMLElement>(selector)).filter((candidate) => candidate.tabIndex >= 0 && available(candidate))
    const focus = () => {
      const targets = choices()
      ;(targets.find((candidate) => candidate.hasAttribute('data-dialog-initial-focus')) ?? targets[0] ?? element).focus()
    }
    const scope = { panel: element, focus }
    const top = () => scopes[scopes.length - 1] === scope
    scopes.push(scope)
    const restoreBranches = isolate(element)
    const focusin = (event: FocusEvent) => {
      if (top() && !element.contains(event.target as Node)) focus()
    }
    const keydown = (event: KeyboardEvent) => {
      if (!top() || event.isComposing) return
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation()
        // Holding Escape must not turn a pause into closing/discarding the queue.
        if (!event.repeat) escape()
      }
      if (event.key !== 'Tab') return
      event.preventDefault(); event.stopPropagation()
      const targets = choices(), current = targets.indexOf(document.activeElement as HTMLElement)
      const index = current < 0 ? (event.shiftKey ? targets.length - 1 : 0) : (current + (event.shiftKey ? -1 : 1) + targets.length) % targets.length
      ;(targets[index] ?? element).focus()
    }
    document.addEventListener('focusin', focusin, true)
    document.addEventListener('keydown', keydown, true)
    focus()
    release = () => {
      const wasTop = top()
      const index = scopes.indexOf(scope)
      if (index >= 0) scopes.splice(index, 1)
      document.removeEventListener('focusin', focusin, true)
      document.removeEventListener('keydown', keydown, true)
      restoreBranches()
      if (!wasTop) return
      const parent = scopes[scopes.length - 1]
      if (previous && available(previous) && (!parent || parent.panel.contains(previous))) previous.focus()
      else parent?.focus()
    }
  }, { flush: 'post', immediate: true })
  onBeforeUnmount(() => { release?.(); release = undefined })
}
