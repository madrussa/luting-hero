// Putting text on the clipboard, and saying whether it worked.

/**
 * Copy `text`, whatever the browser allows.
 *
 * The `execCommand` fallback is for insecure origins, where there is no async
 * clipboard at all — a build served over plain HTTP on a local network, which is
 * exactly how someone shows this to a friend. Reporting the outcome rather than
 * swallowing it is what lets a button say "copied" only when it did.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const el = document.createElement('textarea')
      el.value = text
      el.style.position = 'fixed'
      el.style.opacity = '0'
      document.body.append(el)
      el.select()
      const ok = document.execCommand('copy')
      el.remove()
      return ok
    } catch {
      return false
    }
  }
}
