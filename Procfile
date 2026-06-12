# Heroku app (edgeboard-ingest).
#
# The web frontend runs on Vercel. This app runs a lightweight webhook server
# that cron-job.org hits every minute to trigger partial ingest refreshes.
# The full ingest still runs via Heroku Scheduler as a one-off dyno:
#   pnpm ingest   (daily full ingest — keep in Heroku Scheduler)
#
# The web dyno stays awake because cron-job.org pings it every minute.
# Protect the endpoints with the CRON_SECRET env var (set via heroku config:set).
web: pnpm --filter edgeboard-scripts server
