# Questlog
Gamified quest tracker for students. Express + Postgres, static front end in `public/`.

## Run locally
1. Install Node 20+ and Postgres, create a database
2. `npm install`
3. Copy `.env.example` to `.env`, fill in your key and DATABASE_URL
4. `npm run dev`, open http://localhost:3000

## Deploy on Render
1. Push this repo to GitHub
2. Render: New > Blueprint, pick the repo (creates the web service and Postgres from `render.yaml`)
3. Set `BACKBOARD_API_KEY` (or `ANTHROPIC_API_KEY`) when prompted, then deploy

**Important:** in `public/index.html` keep `const AI_ENDPOINT = '/api/ai';`. If you paste in a version of the page that has `AI_ENDPOINT = ''`, the AI tutor, quest rating, quizzes and photo checks all stop working.

## How data is shared
Profiles, friend codes, the leaderboard and peer checks are stored in the Postgres `kv` table through `/api/kv/*` and shared across every device. If the database is unreachable the page falls back to saving on that one device only (friend codes will then not work for other people).

## Features
Email + password accounts, progress synced to the database, AI tutor / quest rating / photo checks (signed-in only, capped per day), guest mode.

## Still to do before real launch
- Email verification and parent confirmation emails (parent email is only stored)
- Password reset, privacy policy, terms
- Peer verification and classmate features (need shared tables)
