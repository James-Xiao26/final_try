# Scheduler-only Heroku app (edgeboard-ingest).
#
# The web frontend runs on Vercel — this app exists ONLY to run the ingest
# jobs via Heroku Scheduler, which executes them as one-off dynos:
#   npm run ingest          (daily full ingest)
#   npm run ingest:feed     (every 10 min)
#   npm run ingest:markets  (hourly)
#
# Those one-off commands do NOT need a process declared here. We intentionally
# declare NO `web:` process so Heroku's Node buildpack won't auto-create a
# default `web: npm start` dyno (an always-on dyno that would bill ~$7/mo for
# nothing). Do NOT add a `worker:` running an ingest command either — the
# ingest scripts run once and exit, so a worker dyno would loop forever and
# rack up cost. Leave this file with no process types.
