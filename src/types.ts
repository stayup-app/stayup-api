export type Bindings = {
  DATABASE_URL: string
  JWT_SECRET: string
  UI_URL: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  GITHUB_CLIENT_ID: string
  GITHUB_CLIENT_SECRET: string
  /** Shared secret that authorizes `POST /ui/maintenance/cleanup` without an
   *  admin JWT — this is what the cleanup cron (GitHub Actions) sends as
   *  `Authorization: Bearer`. Absent → only an admin can trigger the purge. */
  CLEANUP_SECRET?: string
}
