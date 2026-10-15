/**
 * Deletes the throwaway accounts created by automated tests (every address under
 * `@example.com`). Dry run by default: prints what would go and what is kept.
 *
 *   STAYUP_API_URL=https://… ADMIN_EMAIL=… ADMIN_PASSWORD=… \
 *     npx tsx scripts/purge-test-users.ts [--apply]
 */
const base = (process.env.STAYUP_API_URL ?? '').replace(/\/$/, '')
const email = process.env.ADMIN_EMAIL
const password = process.env.ADMIN_PASSWORD
const apply = process.argv.includes('--apply')

if (!base || !email || !password) {
  console.error('STAYUP_API_URL, ADMIN_EMAIL and ADMIN_PASSWORD are required')
  process.exit(1)
}

const isTestUser = (u: { email: string }) => /@example\.com$/i.test(u.email)

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, init)
  if (!res.ok)
    throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status}`)
  return res.json() as Promise<T>
}

const { token } = await api<{ token: string }>('/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: email, password }),
})
const auth = { Authorization: `Bearer ${token}` }

const { users } = await api<{
  users: { id: string; name: string; email: string }[]
}>('/ui/users', { headers: auth })
const doomed = users.filter(isTestUser)
const kept = users.filter((u) => !isTestUser(u))

console.log(
  `${users.length} users: ${doomed.length} test accounts, ${kept.length} kept`,
)
console.log('Kept:')
for (const u of kept) console.log(`  ${u.email}  (${u.name})`)

if (!apply) {
  console.log('\nDry run. Re-run with --apply to delete the test accounts.')
  process.exit(0)
}

let deleted = 0
for (const u of doomed) {
  await api(`/ui/users/${u.id}`, { method: 'DELETE', headers: auth })
  deleted++
}
console.log(`\nDeleted ${deleted} test accounts.`)
