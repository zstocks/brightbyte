# brightbyte

Control app for the BrightByte LED signs. Node 22, `node:http`, SQLite, no framework.

- `server.js` starts the server.
- `src/app.js` routes requests; `src/auth.js` handles login; `src/state.js` validates what a sign can show; `src/db.js` stores it.
- `public/` is the dashboard.
- `npm test` runs the tests. `npm run dev` runs locally using `.env` (set `INSECURE_COOKIES=1` there for plain-http local use only).

Configuration is in `.env`; see `.env.example`.
