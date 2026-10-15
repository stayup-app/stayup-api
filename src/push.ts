import type { DataStore } from './db/port.js'

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
const EXPO_BATCH = 100

// The body of a notification is localized here, from the language the device
// registered with: the server has no access to the apps' translation files.
const NEW_ITEMS: Record<string, [one: string, many: string]> = {
  en: ['1 new item', '{n} new items'],
  fr: ['1 nouvel élément', '{n} nouveaux éléments'],
  de: ['1 neuer Eintrag', '{n} neue Einträge'],
  es: ['1 elemento nuevo', '{n} elementos nuevos'],
  it: ['1 nuovo elemento', '{n} nuovi elementi'],
  pt: ['1 novo item', '{n} novos itens'],
  ja: ['新着 1 件', '新着 {n} 件'],
  zh: ['1 条新内容', '{n} 条新内容'],
}

export function newItemsMessage(lang: string, count: number): string {
  const [one, many] = NEW_ITEMS[lang] ?? NEW_ITEMS.en
  return count === 1 ? one : many.replace('{n}', String(count))
}

/** A readable name for a source: the title the connector stored, else its host. */
function sourceName(source: { url: string; config: Record<string, unknown> }) {
  const title = source.config.title
  if (typeof title === 'string' && title) return title
  try {
    return new URL(source.url).hostname
  } catch {
    return source.url
  }
}

interface ExpoTicket {
  status: 'ok' | 'error'
  details?: { error?: string }
}

/**
 * Pushes "N new items" to the devices of everyone subscribed to the sources a
 * connector just wrote to, with the user's unread count as the app-icon badge.
 * Best effort: a failure here must never fail the connector's request.
 */
export async function notifyNewItems(
  store: DataStore,
  items: { repositoryId: number; success: boolean }[],
  send: typeof fetch = fetch,
): Promise<void> {
  const counts = new Map<number, number>()
  for (const item of items) {
    if (item.success)
      counts.set(item.repositoryId, (counts.get(item.repositoryId) ?? 0) + 1)
  }
  const targets = await store.listPushTargets([...counts.keys()])
  if (targets.length === 0) return

  const sources = new Map<number, string>()
  for (const id of counts.keys()) {
    const source = await store.getSource(id)
    if (source) sources.set(id, sourceName(source))
  }
  const badges = new Map<string, number>()
  for (const userId of new Set(targets.map((t) => t.user_id))) {
    badges.set(userId, await store.countUnread(userId))
  }

  const messages = targets.map((t) => ({
    to: t.token,
    title: sources.get(t.repository_id) ?? '',
    body: newItemsMessage(t.lang, counts.get(t.repository_id) ?? 0),
    badge: badges.get(t.user_id) ?? 0,
    sound: 'default',
    data: { repositoryId: t.repository_id },
  }))

  const dead: string[] = []
  for (let i = 0; i < messages.length; i += EXPO_BATCH) {
    const batch = messages.slice(i, i + EXPO_BATCH)
    const res = await send(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    })
    if (!res.ok) continue
    const { data } = (await res.json()) as { data?: ExpoTicket[] }
    data?.forEach((ticket, j) => {
      if (
        ticket.status === 'error' &&
        ticket.details?.error === 'DeviceNotRegistered'
      ) {
        dead.push(batch[j].to)
      }
    })
  }
  await store.removePushTokens(dead)
}
