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

## Friend messages
Friends can message each other from the Friends tab (💬 button next to a friend; the Friends menu item shows an unread count).
- Text only, 500 characters, friends only, same age group only (under 18 with under 18, adults with adults)
- Links, emails, phone numbers and other-app names are blocked; messages are deleted after 30 days
- Files: the 📎 button (or paste / drag and drop) sends a photo, PDF, Word, PowerPoint, Excel or text file, up to 700 KB. Photos are shrunk before sending. Files are stored in the `msgfiles` collection, are read one at a time by their random id (never listed), and are deleted after 30 days with the messages.
- Photos and text files are checked by the AI before they are saved. If it finds nudity, violence, drugs, bullying or personal details (address, phone number, ID, other-app handles), or if the check can't run, the file is not sent. PDFs and Office files can't be scanned. Set `MESSAGE_FILES=images` to allow only photos, or `MESSAGE_FILES=off` to turn files off. File checks count against your AI usage.
- A Report button saves the last 10 messages to the `reports` collection. With the site database you can read reports at `/api/admin/reports` using the header `x-admin-key: <ADMIN_KEY>` (Render generates ADMIN_KEY for you in render.yaml)
- **If you use Firebase** (FIREBASE_CONFIG is set), messages and reports live in Firestore collections `messages` and `reports`, and the server rules above don't apply. Your Firestore security rules must allow those collections (plus `msgfiles` for attachments; in Firebase mode the photo check runs in the browser, so it can be bypassed), and reports are read in the Firebase console.
- Privacy: this app has no verified sign-in, so message privacy is only as strong as your database rules. Do not use messaging with real students until you add authenticated access (for example Firebase Anonymous Auth with rules that only let the sender and receiver read a message).

## Features
Email + password accounts, progress synced to the database, AI tutor / quest rating / photo checks (signed-in only, capped per day), guest mode.

## Navigation
Six tabs: Home, Quests, Calendar, Tutor, Friends, Me. "Me" holds Profile, Achievements, Settings, Get the app and Log out.
The focus timer opens from the ▶ button on any quest (starts a 25-minute session on that quest), the Home card, or the Quests tab.
Keyboard shortcuts (desktop): `n` new quest, `1`-`6` switch tabs.

## Calendar sync (Canvas + Google Calendar)
Calendar tab → "Connect Canvas / Google". Students paste an iCal link:
- Canvas: Calendar → Calendar Feed (assignments become "+ Quest" items and show in Due soon)
- Google Calendar: Settings → your calendar → Integrate calendar → "Secret address in iCal format"
- Any other .ics link works too
The server reads the feed through `GET /api/ical?url=...` (`calendar.js`): https only, public hosts only (private/internal IPs are blocked), 4 MB / 12 s limits, 5-minute cache, 30 requests per minute. Links are kept in the browser (localStorage), not in the database.
Quests go the other way with the 📅 button (opens Google Calendar with the quest filled in) or "Download quests (.ics)".
No Google Cloud project or Canvas developer key is needed.

## Tutor voice
Sage (the owl) can listen and talk. "🎤 Talk" starts a hands-free conversation: speak, Sage answers out loud, then listens again. Tap Sage to interrupt, "Stop talking" to end. 🎤 in the message box is plain voice typing; 🔇/🔊 reads typed replies aloud.
Uses the browser's built-in speech recognition and voices (Chrome, Edge, Safari; not Firefox). Needs https (Render provides it) or localhost.

## Still to do before real launch
- Email verification and parent confirmation emails (parent email is only stored)
- Password reset, privacy policy, terms
- Peer verification and classmate features (need shared tables)
