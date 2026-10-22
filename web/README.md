# web

React + Vite + TypeScript app with driver routes (`/`, `/lots/:lotId`) and the admin console (`/admin/*`).

- API calls go to `/api/...`; the Vite dev server proxies that to the API (`API_PROXY_TARGET`, default `http://localhost:8000`).
- Types in `src/api/types.gen.ts` are generated from `../contract/openapi.json` with `npm run gen:types`. Do not edit them by hand.
- `npm test` runs Vitest (jsdom + Testing Library); `npm run typecheck` and `npm run build` must stay clean.
